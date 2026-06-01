/**
 * Maths feedback endpoint — typed-input v0.
 *
 * Branches off generate-feedback.ts for the maths path. Inputs are the
 * student's structured working: an ordered array of { math, reason } lines.
 *
 * Two passes (in parallel, like the essay flow):
 *   Pass B — per-line diagnostic (Sonnet, load-bearing). Returns typed chips
 *            per line + step_gaps between lines.
 *   Pass C — holistic marker comment (Sonnet). Returns what_youve_done_well,
 *            top_priority, improvements.
 *
 * Pass C consumes Pass B's diagnostic as input, so they run sequentially:
 * Pass B first, then Pass C with Pass B's output in context. This costs us
 * ~max(B) + max(C) wall-clock instead of max(B, C), but the holistic comment
 * is materially better when it can reference the per-line findings.
 *
 * NOT in v0: Pass A (freeform/talkthrough structuring), maths-specific
 * inline annotations (we use per-line chips instead), LTI passback (will
 * follow the same lib/lti/ags.ts pattern when added).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import {
  MATHS_PER_LINE_DIAGNOSTIC_TOOL,
  MATHS_HOLISTIC_TOOL,
} from '../lib/feedback-tools.js';
import {
  buildMathsPerLineDiagnosticSystem,
  buildMathsHolisticSystem,
  buildMathsPerLineUserPrompt,
  buildMathsHolisticUserPrompt,
} from '../prompts/maths-system.js';
import { currentYearLevelFromGraduationYear } from '../data/nesa-reference.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';
import { recordSkillSignals } from '../lib/skill-profile.js';

const MAX_DRAFTS = 3;

type WorkingLine = { math: string; reason: string };

function sanitiseLines(input: any): WorkingLine[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw): WorkingLine | null => {
      if (!raw || typeof raw !== 'object') return null;
      const math = typeof raw.math === 'string' ? raw.math.trim() : '';
      const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
      if (!math && !reason) return null;
      return { math, reason };
    })
    .filter((l): l is WorkingLine => l !== null);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const {
    task_id,
    working_lines,
    input_mode,
    keystroke_count,
    paste_attempts_blocked,
    typing_session_count,
    total_typing_time_ms,
    time_to_first_keystroke_ms,
  } = req.body || {};

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });

  const lines = sanitiseLines(working_lines);
  if (lines.length === 0) {
    return res.status(400).json({ error: 'Add at least one line of working before submitting.' });
  }
  if (lines.length > 60) {
    return res.status(400).json({ error: 'That\'s a lot of lines — please trim to under 60.' });
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
    endpoint: 'generate-maths-feedback',
    perUserPerHour: 10,
    globalPerDay: 5000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded.' });
  }

  // Load task + verify membership.
  const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });
  if (task.subject_type !== 'maths') {
    return res.status(400).json({ error: 'This task is not a maths task. Use the essay feedback endpoint instead.' });
  }
  const { data: membership } = await supabase
    .from('class_members')
    .select('student_id')
    .eq('class_id', task.class_id)
    .eq('student_id', user.id)
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

  // Draft version + prior-draft check.
  const { data: priorSubs } = await supabase
    .from('submissions')
    .select('draft_version, working_lines, feedback')
    .eq('student_id', user.id)
    .eq('task_id', task_id)
    .order('draft_version', { ascending: true });
  const priorCount = (priorSubs || []).length;
  if (priorCount >= MAX_DRAFTS) {
    return res.status(400).json({ error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.` });
  }
  const draftVersion = priorCount + 1;

  // Lesson Builder (maths): a no-guideline maths task may carry a re-skinned
  // question per student — evaluate against the version they actually answered.
  let question = String(task.question || '').trim();
  if (task.lesson_builder) {
    const { data: act } = await supabase
      .from('task_activities').select('activity')
      .eq('task_id', task_id).eq('student_id', user.id).maybeSingle();
    const vq = act && act.activity && typeof act.activity.question === 'string' ? act.activity.question.trim() : '';
    if (vq) question = vq;
  }
  const markingGuideline = typeof task.marking_guideline === 'string' ? task.marking_guideline : null;
  const courseName = task.course || undefined;
  const teacherNotes = task.notes || null;
  // Year level drives stage-appropriate voice + category filter in the
  // prompts. Stage 4 = Y7/8, Stage 5 = Y9/10, Stage 6 = Y11/12. Defaults to
  // Stage 6 when graduation_year is missing (consistent with the essay flow).
  const graduationYear = (user.user_metadata as any)?.graduation_year;
  const yearLevel = typeof graduationYear === 'number'
    ? currentYearLevelFromGraduationYear(graduationYear)
    : null;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Pass B — per-line diagnostic. Load-bearing.
    const tB0 = Date.now();
    const passB = await callTool<{
      line_annotations: any[];
      step_gaps: any[];
    }>({
      client,
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0.2,
      system: buildMathsPerLineDiagnosticSystem(courseName, yearLevel),
      user: buildMathsPerLineUserPrompt({
        question,
        markingGuideline,
        workingLines: lines,
        teacherNotes,
      }),
      tool: MATHS_PER_LINE_DIAGNOSTIC_TOOL,
      cacheSystem: true,
      label: 'maths:perline',
    });
    console.log('[generate-maths-feedback] Pass B in', Date.now() - tB0, 'ms');

    // Pass C — holistic. Consumes Pass B output.
    const tC0 = Date.now();
    const passCSettled = await Promise.allSettled([
      callTool<{
        what_youve_done_well: string[];
        top_priority: string;
        improvements: string[];
        skill_assessment?: any[];
      }>({
        client,
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        temperature: 0.3,
        system: buildMathsHolisticSystem(courseName, yearLevel),
        user: buildMathsHolisticUserPrompt({
          question,
          workingLines: lines,
          perLineDiagnostic: passB.value,
        }),
        tool: MATHS_HOLISTIC_TOOL,
        cacheSystem: true,
        label: 'maths:holistic',
      }),
    ]);
    console.log('[generate-maths-feedback] Pass C in', Date.now() - tC0, 'ms');

    let holistic: any = null;
    if (passCSettled[0].status === 'fulfilled') {
      holistic = passCSettled[0].value.value;
    } else {
      console.warn('[generate-maths-feedback] Pass C rejected:', passCSettled[0].reason?.message);
      captureError(passCSettled[0].reason, { stage: 'pass-c-maths', task_id, user_id: user.id });
    }

    // Assemble the maths feedback object. Shape is distinct from the essay
    // feedback shape, so the renderer (feedback-maths.html) branches on the
    // presence of these fields rather than the essay ones.
    const feedback = {
      kind: 'maths',
      line_annotations: passB.value.line_annotations || [],
      step_gaps: passB.value.step_gaps || [],
      what_youve_done_well: holistic?.what_youve_done_well || [],
      top_priority: holistic?.top_priority || '',
      improvements: holistic?.improvements || [],
    };

    const insertPayload: any = {
      student_id: user.id,
      task_id,
      question,
      course: task.course || null,
      // draft_text intentionally a flattened representation of the working —
      // gives existing markbook + insights queries something readable without
      // teaching them about working_lines. The structured truth is in
      // working_lines.
      draft_text: lines
        .map((l, i) => `Line ${i + 1}: ${l.math}\n  Reason: ${l.reason || '(blank)'}`)
        .join('\n'),
      working_lines: lines,
      input_mode: input_mode === 'freeform' || input_mode === 'talkthrough' ? input_mode : 'structured',
      feedback,
      skill_assessment: Array.isArray(holistic?.skill_assessment) ? holistic.skill_assessment : null,
      draft_version: draftVersion,
      keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
      paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
      typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
      total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
      time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
    };

    const { error: insertErr } = await supabase.from('submissions').insert(insertPayload);
    if (insertErr) {
      captureError(insertErr, { stage: 'submission-insert-maths', task_id, user_id: user.id });
      return res.status(500).json({ error: 'Could not save your submission. ' + insertErr.message });
    }

    // Fold the skill read into the student's rollup (the skill database).
    // Fire-and-forget — must never affect the feedback just produced.
    if (Array.isArray(holistic?.skill_assessment) && holistic.skill_assessment.length > 0) {
      recordSkillSignals({
        supabase,
        studentId: user.id,
        discipline: (task.course ? getDisciplineForCourse(task.course) : null) || 'Mathematics',
        family: 'maths',
        assessment: holistic.skill_assessment,
      }).catch(err => captureError(err, { stage: 'skill-rollup-maths', user_id: user.id, task_id }));
    }

    // Mark longitudinal profile stale (kept, not deleted).
    supabase.from('student_profile_synthesis')
      .update({ stale: true })
      .eq('student_id', user.id)
      .then(({ error }) => {
        if (error) captureError(error, { stage: 'profile-cache-invalidate-maths', user_id: user.id });
      });

    // Clear autosave row.
    supabase.from('draft_autosaves')
      .delete()
      .eq('student_id', user.id)
      .eq('task_id', task_id)
      .then(({ error }) => {
        if (error) captureError(error, { stage: 'autosave-clear-maths', task_id, user_id: user.id });
      });

    // LTI AGS passback (no-op if task isn't LTI-linked).
    postCompletionIfLinked({
      taskId: task_id,
      studentId: user.id,
      comment: `Maths draft ${draftVersion} submitted via ProofReady`,
    }).catch(err => captureError(err, { stage: 'ags-passback-maths', task_id, user_id: user.id }));

    return res.status(200).json({
      feedback,
      working_lines: lines,
      meta: {
        question,
        course: task.course || null,
        title: task.title || null,
        task_id,
        draftVersion,
        maxDrafts: MAX_DRAFTS,
      },
    });
  } catch (err: any) {
    captureError(err, { stage: 'top-level-maths', task_id, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate maths feedback.' });
  }
}
