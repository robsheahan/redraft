import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Unified "data about the currently signed-in user" endpoint — merged to stay
 * under Vercel Hobby's 12-serverless-function limit.
 *
 *   GET /api/me?resource=tasks           — teacher's tasks with submission counts
 *   GET /api/me?resource=submissions     — student's submissions with task titles
 *   GET /api/me?resource=task-drafts&code=XYZ — student's drafts for one task
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const resource = (req.query.resource as string || '').trim();
  switch (resource) {
    case 'tasks':        return returnTasks(req, res, user.id);
    case 'submissions':  return returnSubmissions(req, res, user.id);
    case 'task-drafts':  return returnTaskDrafts(req, res, user.id);
    default:
      return res.status(400).json({ error: 'Unknown resource. Use ?resource=tasks|submissions|task-drafts' });
  }
}

async function returnTasks(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('teacher_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const codes = (tasks || []).map(t => t.code);
  const { data: counts } = codes.length
    ? await supabase.from('submissions').select('task_code').in('task_code', codes)
    : { data: [] as { task_code: string }[] };

  const countMap: Record<string, number> = {};
  (counts || []).forEach(s => { countMap[s.task_code] = (countMap[s.task_code] || 0) + 1; });

  const result = (tasks || []).map(t => ({ ...t, submission_count: countMap[t.code] || 0 }));
  return res.status(200).json(result);
}

async function returnSubmissions(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('student_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const taskCodes = [...new Set((data || []).map(s => s.task_code).filter(Boolean))];
  const titleMap: Record<string, string> = {};
  if (taskCodes.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('code, title')
      .in('code', taskCodes);
    (tasks || []).forEach(t => { if (t.title) titleMap[t.code] = t.title; });
  }

  const enriched = (data || []).map(s => ({
    ...s,
    task_title: (s.task_code && titleMap[s.task_code]) || null,
  }));
  return res.status(200).json(enriched);
}

async function returnTaskDrafts(req: VercelRequest, res: VercelResponse, userId: string) {
  const code = (req.query.code as string || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Task code is required' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('submissions')
    .select('draft_text, feedback, draft_version, created_at, question, course')
    .eq('student_id', userId)
    .eq('task_code', code)
    .order('draft_version', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ drafts: data || [] });
}
