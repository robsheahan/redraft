import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';

const MODEL = 'claude-sonnet-4-6';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

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

  // Rate limit — teacher action, generous cap.
  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'generate-criteria',
    perUserPerHour: 30,
    globalPerDay: 500,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  const discipline = course ? getDisciplineForCourse(course) : null;

  const systemPrompt = buildSystemPrompt({
    course: course || null,
    discipline,
    totalMarks,
  });

  const userPrompt = buildUserPrompt({
    title: String(title).trim(),
    question: String(question).trim(),
    course: course || null,
    totalMarks,
    outcomes: Array.isArray(outcomes) ? outcomes.filter(o => typeof o === 'string' && o.trim()) : [],
  });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured.' });
  const client = new Anthropic({ apiKey });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.5,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = resp.content.find(b => b.type === 'text');
    const text = block && block.type === 'text' ? block.text.trim() : '';
    if (!text) return res.status(500).json({ error: 'No criteria returned.' });

    return res.status(200).json({ criteria_text: text });
  } catch (err: any) {
    captureError(err, { stage: 'generate-criteria', user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate criteria.' });
  }
}

function buildSystemPrompt(opts: {
  course: string | null;
  discipline: string | null;
  totalMarks: number;
}): string {
  const courseLine = opts.course ? `Course: ${opts.course}` : '';
  const disciplineLine = opts.discipline ? `Discipline: ${opts.discipline}` : '';
  return [
    `You are an experienced NSW NESA-trained marker producing a marking rubric for a classroom assessment task. Your rubrics follow the conventions used in NESA HSC Notes from the Marking Centre.`,
    courseLine,
    disciplineLine,
    `Total marks for this task: ${opts.totalMarks}`,
    ``,
    `Produce a single A–E band rubric for the whole task, following NESA's Common Grade Scale.`,
    ``,
    `Format requirements (strict):`,
    `- Exactly five bands in this order: A, B, C, D, E.`,
    `- Band labels follow NESA's Common Grade Scale and are FIXED:`,
    `    A = Outstanding`,
    `    B = High`,
    `    C = Sound`,
    `    D = Basic`,
    `    E = Elementary`,
    `- Mark ranges follow the Common Grade Scale percentage breakdown of the total marks (${opts.totalMarks}):`,
    `    A: 90%–100% of total`,
    `    B: 75%–89% of total`,
    `    C: 50%–74% of total`,
    `    D: 20%–49% of total`,
    `    E:  0%–19% of total`,
    `  Compute integer band boundaries as: band_low = ceil(percentage × total). Bands must be contiguous (no gaps, no overlap). The top of A is always ${opts.totalMarks}; the bottom of E is always 0. Single-mark bands are allowed when total marks are small.`,
    `- Each band has 2 to 4 short bullet descriptors that say what a response at this band looks like for THIS specific task — drawn from the task question and outcomes provided, not generic placeholders.`,
    `- Use NESA marker voice. Top-band verbs: "analyses thoroughly", "evaluates", "synthesises", "justifies", "integrates". Mid-band verbs: "explains", "describes accurately", "applies". Lower-band verbs: "outlines", "identifies", "lists", "describes briefly".`,
    `- Each descriptor is ONE clear sentence. No nested clauses, no semicolons.`,
    `- Use plain text only. NO markdown headers, NO bold, NO backticks.`,
    ``,
    `Output exactly in this shape (no preamble, no explanation, no closing remarks):`,
    ``,
    `A (low–high): Outstanding`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `B (low–high): High`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `C (low–high): Sound`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `D (low–high): Basic`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `E (0–high): Elementary`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `Worked examples of the band distribution (apply the same percentage logic to ${opts.totalMarks}):`,
    `- 100 marks → A (90–100), B (75–89), C (50–74), D (20–49), E (0–19)`,
    `-  25 marks → A (23–25), B (19–22), C (13–18), D (5–12),  E (0–4)`,
    `-  20 marks → A (18–20), B (15–17), C (10–14), D (4–9),   E (0–3)`,
    `-  15 marks → A (14–15), B (12–13), C (8–11),  D (3–7),   E (0–2)`,
    `-  10 marks → A (9–10),  B (8),     C (5–7),   D (2–4),   E (0–1)`,
    `-   5 marks → A (5),     B (4),     C (3),     D (1–2),   E (0)`,
    `-   4 marks → A (4),     B (3),     C (2),     D (1),     E (0)`,
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
    `Generate the A–E band rubric now. Apply the Common Grade Scale percentage breakdown to ${opts.totalMarks} total marks. Plain text only.`,
  ].filter(Boolean).join('\n');
}
