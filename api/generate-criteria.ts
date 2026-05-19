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
    `Produce a single A–E band rubric for the whole task. This is the NESA-standard 5-band marking format.`,
    ``,
    `Format requirements (strict):`,
    `- Exactly five bands in this order: A, B, C, D, E.`,
    `- Band labels are fixed: A = Highly Developed, B = Well Developed, C = Developing, D = Basic, E = Minimal.`,
    `- Each band has a contiguous mark range with no gaps and no overlap.`,
    `- The TOP of band A MUST equal ${opts.totalMarks}. The BOTTOM of band E MUST equal 0.`,
    `- Distribute the ${opts.totalMarks} marks roughly evenly across the five bands. Single-mark bands are allowed when total marks are small.`,
    `- Each band has 2 to 4 short bullet descriptors that say what a response at this band looks like for THIS specific task — drawn from the task question and outcomes provided, not generic placeholders.`,
    `- Use NESA marker voice. Top-band verbs: "analyses thoroughly", "evaluates", "synthesises", "justifies", "integrates". Mid-band verbs: "explains", "describes accurately", "applies". Lower-band verbs: "outlines", "identifies", "lists", "describes briefly".`,
    `- Each descriptor is ONE clear sentence. No nested clauses, no semicolons.`,
    `- Use plain text only. NO markdown headers, NO bold, NO backticks.`,
    ``,
    `Output exactly in this shape (no preamble, no explanation, no closing remarks):`,
    ``,
    `A (high-low–high-high): Highly Developed`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `B (low–high): Well Developed`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `C (low–high): Developing`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `D (low–high): Basic`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `E (0–high): Minimal`,
    `- Descriptor`,
    `- Descriptor`,
    ``,
    `Worked examples of the band distribution:`,
    `- 20 marks → A (17–20), B (13–16), C (9–12), D (5–8), E (0–4)`,
    `- 15 marks → A (13–15), B (10–12), C (7–9), D (4–6), E (0–3)`,
    `- 10 marks → A (9–10), B (7–8), C (5–6), D (3–4), E (0–2)`,
    `- 5 marks  → A (5), B (4), C (3), D (1–2), E (0)`,
    `- 4 marks  → A (4), B (3), C (2), D (1), E (0)`,
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
    `Generate the marking criteria now. Remember: 2-4 criteria, max marks sum to ${opts.totalMarks}, plain text only.`,
  ].filter(Boolean).join('\n');
}
