import { getSupabase } from '../lib/auth.js';
import { captureError } from './../lib/sentry.js';
import { withHandler } from '../lib/with-handler.js';
import { generateInsightsSignals } from '../lib/insights-signals-feedback.js';
import { recordSkillSignals } from '../lib/skill-profile.js';
import { skillDiscipline } from '../data/nesa-courses.js';
import { familyForSubjectType } from '../data/skill-taxonomy.js';
import { processExamAnswers, type ProcessedExam } from '../lib/exam-submission.js';
import { serializeExamAnswers } from '../lib/exam-transcript.js';
import type { ExamQuestion } from '../lib/exam-questions.js';

const MAX_DRAFT_CHARS = 50_000;

export default withHandler({ methods: ['POST'], label: 'submit-for-marking' }, async (req, res, ctx) => {
  const user = ctx.user!;

  const {
    task_id,
    draft,
    working_lines,
    input_mode,
    answers,
    keystroke_count,
    paste_attempts_blocked,
    typing_session_count,
    total_typing_time_ms,
    time_to_first_keystroke_ms,
    student_attachments,
    over_time_cutoff_index,
  } = (req.body || {}) as Record<string, unknown>;

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });

  // Three submission shapes:
  //   - essay draft (text),
  //   - maths working (ordered {math} lines), or
  //   - a multi-question exam (answers[], one per task question).
  // All serialise into draft_text so the rest of the pipeline (silent insights
  // pass, marking screen, CSV) stays shape-agnostic. The exam case is finished
  // after the task (its questions) is loaded below.
  const isMathsSubmission = Array.isArray(working_lines);
  const isExamSubmission = !isMathsSubmission && Array.isArray(answers);
  let draftText = '';
  let mathLines: Array<{ math: string }> | null = null;
  let processedExam: ProcessedExam | null = null;
  if (isMathsSubmission) {
    mathLines = (working_lines as any[])
      .map((l) => ({ math: String(l?.math || '').trim() }))
      .filter((l) => l.math);
    if (mathLines.length === 0) {
      return res.status(400).json({ error: 'Add at least one line of working before submitting.' });
    }
    draftText = mathLines
      .map((l, i) => `Line ${i + 1}: ${l.math}`)
      .join('\n');
  } else if (isExamSubmission) {
    // draftText + per-question marks are built after the task is loaded (we need
    // its questions to snapshot text/marks and auto-mark MC).
  } else {
    if (typeof draft !== 'string') return res.status(400).json({ error: 'draft must be a string.' });
    draftText = draft.trim();
    if (draftText.length < 50) {
      return res.status(400).json({ error: 'Your draft is too short. Write at least a paragraph and try again.' });
    }
  }
  if (!isExamSubmission && draftText.length > MAX_DRAFT_CHARS) {
    return res.status(400).json({ error: 'Your submission is too long.' });
  }

  const supabase = getSupabase();

  // Reject if the task is already locked for this student (graded OR
  // already submitted-for-marking). .limit(1) matters: without it maybeSingle()
  // errors when MORE than one row matches (e.g. two graded drafts), which would
  // silently unlock the task. Any read error fails CLOSED.
  const { data: locked, error: lockErr } = await supabase
    .from('submissions')
    .select('id, graded_at, submitted_for_marking')
    .eq('student_id', user.id)
    .eq('task_id', task_id as string)
    .or('graded_at.not.is.null,submitted_for_marking.eq.true')
    .limit(1)
    .maybeSingle();
  if (lockErr) {
    captureError(lockErr, { stage: 'lock-check-submit', task_id, user_id: user.id });
    return res.status(403).json({ error: 'Could not confirm this task is still open for submission. Please try again in a moment.' });
  }
  if (locked) {
    const reason = locked.graded_at
      ? 'This task has already been marked by your teacher.'
      : 'You have already submitted this task for marking.';
    return res.status(403).json({ error: reason });
  }

  // Read task context for the submission row
  const { data: task } = await supabase
    .from('tasks').select('id, question, questions, course, class_id, task_mode, subject_type, published_at').eq('id', task_id as string).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.published_at) {
    return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });
  }

  // Confirm the student is a member of the class
  const { data: member } = await supabase
    .from('class_members').select('class_id')
    .eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
  if (!member) return res.status(403).json({ error: 'You are not enrolled in this class.' });

  // Shape must match the task's subject: a maths task takes working_lines, an
  // essay task takes a text draft (or exam answers). A mismatched shape would
  // otherwise flow into the silent insights pass and score essay text on maths
  // dimensions (or vice versa).
  const isMathsTask = (task as any).subject_type === 'maths';
  if (isMathsTask && !isMathsSubmission) {
    return res.status(400).json({ error: 'This is a maths task — submit your working lines, not a written draft.' });
  }
  if (!isMathsTask && isMathsSubmission) {
    return res.status(400).json({ error: 'This is a written task — submit a text draft, not maths working lines.' });
  }

  // Multi-question exam: snapshot the task's questions into the stored answers,
  // auto-mark MC, and serialise the transcript into draft_text.
  if (isExamSubmission) {
    const questions = Array.isArray((task as any).questions) ? (task as any).questions as ExamQuestion[] : null;
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: 'This task does not accept multi-question answers.' });
    }
    processedExam = processExamAnswers(questions, answers);
    if (!processedExam.hasContent) {
      return res.status(400).json({ error: 'Write at least one answer before submitting.' });
    }
    draftText = serializeExamAnswers(processedExam.answers);
    if (draftText.length > MAX_DRAFT_CHARS) {
      return res.status(400).json({ error: 'Your submission is too long.' });
    }
  }

  // Determine the next draft version (continues the existing per-task sequence)
  const { data: existingDrafts } = await supabase
    .from('submissions').select('draft_version')
    .eq('student_id', user.id).eq('task_id', task_id as string)
    .order('draft_version', { ascending: false }).limit(1);
  const nextVersion = (existingDrafts && existingDrafts[0]?.draft_version ? existingDrafts[0].draft_version : 0) + 1;

  // Silent insights pass — only for marked_task and quick_task. The student
  // never sees this output; it exists to feed cohort cards + student profile.
  // For feedback_task, prior draft rows already carry rich feedback, so this
  // locked row stays feedback:null (existing behaviour).
  let insightsFeedback: any = null;
  let skillAssessment: any[] | null = null;
  const taskMode = (task as any).task_mode as string | undefined;
  // Skill family follows the task's subject so a maths submission is scored on
  // the maths dimensions (M1–M6), not writing.
  const family = familyForSubjectType((task as any).subject_type);
  const wantsSilentInsights = taskMode === 'marked_task' || taskMode === 'quick_task';
  if (wantsSilentInsights) {
    try {
      // Exam submissions have no single question — give Haiku a header plus, when
      // there are MC questions, an unstored tally line so the skill read accounts
      // for objective performance while weighting toward the written answers.
      const haikuQuestion = isExamSubmission
        ? `In-class exam (${processedExam!.answers.length} questions)`
        : ((task as any).question || '');
      const haikuDraft = (isExamSubmission && processedExam && processedExam.mcTotal > 0)
        ? `[Multiple choice: ${processedExam.mcCorrect}/${processedExam.mcTotal} correct — weight the skill read toward the written answers below.]\n\n${draftText}`
        : draftText;
      const signals = await generateInsightsSignals({
        course: (task as any).course || null,
        question: haikuQuestion,
        draft: haikuDraft,
        family,
      });
      // Pull the skill read out — it's captured for the skill database, kept
      // out of the feedback blob.
      if (signals && Array.isArray(signals.skill_assessment)) {
        skillAssessment = signals.skill_assessment;
        const { skill_assessment, ...rest } = signals;
        insightsFeedback = rest;
      } else {
        insightsFeedback = signals;
      }
    } catch (err) {
      // Don't fail the submission — the student's work is the product, the
      // AI signal is the side-effect. Log it; teacher can still mark.
      captureError(err, { stage: 'submit-for-marking-haiku', task_id, user_id: user.id, task_mode: taskMode });
      insightsFeedback = null;
    }
  }

  const { data: insertedSub, error: insertErr } = await supabase.from('submissions').insert({
    student_id: user.id,
    task_id: task_id as string,
    // Exam submissions are self-describing via `answers`; the scalar question is null.
    question: isExamSubmission ? null : task.question,
    course: task.course,
    draft_text: draftText,
    feedback: insightsFeedback,
    skill_assessment: skillAssessment,
    draft_version: nextVersion,
    submitted_for_marking: true,
    keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
    paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
    typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
    total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
    time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
    student_attachments: Array.isArray(student_attachments) ? student_attachments.slice(0, 5) : [],
    // Exam over-time cutoffs live per-answer (inside `answers`); the submission-
    // level column stays null for exams.
    over_time_cutoff_index: (!isExamSubmission && typeof over_time_cutoff_index === 'number' && Number.isInteger(over_time_cutoff_index) && over_time_cutoff_index >= 0)
      ? over_time_cutoff_index : null,
    ...(isMathsSubmission ? {
      working_lines: mathLines,
      input_mode: (input_mode === 'freeform' || input_mode === 'talkthrough') ? input_mode : 'structured',
    } : {}),
    ...(isExamSubmission ? {
      answers: processedExam!.answers,
      question_marks: processedExam!.questionMarks,
    } : {}),
  }).select('id').single();
  // 23505 = a concurrent/duplicate submit already created this row (double-
  // click on Submit). The lock check above catches the sequential case; the
  // unique index catches the race. Report it cleanly rather than 500.
  if (insertErr && (insertErr as any).code === '23505') {
    return res.status(409).json({ error: 'You have already submitted this task for marking.' });
  }
  if (insertErr) {
    captureError(insertErr, { stage: 'submit-for-marking-insert', task_id, user_id: user.id });
    return res.status(500).json({ error: 'Could not save your submission.' });
  }

  // Post-submission side effects. Each swallows its own error so it can't affect
  // the submission, but they must finish before we respond: on Vercel the
  // instance freezes once the response is sent, tearing down any in-flight socket
  // (surfaces as `write ETIMEDOUT` / `fetch failed`). Collect and await in
  // parallel rather than firing and forgetting.
  const bgWrites: PromiseLike<unknown>[] = [];

  // Fold the skill read into the student's rollup (the skill database). Quick/
  // marked tasks are the bulk of submissions, so this is the main inflow.
  if (Array.isArray(skillAssessment) && skillAssessment.length > 0) {
    bgWrites.push(
      recordSkillSignals({
        supabase,
        studentId: user.id,
        // Maths signals roll up under 'Mathematics' (matching the maths feedback
        // path) so the profile isn't split across two discipline keys.
        discipline: skillDiscipline(task.course),
        family,
        assessment: skillAssessment,
        submissionId: insertedSub?.id,
        taskId: task_id as string,
        // This is the silent Haiku pass — discounted in the rollup vs Sonnet.
        source: 'haiku',
      }).catch(err => captureError(err, { stage: 'skill-rollup-submit', user_id: user.id, task_id }))
    );
  }

  // Clear the in-progress autosave
  bgWrites.push(
    supabase
      .from('draft_autosaves').delete()
      .eq('student_id', user.id).eq('task_id', task_id as string)
      .then(({ error }) => {
        if (error) captureError(error, { stage: 'autosave-clear-submit', task_id, user_id: user.id });
      })
  );

  // Fresh insights data → mark the longitudinal profile stale (kept, not
  // deleted). Matches the pattern in submission-grade.ts / generate-feedback.ts.
  if (insightsFeedback) {
    bgWrites.push(
      supabase.from('student_profile_synthesis')
        .update({ stale: true })
        .eq('student_id', user.id)
        .then(({ error }) => {
          if (error) captureError(error, { stage: 'profile-cache-invalidate-submit', task_id, user_id: user.id });
        })
    );
  }

  await Promise.allSettled(bgWrites);

  return res.status(200).json({ ok: true, draft_version: nextVersion });
});
