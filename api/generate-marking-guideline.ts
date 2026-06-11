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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';

const MODEL = 'claude-sonnet-4-6';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  // Teacher-only: students could otherwise generate a marking guideline for
  // their own task's question — a soft bypass of "students never see it".
  if (user.user_metadata?.role !== 'teacher') {
    return res.status(403).json({ error: 'Only teachers can generate marking guidelines.' });
  }

  const { title, question, course, total_marks, outcomes } = (req.body || {}) as {
    title?: string;
    question?: string;
    course?: string;
    total_marks?: number | string;
    outcomes?: string[];
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
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured.' });
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = resp.content.find(b => b.type === 'text');
    const text = block && block.type === 'text' ? block.text.trim() : '';
    if (!text) return res.status(500).json({ error: 'No marking guideline returned.' });

    return res.status(200).json({ marking_guideline: text, stage });
  } catch (err: any) {
    captureError(err, { stage: 'generate-marking-guideline', user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate marking guideline.' });
  }
}

function buildSystemPrompt(opts: { course: string | null; totalMarks: number; stage: Stage }): string {
  const isHsc = opts.stage === 6;
  const courseLine = opts.course ? `Course: ${opts.course}` : '';
  const stageLabel = opts.stage === 4 ? 'Stage 4 (Year 7–8)' : opts.stage === 5 ? 'Stage 5 (Year 9–10)' : 'Stage 6 (Year 11–12, HSC)';

  return [
    `You are an experienced NSW Mathematics teacher producing a marking guideline for a single classroom maths task.`,
    courseLine,
    `Stage: ${stageLabel}`,
    `Total marks for this task: ${opts.totalMarks}`,
    ``,
    isHsc
      ? `For Stage 6 HSC Mathematics, produce a per-step marking guideline in the style of NESA's published HSC marking guidelines. Each line is one mark-bearing step the student must show. The total of all mark values across lines MUST equal ${opts.totalMarks}.`
      : opts.stage === 5
      ? `For Stage 5 (Year 9–10), produce a per-step marking guideline. Each line is one mark-bearing step the student must show. Use fewer, broader steps than HSC (typically 3–6 lines). The total of all mark values across lines MUST equal ${opts.totalMarks}.`
      : `For Stage 4 (Year 7–8), produce a per-step marking guideline. Each line is one mark-bearing step the student must show. Use simple, holistic steps (typically 3–5 lines) — students at this stage are learning to show working, use the equals sign correctly, and answer in context. The total of all mark values across lines MUST equal ${opts.totalMarks}.`,
    ``,
    `Format requirements (STRICT):`,
    `- One step per line.`,
    `- Each line begins with "- " (hyphen space).`,
    `- Each line ends with " (N mark)" or " (N marks)" — the mark value for that step in parentheses.`,
    `- The mark values across all lines must sum to exactly ${opts.totalMarks}.`,
    `- Plain text only. No headers. No bold. No backticks. No preamble. No closing remarks.`,
    `- Steps must be specific to THIS task — drawn from the question, not generic placeholders.`,
    isHsc
      ? `- HSC marker voice. Reference specific NESA conventions where relevant: "show all working", "state in exact form", "with reasons", "with a labelled diagram", "in simplest form".`
      : opts.stage === 5
      ? `- Year 9–10 teacher voice. Emphasise showing working, correct notation, and answering in context.`
      : `- Year 7–8 teacher voice. Emphasise showing each step, using "=" only between equal expressions, and writing the answer in a complete sentence where appropriate.`,
    ``,
    `Example shape (do NOT copy verbatim — write specific steps for the task you are given):`,
    `- Differentiates the function correctly using the chain rule (1 mark)`,
    `- Sets derivative to zero and solves the resulting equation (1 mark)`,
    `- Identifies and justifies the nature of each stationary point (1 mark)`,
    `- Calculates the y-coordinate of each stationary point (1 mark)`,
    `- States the absolute extrema with coordinates (1 mark)`,
  ].filter(Boolean).join('\n');
}

function buildUserPrompt(opts: {
  title: string;
  question: string;
  course: string | null;
  totalMarks: number;
  outcomes: string[];
}): string {
  const outcomesBlock = opts.outcomes.length > 0
    ? `Syllabus outcomes the task addresses:\n${opts.outcomes.map(o => `- ${o}`).join('\n')}`
    : '';
  return [
    `Task title: ${opts.title}`,
    opts.course ? `Course: ${opts.course}` : '',
    `Total marks: ${opts.totalMarks}`,
    '',
    `Task question (what the student is asked to do):`,
    opts.question,
    '',
    outcomesBlock,
    '',
    `Generate the marking guideline now. One mark-bearing step per line. Mark values must sum to exactly ${opts.totalMarks}. Plain text only.`,
  ].filter(Boolean).join('\n');
}
