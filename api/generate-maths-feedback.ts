/**
 * Maths feedback endpoint — typed-input.
 *
 * Inputs are the student's structured working: an ordered array of { math }
 * lines. Two shapes:
 *   - single-question: `working_lines` (the task has no `parts`)
 *   - multi-part:      `part_working` (the task carries `tasks.parts`) — see
 *                      docs/maths-overhaul-plan.md §#2.
 *
 * Per question (or per part), two Sonnet passes:
 *   Pass B — per-line diagnostic (load-bearing). Typed chips per line + step_gaps.
 *   Pass C — holistic marker comment (best-effort). done-well / top-priority /
 *            improvements + a skill_assessment.
 * Pass C consumes Pass B. For multi-part, every part runs B→C; parts run in
 * parallel, each seeing the earlier parts (text + the student's working + their
 * worked solution) as "Hence" context.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import {
  MATHS_PER_LINE_DIAGNOSTIC_TOOL,
  MATHS_HOLISTIC_TOOL,
  MATHS_CHECK_EQUIVALENCE_TOOL,
} from '../lib/feedback-tools.js';
import { checkEquivalence } from '../lib/maths-verify.js';
import {
  buildMathsPerLineDiagnosticSystem,
  buildMathsHolisticSystem,
  buildMathsPerLineUserPrompt,
  buildMathsHolisticUserPrompt,
} from '../prompts/maths-system.js';
import { studentPartsView, type MathsPart } from '../lib/maths-parts.js';
import { currentYearLevelFromGraduationYear } from '../data/nesa-reference.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';
import { recordSkillSignals } from '../lib/skill-profile.js';
import { aggregateSkillAssessments } from '../lib/multi-question-feedback.js';

const MAX_DRAFTS = 3;
const MAX_LINES_SINGLE = 60;
const MAX_LINES_MULTIPART = 120; // summed across all parts

type WorkingLine = { math: string };
type PartWorking = { part_id: string; working_lines: WorkingLine[]; input_mode: string };

function sanitiseLines(input: any): WorkingLine[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw): WorkingLine | null => {
      if (!raw || typeof raw !== 'object') return null;
      const math = typeof raw.math === 'string' ? raw.math.trim() : '';
      if (!math) return null;
      return { math };
    })
    .filter((l): l is WorkingLine => l !== null);
}

function sanitisePartWorking(input: any): PartWorking[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((pw: any): PartWorking => ({
      part_id: typeof pw?.part_id === 'string' ? pw.part_id : '',
      working_lines: sanitiseLines(pw?.working_lines),
      input_mode: (pw?.input_mode === 'freeform' || pw?.input_mode === 'talkthrough') ? pw.input_mode : 'structured',
    }))
    .filter((pw) => pw.part_id);
}

function composePartQuestion(stem: string, part: { label: string; text: string }): string {
  const head = stem ? stem.trim() + '\n\n' : '';
  return `${head}${part.label} ${part.text}`.trim();
}

// Pass B as a bounded tool-use loop. The model may call check_equivalence (the
// deterministic algebra check in lib/maths-verify.ts) any number of times before
// it emits the per-line diagnostic; the final turn forces the diagnostic. Throws
// if no usable diagnostic is produced (load-bearing → top-level catch → 500, the
// student's draft isn't consumed).
async function runPassBWithVerifier(args: {
  client: Anthropic;
  systemB: string;
  user: string;
}): Promise<{ line_annotations: any[]; step_gaps: any[] }> {
  const { client, systemB, user } = args;
  const MAX_ITERS = 6;
  const tools = [MATHS_CHECK_EQUIVALENCE_TOOL, MATHS_PER_LINE_DIAGNOSTIC_TOOL];
  const messages: any[] = [{ role: 'user', content: user }];
  let checksRun = 0;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const lastIter = iter === MAX_ITERS - 1;
    const resp = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: [{ type: 'text', text: systemB, cache_control: { type: 'ephemeral' } }] as any,
      tools: tools as any,
      tool_choice: (lastIter ? { type: 'tool', name: MATHS_PER_LINE_DIAGNOSTIC_TOOL.name } : { type: 'auto' }) as any,
      messages,
    }, { maxRetries: 2 });

    const blocks: any[] = (resp.content as any[]) || [];
    const diagnostic = blocks.find(b => b.type === 'tool_use' && b.name === MATHS_PER_LINE_DIAGNOSTIC_TOOL.name);
    if (diagnostic) {
      const val: any = diagnostic.input || {};
      if (!Array.isArray(val.line_annotations) || val.line_annotations.length === 0) {
        throw new Error('Pass B returned no line_annotations (possible truncation).');
      }
      console.log('[maths:perline] diagnostic after', iter + 1, 'turn(s),', checksRun, 'equivalence check(s)');
      return { line_annotations: val.line_annotations, step_gaps: Array.isArray(val.step_gaps) ? val.step_gaps : [] };
    }

    const checks = blocks.filter(b => b.type === 'tool_use' && b.name === MATHS_CHECK_EQUIVALENCE_TOOL.name);
    messages.push({ role: 'assistant', content: resp.content });
    if (checks.length === 0) {
      messages.push({ role: 'user', content: 'Use the provide_maths_diagnostic tool to return the per-line diagnostic now.' });
      continue;
    }
    const results = checks.map((c: any) => {
      checksRun += 1;
      const a = c.input && typeof c.input.expr_a === 'string' ? c.input.expr_a : '';
      const b = c.input && typeof c.input.expr_b === 'string' ? c.input.expr_b : '';
      const r = checkEquivalence(a, b);
      return { type: 'tool_result', tool_use_id: c.id, content: 'verdict: ' + r.verdict + (r.detail ? ' — ' + r.detail : '') };
    });
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Pass B verifier loop exhausted without a diagnostic.');
}

export default withHandler({ methods: ['POST'], label: 'generate-maths-feedback' }, async (req, res, ctx) => {
  const user = ctx.user!;

  const {
    task_id,
    working_lines,
    part_working,
    input_mode,
    keystroke_count,
    paste_attempts_blocked,
    typing_session_count,
    total_typing_time_ms,
    time_to_first_keystroke_ms,
    student_attachments,
  } = req.body || {};

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });

  // Lightweight presence check before we spend a rate-limit token. Precise
  // per-shape validation happens after the task is loaded (we don't yet know
  // whether this is a single-question or multi-part task).
  const hasSingleWorking = Array.isArray(working_lines) && working_lines.length > 0;
  const hasPartWorking = Array.isArray(part_working) && part_working.length > 0;
  if (!hasSingleWorking && !hasPartWorking) {
    return res.status(400).json({ error: 'Add some working before submitting.' });
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
    .select('draft_version')
    .eq('student_id', user.id)
    .eq('task_id', task_id)
    .order('draft_version', { ascending: true });
  const priorCount = (priorSubs || []).length;
  if (priorCount >= MAX_DRAFTS) {
    return res.status(400).json({ error: `You've reached the maximum of ${MAX_DRAFTS} drafts for this task.` });
  }
  const draftVersion = priorCount + 1;

  const stem = String(task.question || '').trim();
  const courseName = task.course || undefined;
  const teacherNotes = task.notes || null;
  // Year level drives stage-appropriate voice + category filter in the prompts.
  // Stage 4 = Y7/8, Stage 5 = Y9/10, Stage 6 = Y11/12. Defaults to Stage 6 when
  // graduation_year is missing (consistent with the essay flow).
  const graduationYear = (user.user_metadata as any)?.graduation_year;
  const yearLevel = typeof graduationYear === 'number'
    ? currentYearLevelFromGraduationYear(graduationYear)
    : null;

  const authoredParts: MathsPart[] = Array.isArray(task.parts) ? task.parts : [];
  const isMultipart = authoredParts.length > 0;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    // Built once and shared across every part (cacheSystem caches the prefix).
    const systemB = buildMathsPerLineDiagnosticSystem(courseName, yearLevel);
    const systemC = buildMathsHolisticSystem(courseName, yearLevel);

    // Diagnose one question (or part): Pass B (load-bearing — throws on truncation)
    // then Pass C (best-effort — a failure leaves holistic null, the line chips
    // still ship). Closure over client/systems/teacherNotes/task_id/user.
    async function diagnoseQuestion(qArgs: {
      question: string;
      markingGuideline: string | null;
      workedSolution: string | null;
      workingLines: WorkingLine[];
      priorParts?: Array<{ label: string; text: string; workingLines: WorkingLine[]; workedSolution: string | null }>;
    }): Promise<{ line_annotations: any[]; step_gaps: any[]; holistic: any | null }> {
      // Pass B runs as a tool-use loop: the model can call check_equivalence
      // (deterministic, lib/maths-verify.ts) to verify algebra before judging a
      // line, then emits the diagnostic.
      const passB = await runPassBWithVerifier({
        client, systemB,
        user: buildMathsPerLineUserPrompt({
          question: qArgs.question,
          markingGuideline: qArgs.markingGuideline,
          workedSolution: qArgs.workedSolution,
          workingLines: qArgs.workingLines,
          teacherNotes,
          priorParts: qArgs.priorParts,
        }),
      });
      let holistic: any = null;
      try {
        const passC = await callTool<{
          what_youve_done_well: string[]; top_priority: string; improvements: string[]; skill_assessment?: any[];
        }>({
          client, model: 'claude-sonnet-5', max_tokens: 2200,
          system: systemC,
          user: buildMathsHolisticUserPrompt({ question: qArgs.question, workingLines: qArgs.workingLines, perLineDiagnostic: passB }),
          tool: MATHS_HOLISTIC_TOOL, cacheSystem: true, label: 'maths:holistic',
          requiredKeys: ['what_youve_done_well', 'top_priority', 'improvements'],
        });
        holistic = passC.value;
      } catch (err: any) {
        captureError(err, { stage: 'pass-c-maths', task_id, user_id: user.id });
      }
      return {
        line_annotations: passB.line_annotations || [],
        step_gaps: passB.step_gaps || [],
        holistic,
      };
    }

    let feedback: any;
    let skillAssessment: any[] | null = null;
    let storedQuestion = stem;
    let storedWorkingLines: WorkingLine[] | null = null;
    let storedPartWorking: PartWorking[] | null = null;
    let storedInputMode = 'structured';
    let draftText = '';
    let successWorking: any = {};

    if (isMultipart) {
      // ---- Multi-part path ----
      const pw = sanitisePartWorking(part_working);
      const pwMap = new Map(pw.map((x) => [x.part_id, x]));
      const totalLines = pw.reduce((n, x) => n + x.working_lines.length, 0);
      if (totalLines === 0) {
        return res.status(400).json({ error: 'Add some working before submitting.' });
      }
      if (totalLines > MAX_LINES_MULTIPART) {
        return res.status(400).json({ error: 'That\'s a lot of working — please trim it down.' });
      }
      // Guard against a stale client whose submitted part ids don't match the
      // task's authored parts (e.g. the teacher edited parts, or a malformed
      // payload). Without this, every part takes the blank branch below: no LLM
      // calls, all-empty feedback — yet the submission still inserts, consuming
      // one of the student's 3 drafts. Require at least one authored part to
      // actually carry submitted working.
      const authoredIds = new Set(authoredParts.map((p) => p.id));
      const hasMatchedWorking = pw.some((x) => authoredIds.has(x.part_id) && x.working_lines.length > 0);
      if (!hasMatchedWorking) {
        return res.status(400).json({ error: 'This task was updated — please reload the page and re-enter your working.' });
      }

      const tM0 = Date.now();
      const partResults = await Promise.all(authoredParts.map(async (part, idx) => {
        const myWorking = pwMap.get(part.id)?.working_lines || [];
        const base = {
          part_id: part.id,
          label: part.label,
          line_annotations: [] as any[],
          step_gaps: [] as any[],
          what_youve_done_well: [] as string[],
          top_priority: '',
          improvements: [] as string[],
          skill_assessment: [] as any[],
        };
        // A part the student left blank gets an empty entry — no LLM call.
        if (myWorking.length === 0) return base;
        const priorParts = authoredParts.slice(0, idx).map((pp) => ({
          label: pp.label,
          text: pp.text,
          workingLines: pwMap.get(pp.id)?.working_lines || [],
          workedSolution: typeof pp.worked_solution === 'string' ? pp.worked_solution : null,
        }));
        const d = await diagnoseQuestion({
          question: composePartQuestion(stem, part),
          markingGuideline: typeof part.marking_guideline === 'string' ? part.marking_guideline : null,
          workedSolution: typeof part.worked_solution === 'string' ? part.worked_solution : null,
          workingLines: myWorking,
          priorParts,
        });
        return {
          ...base,
          line_annotations: d.line_annotations,
          step_gaps: d.step_gaps,
          what_youve_done_well: d.holistic?.what_youve_done_well || [],
          top_priority: d.holistic?.top_priority || '',
          improvements: d.holistic?.improvements || [],
          skill_assessment: Array.isArray(d.holistic?.skill_assessment) ? d.holistic.skill_assessment : [],
        };
      }));
      console.log('[generate-maths-feedback] multi-part (', authoredParts.length, 'parts) in', Date.now() - tM0, 'ms');

      // feedback.parts drops skill_assessment (system-only, never shown).
      feedback = {
        kind: 'maths_multipart',
        parts: partResults.map(({ skill_assessment, ...shown }) => shown),
      };
      // Collapse duplicate dimensions across parts into one signal each. A raw
      // flatMap produces multiple rows for the same dimension (e.g. M2 on parts
      // (a) and (b)), which then trips the (student, dimension) upsert cardinality
      // error in recordSkillSignals and silently drops the WHOLE submission's
      // skill rollup. aggregateSkillAssessments is the same collapse the essay
      // multi-question path uses.
      const merged = aggregateSkillAssessments(partResults.map((p) => p.skill_assessment || []));
      skillAssessment = merged.length > 0 ? merged : null;

      storedWorkingLines = null;
      storedPartWorking = authoredParts.map((part) => ({
        part_id: part.id,
        working_lines: pwMap.get(part.id)?.working_lines || [],
        input_mode: pwMap.get(part.id)?.input_mode || 'structured',
      }));
      storedQuestion = stem;
      draftText = authoredParts.map((part) => {
        const w = (pwMap.get(part.id)?.working_lines || []).map((l, i) => `Line ${i + 1}: ${l.math}`).join('\n');
        return `${part.label}\n${w || '(no working)'}`;
      }).join('\n\n');
      // Student-safe parts (this submission isn't graded yet) so the feedback
      // page can render the part text — never the worked solution.
      successWorking = { part_working: storedPartWorking, parts: studentPartsView(authoredParts, { isGraded: false }) };
    } else {
      // ---- Single-question path ----
      let question = stem;
      let questionWasReskinned = false;
      // Lesson Builder (maths): a no-guideline maths task may carry a re-skinned
      // question per student — evaluate against the version they actually answered.
      if (task.lesson_builder) {
        const { data: act } = await supabase
          .from('task_activities').select('activity')
          .eq('task_id', task_id).eq('student_id', user.id).maybeSingle();
        const vq = act && act.activity && typeof act.activity.question === 'string' ? act.activity.question.trim() : '';
        if (vq) { question = vq; questionWasReskinned = true; }
      }
      const markingGuideline = typeof task.marking_guideline === 'string' ? task.marking_guideline : null;
      // The worked solution is written for the BASE question; drop it if the
      // question was re-skinned for this student (it would mislead the diagnostic).
      const workedSolution = (!questionWasReskinned && typeof task.worked_solution === 'string' && task.worked_solution.trim())
        ? task.worked_solution
        : null;

      const lines = sanitiseLines(working_lines);
      if (lines.length === 0) {
        return res.status(400).json({ error: 'Add at least one line of working before submitting.' });
      }
      if (lines.length > MAX_LINES_SINGLE) {
        return res.status(400).json({ error: 'That\'s a lot of lines — please trim to under 60.' });
      }

      const d = await diagnoseQuestion({ question, markingGuideline, workedSolution, workingLines: lines });
      feedback = {
        kind: 'maths',
        line_annotations: d.line_annotations,
        step_gaps: d.step_gaps,
        what_youve_done_well: d.holistic?.what_youve_done_well || [],
        top_priority: d.holistic?.top_priority || '',
        improvements: d.holistic?.improvements || [],
      };
      skillAssessment = Array.isArray(d.holistic?.skill_assessment) ? d.holistic.skill_assessment : null;

      storedQuestion = question;
      storedWorkingLines = lines;
      storedPartWorking = null;
      storedInputMode = (input_mode === 'freeform' || input_mode === 'talkthrough' || input_mode === 'photo') ? input_mode : 'structured';
      draftText = lines.map((l, i) => `Line ${i + 1}: ${l.math}`).join('\n');
      successWorking = { working_lines: lines };
    }

    const insertPayload: any = {
      student_id: user.id,
      task_id,
      question: storedQuestion,
      course: task.course || null,
      // draft_text is a flattened representation for markbook/insights; the
      // structured truth is in working_lines / part_working.
      draft_text: draftText,
      working_lines: storedWorkingLines,
      part_working: storedPartWorking,
      input_mode: storedInputMode,
      feedback,
      skill_assessment: skillAssessment,
      draft_version: draftVersion,
      keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
      paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
      typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
      total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
      time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
      student_attachments: Array.isArray(student_attachments) ? student_attachments.slice(0, 5) : [],
    };

    const successPayload = {
      feedback,
      ...successWorking,
      meta: {
        question: storedQuestion,
        course: task.course || null,
        title: task.title || null,
        task_id,
        draftVersion,
        maxDrafts: MAX_DRAFTS,
      },
    };

    const { error: insertErr } = await supabase.from('submissions').insert(insertPayload);
    // 23505 = a concurrent/duplicate submit already stored this draft_version
    // (double-click). The unique index blocked the second row; the student still
    // gets their feedback, so return it and skip the side-effects the winning
    // request already ran — don't 500.
    if (insertErr && (insertErr as any).code === '23505') {
      console.warn('[generate-maths-feedback] duplicate draft insert ignored (idempotent)', { task_id, user_id: user.id, draftVersion });
      return res.status(200).json(successPayload);
    }
    if (insertErr) {
      captureError(insertErr, { stage: 'submission-insert-maths', task_id, user_id: user.id });
      return res.status(500).json({ error: 'Could not save your submission. Please try again.' });
    }

    // Post-submission side effects. Each swallows its own error so it can't
    // affect the feedback just produced, but they must finish before we respond:
    // on Vercel the instance freezes once the response is sent, tearing down any
    // in-flight socket. Collect and await in parallel rather than fire-and-forget.
    const bgWrites: PromiseLike<unknown>[] = [];

    // Fold the skill read into the student's rollup (the skill database). For a
    // multi-part submission this is the concat of every part's assessment.
    if (Array.isArray(skillAssessment) && skillAssessment.length > 0) {
      bgWrites.push(
        recordSkillSignals({
          supabase,
          studentId: user.id,
          discipline: (task.course ? getDisciplineForCourse(task.course) : null) || 'Mathematics',
          family: 'maths',
          assessment: skillAssessment,
        }).catch(err => captureError(err, { stage: 'skill-rollup-maths', user_id: user.id, task_id }))
      );
    }

    // Mark longitudinal profile stale (kept, not deleted).
    bgWrites.push(
      supabase.from('student_profile_synthesis')
        .update({ stale: true })
        .eq('student_id', user.id)
        .then(({ error }) => {
          if (error) captureError(error, { stage: 'profile-cache-invalidate-maths', user_id: user.id });
        })
    );

    // Clear autosave row.
    bgWrites.push(
      supabase.from('draft_autosaves')
        .delete()
        .eq('student_id', user.id)
        .eq('task_id', task_id)
        .then(({ error }) => {
          if (error) captureError(error, { stage: 'autosave-clear-maths', task_id, user_id: user.id });
        })
    );

    // LTI AGS passback (no-op if task isn't LTI-linked).
    bgWrites.push(
      postCompletionIfLinked({
        taskId: task_id,
        studentId: user.id,
        comment: `Maths draft ${draftVersion} submitted via ProofReady`,
      }).catch(err => captureError(err, { stage: 'ags-passback-maths', task_id, user_id: user.id }))
    );

    await Promise.allSettled(bgWrites);

    return res.status(200).json(successPayload);
  } catch (err: any) {
    captureError(err, { stage: 'top-level-maths', task_id, user_id: user.id });
    return res.status(500).json({ error: 'Failed to generate maths feedback. Please try again.' });
  }
});
