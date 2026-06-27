/**
 * Multi-question take-home feedback endpoint (feedback_task, essay).
 *
 * The task carries a `questions` array (lib/feedback-questions.ts); the student
 * submits an `answers` array ([{ question_id, text }]). Each question gets its
 * own AI feedback, with depth scaling to the question's marks (concise Haiku for
 * short answers, full Sonnet three-pass for extended responses) — see
 * lib/multi-question-feedback.ts.
 *
 * Mirrors the single-question (generate-feedback) and maths (generate-maths-
 * feedback) endpoints: one rate-limit charge + one 3-draft cap per submission,
 * per-question skill reads aggregated into ONE recordSkillSignals call, the same
 * post-submission side-effects (profile stale, autosave clear, AGS passback).
 * Questions are independent (no cross-question "Hence" context in v1).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { buildSystemPrompt } from '../prompts/feedback-system.js';
import { generateQuestionFeedback, aggregateSkillAssessments } from '../lib/multi-question-feedback.js';
import { isFeedbackQuestionsTask, type FeedbackQuestion } from '../lib/feedback-questions.js';
import { serializeExamAnswers } from '../lib/exam-transcript.js';
import { readSkillProfile, recordSkillSignals } from '../lib/skill-profile.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { currentYearLevelFromGraduationYear } from '../data/nesa-reference.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';

const MAX_DRAFTS = 3;
const MAX_TOTAL_CHARS = 50000; // summed across all answers — bounds cost

interface SubmittedAnswer { text: string; selected_option_id: string }

/** Map a client `answers` array to { question_id -> {text, selected_option_id} }.
 *  Text questions carry `text`; multiple-choice carry `selected_option_id`. */
function sanitiseAnswers(input: any): Map<string, SubmittedAnswer> {
  const out = new Map<string, SubmittedAnswer>();
  if (!Array.isArray(input)) return out;
  for (const a of input) {
    const qid = a && typeof a.question_id === 'string' ? a.question_id : '';
    if (!qid) continue;
    out.set(qid, {
      text: a && typeof a.text === 'string' ? a.text : '',
      selected_option_id: a && typeof a.selected_option_id === 'string' ? a.selected_option_id : '',
    });
  }
  return out;
}

/** A multiple-choice question is objective — mark it deterministically (no LLM)
 *  and reveal the correct answer in the feedback (formative; the take-home loop
 *  is for learning, "Submit for marking" is the summative gate). */
function markMcQuestion(q: FeedbackQuestion, a: SubmittedAnswer | undefined) {
  const opts = q.options || [];
  const selId = a?.selected_option_id || null;
  const selOpt = selId ? opts.find((o) => o.id === selId) : null;
  const correctOpt = opts.find((o) => o.id === q.correct_option_id) || null;
  return {
    question_id: q.id,
    type: 'multiple_choice' as const,
    marks: q.marks,
    ok: true,
    mc: {
      selected_option_id: selOpt ? selOpt.id : null,
      selected_option_text: selOpt ? selOpt.text : null,
      correct_option_id: q.correct_option_id || null,
      correct_option_text: correctOpt ? correctOpt.text : null,
      correct: !!selOpt && selOpt.id === q.correct_option_id,
    },
    skill_assessment: [] as any[],
  };
}

