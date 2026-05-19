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
    `You are an experienced NSW NESA-trained teacher creating a marking rubric for a classroom assessment task.`,
    courseLine,
    disciplineLine,
    `Total marks for this task: ${opts.totalMarks}`,
    ``,
    `Your task: produce a clean, classroom-ready marking criteria (rubric) that a teacher could use to mark student responses.`,
    ``,
    `Format requirements (strict):`,
    `- 2 to 4 distinct criteria, each measuring a clearly different aspect of the response.`,
    `- The MAX marks of each criterion must sum exactly to the total marks given. The MIN of each criterion should be roughly half of its max (allow some judgement room).`,
    `- Each criterion has 2 to 4 short bullet descriptors of what's being assessed.`,
    `- Descriptors should reflect NESA-style band language for the discipline (e.g. "analyses", "evaluates", "applies", "demonstrates").`,
    `- Use criterion-list format. Output PLAIN TEXT with NO markdown headers, NO bold, NO backticks.`,
    ``,
    `Output exactly in this shape (no preamble, no explanation, no closing remarks):`,
    ``,
    `Criterion 1: [Name] (min-max marks)`,
    `- Descriptor 1`,
    `- Descriptor 2`,
    ``,
    `Criterion 2: [Name] (min-max marks)`,
    `- Descriptor 1`,
    `- Descriptor 2`,
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
