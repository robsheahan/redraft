/**
 * AI-generated marking guideline for a maths task.
 *
 * Mirrors the structure of generate-criteria.ts (the essay equivalent) but
 * targets the per-step mark-allocation shape NESA uses for HSC Mathematics
 * marking guidelines (and a simpler analogue for Stage 4/5).
 *
 * Stage inference order:
 *   1. Outcomes prefix — MA4-* → 4, MA5-* → 5, MA11-* / MA12-* → 6
 *   2. Course string heuristics — "Advanced" / "Extension" / "HSC" → 6, etc.
 *   3. Default 6.
 *
 * Output is plain text, one step per line in the same shape teachers paste
 * directly into the Marking guideline textarea on new-task.html.
 */

import Anthropic from '@anthropic-ai/sdk';
import { callText } from '../lib/anthropic-tool-call.js';
import { getSupabase, authoritativeRole } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { withHandler } from '../lib/with-handler.js';

const MODEL = 'claude-sonnet-5';

type Stage = 4 | 5 | 6;

function inferStage(outcomes: string[], course: string | null): Stage {
  // 1. Outcome code prefix.
  for (const o of outcomes) {
    const code = String(o || '').toUpperCase().trim();
    if (/^MA4[-\s]/.test(code)) return 4;
    if (/^MA5[-\s]/.test(code)) return 5;
    if (/^MA(11|12)[-\s]/.test(code) || /^MAA1[12][-\s]/.test(code) || /^MAE1[12][-\s]/.test(code)) return 6;
  }
  // 2. Course string heuristics.
  const c = (course || '').toLowerCase();
  if (!c) return 6;
  if (/\b(advanced|extension|standard\s*[12]|hsc|year\s*1[12]|stage\s*6)\b/.test(c)) return 6;
  if (/\b(year\s*(9|10)|stage\s*5)\b/.test(c)) return 5;
  if (/\b(year\s*[78]|stage\s*4)\b/.test(c)) return 4;
  return 6;
}

export default withHandler({ methods: ['POST'], label: 'generate-marking-guideline' }, async (req, res, ctx) => {
  const user = ctx.user!;
  // Teacher-only: students could otherwise generate a marking guideline for
  // their own task's question — a soft bypass of "students never see it".
  if (authoritativeRole(user) !== 'teacher') {
    return res.status(403).json({ error: 'Only teachers can generate marking guidelines.' });
  }

  const { title, question, course, total_marks, outcomes, worked_solution } = (req.body || {}) as {
    title?: string;
    question?: string;
    course?: string;
    total_marks?: number | string;
    outcomes?: string[];
    worked_solution?: string;
  };

  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'Task question is required.' });
  const totalMarks = Number(total_marks);
  if (!Number.isFinite(totalMarks) || totalMarks < 1 || totalMarks > 100) {
    return res.status(400).json({ error: 'Total marks must be between 1 and 100.' });
  }

  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'generate-marking-guideline',
    perUserPerHour: 30,
    globalPerDay: 500,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  const outcomesList = Array.isArray(outcomes)
    ? outcomes.filter(o => typeof o === 'string' && o.trim())
    : [];
  const stage = inferStage(outcomesList, course || null);

  const systemPrompt = buildSystemPrompt({ course: course || null, totalMarks, stage });
  const userPrompt = buildUserPrompt({
    title: String(title).trim(),
    question: String(question).trim(),
    course: course || null,
    totalMarks,
    outcomes: outcomesList,
    workedSolution: typeof worked_solution === 'string' ? worked_solution.trim() : null,
  });

  const client = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
    : undefined;

  try {
    const result = await callText({
      client,
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      user: userPrompt,
      label: 'maths:marking-guideline',
    });
    const text = result.value;
    if (!text) return res.status(500).json({ error: 'No marking guideline returned.' });

    return res.status(200).json({ marking_guideline: text, stage });
  } catch (err: any) {
    captureError(err, { stage: 'generate-marking-guideline', user_id: user.id });
    return res.status(500).json({ error: 'Failed to generate marking guideline. Please try again.' });
  }
});