export default withHandler({ methods: ['POST'], label: 'generate-multi-feedback' }, async (req, res, ctx) => {
  const user = ctx.user!;
  const {
    task_id,
    answers,
    keystroke_count,
    paste_attempts_blocked,
    typing_session_count,
    total_typing_time_ms,
    time_to_first_keystroke_ms,
    student_attachments,
  } = req.body || {};

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: 'Write at least one answer before getting feedback.' });
  }

  // Lock: graded or already-submitted-for-marking blocks further drafts.
  const supabase = getSupabase();
  const { data: locked } = await supabase
    .from('submissions')
    .select('id, graded_at, submitted_for_marking')
    .eq('student_id', user.id)
    .eq('task_id', task_id)
    .or('graded_at.not.is.null,submitted_for_marking.eq.true')
    .maybeSingle();
  if (locked) {
    const reason = locked.graded_at
      ? 'This task has been marked by your teacher. You cannot submit further drafts.'
      : 'You have already submitted this task for marking. AI feedback is disabled until your teacher marks it.';
    return res.status(403).json({ error: reason });
  }

  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'generate-multi-feedback',
    perUserPerHour: 10,
    globalPerDay: 5000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded.' });
  }

  // Load task + verify it's a multi-question take-home assessment + membership.
  const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });
  if (!isFeedbackQuestionsTask(task)) {
    return res.status(400).json({ error: 'This task is not a multi-question take-home assessment.' });
  }
  const { data: membership } = await supabase
    .from('class_members')
    .select('student_id')
    .eq('class_id', task.class_id)
    .eq('student_id', user.id)
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

  // Draft version + 3-draft cap.
  const { data: priorSubs } = await supabase
    .from('submissions')
    .select('draft_version')
    .eq('student_id', user.id)
    .eq('task_id', task_id)
    .order('draft_version', { ascending: true });
  const priorCount = (priorSubs || []).length;
  if (priorCount >= MAX_DRAFTS) {
    return res.status(400).json({ error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.` });
  }
  const draftVersion = priorCount + 1;

  const questions = task.questions as FeedbackQuestion[];
  const qById = new Map(questions.map((q) => [q.id, q]));
  const submitted = sanitiseAnswers(answers);
  // A text question is answered when it has text; an MC question when an option
  // is selected.
  const wasAnswered = (q: FeedbackQuestion): boolean => {
    const a = submitted.get(q.id);
    if (!a) return false;
    return q.type === 'multiple_choice' ? !!a.selected_option_id : !!a.text.trim();
  };
  if (!questions.some((q) => wasAnswered(q))) {
    return res.status(400).json({ error: 'Answer at least one question before getting feedback.' });
  }
  const totalChars = questions.reduce((n, q) => n + (submitted.get(q.id)?.text || '').length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return res.status(400).json({ error: 'Your answers are too long. Please shorten them and try again.' });
  }

  // Shared per-submission context (built once; reused across questions).
  const course = task.course || null;
  const discipline = course ? getDisciplineForCourse(course) : null;
  const gradYear = (user.user_metadata as any)?.graduation_year;
  const yearLevel = typeof gradYear === 'number' ? currentYearLevelFromGraduationYear(gradYear) : null;
  const outcomes = (task.outcomes || []).map((o: any) => (typeof o === 'string' ? o : o.code || ''));
  const holisticSystem = buildSystemPrompt(course || undefined, discipline || undefined, yearLevel || undefined);
  const readiness = await readSkillProfile(supabase, user.id, discipline || 'General');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

    const t0 = Date.now();
    // Collect per-question errors so an all-fail can report WHY (not just 502).
    const qErrors: string[] = [];
    const results = await Promise.all(questions.map((q) => {
      // MC is objective — mark it deterministically, no LLM call.
      if (q.type === 'multiple_choice') {
        return Promise.resolve(markMcQuestion(q, submitted.get(q.id)));
      }
      return generateQuestionFeedback({
        client,
        question: q,
        answerText: submitted.get(q.id)?.text || '',
        course,
        discipline,
        yearLevel,
        outcomes,
        teacherNotes: task.notes || null,
        taskType: task.task_type || null,
        holisticSystem,
        readiness,
        onError: (err, stage) => {
          qErrors.push(`${stage}: ${(err as any)?.message || String(err)}`);
          captureError(err, { stage, task_id, user_id: user.id, question_id: q.id });
        },
      });
    }));
    console.log('[generate-multi-feedback] (', questions.length, 'questions) in', Date.now() - t0, 'ms');

    // If no question that the student actually attempted produced feedback, the
    // whole thing failed — surface a retry without consuming a draft, and log
    // the underlying reason(s) so this isn't an opaque 502.
    const anyRealFeedback = results.some((r) => {
      const q = qById.get(r.question_id);
      return r.ok && !!q && wasAnswered(q);
    });
    if (!anyRealFeedback) {
      console.error('[generate-multi-feedback] all questions failed:', qErrors.join(' | ') || '(no error captured)');
      return res.status(502).json({
        error: 'Could not generate feedback. Please try again — your work was not lost.',
        detail: qErrors[0] || undefined,
      });
    }

    // Per-question student-facing feedback (skill_assessment stripped — system-only).
    const questionFeedback = results.map(({ skill_assessment, ...shown }) => shown);
    const aggregated = aggregateSkillAssessments(results.map((r) => r.skill_assessment || []));

    const feedback = { kind: 'multi_question', questions: questionFeedback };

    // Self-describing per-question answer snapshot (question_text + marks frozen
    // at submit), parallel to the exam `answers` shape so the marking screen and
    // the graded view consume it unchanged.
    const answerRows = questions.map((q) => {
      const a = submitted.get(q.id);
      if (q.type === 'multiple_choice') {
        const selId = a?.selected_option_id || null;
        const selOpt = selId ? (q.options || []).find((o) => o.id === selId) : null;
        return {
          question_id: q.id,
          question_text: q.text,
          marks: q.marks,
          type: 'multiple_choice' as const,
          selected_option_id: selOpt ? selOpt.id : null,
          selected_option_text: selOpt ? selOpt.text : null,
        };
      }
      return {
        question_id: q.id,
        question_text: q.text,
        marks: q.marks,
        type: 'text' as const,
        text: a?.text || '',
      };
    });
    const draftText = serializeExamAnswers(answerRows as any);

    const successPayload = {
      feedback,
      answers: answerRows,
      meta: {
        course,
        title: task.title || null,
        task_id,
        draftVersion,
        maxDrafts: MAX_DRAFTS,
      },
    };

    const { error: insertErr } = await supabase.from('submissions').insert({
      student_id: user.id,
      task_id,
      question: task.question || null,
      course,
      draft_text: draftText,
      answers: answerRows,
      feedback,
      skill_assessment: aggregated.length > 0 ? aggregated : null,
      draft_version: draftVersion,
      keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
      paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
      typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
      total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
      time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
      student_attachments: Array.isArray(student_attachments) ? student_attachments.slice(0, 5) : [],
    });
    // 23505 = a concurrent/duplicate submit already stored this draft_version
    // (double-click). The student still gets their feedback; skip the side-effects
    // the winning request already ran.
    if (insertErr && (insertErr as any).code === '23505') {
      console.warn('[generate-multi-feedback] duplicate draft insert ignored (idempotent)', { task_id, user_id: user.id, draftVersion });
      return res.status(200).json(successPayload);
    }
    if (insertErr) {
      captureError(insertErr, { stage: 'submission-insert-multi', task_id, user_id: user.id });
      return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
    }

    // Post-submission side effects — each swallows its own error, but must finish
    // before responding (Vercel freezes the instance once the response is sent).
    const bgWrites: PromiseLike<unknown>[] = [];

    if (aggregated.length > 0) {
      bgWrites.push(
        recordSkillSignals({
          supabase,
          studentId: user.id,
          discipline: discipline || 'General',
          family: 'writing',
          assessment: aggregated,
        }).catch((err) => captureError(err, { stage: 'skill-rollup-multi', user_id: user.id, task_id }))
      );
    }

    bgWrites.push(
      supabase.from('student_profile_synthesis')
        .update({ stale: true })
        .eq('student_id', user.id)
        .then(({ error }) => { if (error) captureError(error, { stage: 'profile-cache-invalidate', user_id: user.id }); })
    );

    bgWrites.push(
      supabase.from('draft_autosaves')
        .delete()
        .eq('student_id', user.id)
        .eq('task_id', task_id)
        .then(({ error }) => { if (error) captureError(error, { stage: 'autosave-clear', task_id, user_id: user.id }); })
    );

    bgWrites.push(
      postCompletionIfLinked({
        taskId: task_id,
        studentId: user.id,
        comment: `Draft ${draftVersion} submitted via ProofReady`,
      }).catch((err) => captureError(err, { stage: 'ags-passback', task_id, user_id: user.id }))
    );

    await Promise.allSettled(bgWrites);

    return res.status(200).json(successPayload);
  } catch (err: any) {
    captureError(err, { stage: 'top-level-multi', task_id, user_id: user.id });
    return res.status(500).json({ error: 'Failed to generate feedback. Please try again.' });
  }
});
