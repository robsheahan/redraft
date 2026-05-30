/**
 * Pass A — Structure free-form maths input into canonical line shape.
 *
 * Used by submit-maths.html's freeform and talk-through modes. Cheap Haiku
 * call (~$0.001 per request). Output feeds into the existing
 * /api/generate-maths-feedback endpoint as the working_lines input.
 *
 * Students confirm the parsed lines before Pass B runs — misreads become a
 * teaching moment ("the parser couldn't tell where step 3 ended; was that
 * one step or two?") rather than a silent corruption of the diagnostic.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { MATHS_STRUCTURE_WORKING_TOOL } from '../lib/feedback-tools.js';
import {
  buildMathsStructureWorkingSystem,
  buildMathsStructureWorkingUserPrompt,
} from '../prompts/maths-system.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { task_id, raw_text, input_mode } = (req.body || {}) as {
    task_id?: string;
    raw_text?: string;
    input_mode?: string;
  };

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (!raw_text || !String(raw_text).trim()) {
    return res.status(400).json({ error: 'Add some working before submitting.' });
  }
  if (String(raw_text).length > 20000) {
    return res.status(400).json({ error: 'Your input is too long. Trim it down before submitting.' });
  }
  if (input_mode !== 'freeform' && input_mode !== 'talkthrough') {
    return res.status(400).json({ error: 'input_mode must be "freeform" or "talkthrough".' });
  }

  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'structure-maths-working',
    perUserPerHour: 30,
    globalPerDay: 2000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded.' });
  }

  const { data: task } = await supabase.from('tasks').select('id, question, subject_type, class_id, published_at').eq('id', task_id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });
  if (task.subject_type !== 'maths') return res.status(400).json({ error: 'Pass A is for maths tasks only.' });
  const { data: membership } = await supabase
    .from('class_members')
    .select('student_id')
    .eq('class_id', task.class_id)
    .eq('student_id', user.id)
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

  const question = String(task.question || '').trim();

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await callTool<{ lines: Array<{ math: string; reason: string }> }>({
      client,
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      temperature: 0,
      system: buildMathsStructureWorkingSystem(),
      user: buildMathsStructureWorkingUserPrompt({
        question,
        rawText: String(raw_text),
        inputMode: input_mode,
      }),
      tool: MATHS_STRUCTURE_WORKING_TOOL,
    });

    const lines = (result.value.lines || [])
      .map(l => ({
        math: typeof l?.math === 'string' ? l.math.trim() : '',
        reason: typeof l?.reason === 'string' ? l.reason.trim() : '',
      }))
      .filter(l => l.math || l.reason);

    return res.status(200).json({ working_lines: lines });
  } catch (err: any) {
    captureError(err, { stage: 'structure-maths-working', task_id, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to parse your working.' });
  }
}