export function buildSystemPrompt(opts: { course: string | null; totalMarks: number; stage: Stage }): string {
  const isHsc = opts.stage === 6;
  const courseLine = opts.course ? `Course: ${opts.course}` : '';
  const stageLabel = opts.stage === 4 ? 'Stage 4 (Year 7–8)' : opts.stage === 5 ? 'Stage 5 (Year 9–10)' : 'Stage 6 (Year 11–12, HSC)';
  const single = opts.totalMarks <= 1;

  return [
    `You are an experienced NSW Mathematics teacher producing a marking guideline for a single classroom maths task, in the authentic style of NESA's published HSC marking guidelines.`,
    courseLine,
    `Stage: ${stageLabel}`,
    `Total marks for this task: ${opts.totalMarks}`,
    ``,
    `A NESA marking guideline is a DESCENDING CRITERIA LADDER, not a list of additive steps. The TOP line is the full-mark achievement; each line below it describes a less-complete response worth one fewer mark, down to 1 mark. The mark on each line is the TOTAL marks a response reaching that depth earns — the marks do NOT sum to the task total.`,
    ``,
    `STRUCTURE (STRICT):`,
    `- One criterion per line, ordered from full marks (top) down to 1 mark (bottom). No 0-mark line.`,
    single
      ? `- This is a ${opts.totalMarks}-mark task: output a single line — "Provides correct answer (1 mark)" — specialised to what the correct answer is.`
      : `- The TOP line is the full-mark line ("(${opts.totalMarks} marks)") and MUST begin with one of: "Provides correct solution" (a worked calculation), "Provides correct proof" (a 'show'/'prove' question), "Provides correct graph" / "Provides correct sketch" (a graphing task), or "Provides correct answer with reasoning" (a justify/explain question). Specialise it lightly to the task.`,
    `- Each line BELOW the top names a CONCRETE partial-achievement milestone drawn from THIS question, with its cumulative mark in parentheses, e.g. "(2 marks)" then "(1 mark)". Use NESA's milestone verbs: Finds, Calculates, Uses, Obtains, Applies, Identifies, Attempts, Establishes, Shows, Substitutes, Equates, Sets up, Recognises.`,
    isHsc
      ? `- Append ", or equivalent merit" to every partial-credit line (every line except the top full-mark line). This is NESA's signal that any equally-advanced alternative method earns the mark.`
      : `- Where a different valid method would earn the same mark, you may add ", or equivalent approach" to a partial line.`,
    `- The bottom line is worth 1 mark and rewards the first meaningful step ("Attempts to…", "Finds…", "Sets up…").`,
    `- Plain text only, one criterion per line. NO header row, NO "Criteria/Marks" labels, no bullets, no bold, no backticks, no preamble, no sample answer/worked solution, no closing remarks.`,
    ``,
    `VERB-AWARE:`,
    `- "Show that" / "Prove": the answer is given, so the top line is "Provides correct proof" and partial lines reward genuine progress TOWARD the given result ("Establishes …", "Begins by …"). A response that only restates the target earns nothing.`,
    `- "Prove by induction": ladder as — establishes the base case (1 mark) → assumes and sets up the inductive step (2 marks) → completes a correct proof (full marks).`,
    `- "Hence": a partial line should reference using the earlier result ("Uses part (a) to …${isHsc ? ', or equivalent merit' : ''}").`,
    `- "Justify" / "Explain": the reasoning itself is mark-bearing; top line is "Provides correct answer with reasoning".`,
    isHsc ? `- Reference HSC conventions where relevant: exact / simplest form, "+C", domain stated, units, with a labelled diagram.` : ``,
    ``,
    `EXAMPLE (a 3-mark task — write criteria SPECIFIC to your task, do not copy):`,
    `Provides correct solution (3 marks)`,
    `Finds the derivative and solves f'(x) = 0${isHsc ? ', or equivalent merit' : ''} (2 marks)`,
    `Differentiates the function correctly${isHsc ? ', or equivalent merit' : ''} (1 mark)`,
  ].filter(Boolean).join('\n');
}

export function buildUserPrompt(opts: {
  title: string;
  question: string;
  course: string | null;
  totalMarks: number;
  outcomes: string[];
  workedSolution?: string | null;
}): string {
  const outcomesBlock = opts.outcomes.length > 0
    ? `Syllabus outcomes the task addresses:\n${opts.outcomes.map(o => `- ${o}`).join('\n')}`
    : '';
  // Anchor the criteria ladder to the teacher's actual solution steps when present.
  const solutionBlock = opts.workedSolution
    ? `\nThe teacher's worked solution (anchor each partial-credit milestone to a real step in THIS solution — its key transitions become the lower tiers; do NOT reproduce the solution in your output):\n${opts.workedSolution}\n`
    : '';
  return [
    `Task title: ${opts.title}`,
    opts.course ? `Course: ${opts.course}` : '',
    `Total marks: ${opts.totalMarks}`,
    '',
    `Task question (what the student is asked to do):`,
    opts.question,
    solutionBlock,
    outcomesBlock,
    '',
    `Generate the marking guideline now as a DESCENDING criteria ladder — top line = full marks (${opts.totalMarks}), each line below worth one fewer mark, down to 1. Plain text, one criterion per line, no header.`,
  ].filter(Boolean).join('\n');
}
