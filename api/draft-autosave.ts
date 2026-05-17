import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

const MAX_DRAFT_CHARS = 50_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET')  return getAutosave(req, res, user.id);
  if (req.method === 'PUT')  return putAutosave(req, res, user.id);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function getAutosave(req: VercelRequest, res: VercelResponse, userId: string) {
  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('draft_autosaves')
    .select('draft_text, telemetry, updated_at')
    .eq('student_id', userId)
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    draft_text: data?.draft_text || '',
    telemetry: data?.telemetry || {},
    updated_at: data?.updated_at || null,
  });
}

async function putAutosave(req: VercelRequest, res: VercelResponse, userId: string) {
  const { task_id, draft_text, telemetry } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (typeof draft_text !== 'string') return res.status(400).json({ error: 'draft_text must be a string.' });
  if (draft_text.length > MAX_DRAFT_CHARS) {
    return res.status(413).json({ error: `Draft is too long (max ${MAX_DRAFT_CHARS} chars).` });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from('draft_autosaves').upsert({
    student_id: userId,
    task_id,
    draft_text,
    telemetry: telemetry && typeof telemetry === 'object' ? telemetry : {},
    updated_at: new Date().toISOString(),
  }, { onConflict: 'student_id,task_id' });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}
