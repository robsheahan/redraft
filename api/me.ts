import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * "Data about the currently signed-in user" endpoint.
 *
 *   GET /api/me?resource=submissions              → student's submissions across all classes
 *   GET /api/me?resource=task-drafts&task_id=X    → student's drafts for one task
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const resource = (req.query.resource as string || '').trim();
  switch (resource) {
    case 'submissions':  return returnSubmissions(req, res, user.id);
    case 'task-drafts':  return returnTaskDrafts(req, res, user.id);
    default:
      return res.status(400).json({ error: 'Unknown resource. Use ?resource=submissions|task-drafts' });
  }
}

async function returnSubmissions(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('student_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const taskIds = [...new Set((data || []).map(s => s.task_id).filter(Boolean))] as string[];
  const taskMap: Record<string, { title: string | null; class_id: string | null; course: string | null }> = {};
  const classMap: Record<string, { name: string | null; course: string | null }> = {};
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks').select('id, title, class_id, course').in('id', taskIds);
    (tasks || []).forEach(t => { taskMap[t.id] = { title: t.title, class_id: t.class_id, course: t.course }; });
    const classIds = [...new Set((tasks || []).map(t => t.class_id).filter(Boolean))] as string[];
    if (classIds.length > 0) {
      const { data: classes } = await supabase.from('classes').select('id, name, course').in('id', classIds);
      (classes || []).forEach(c => { classMap[c.id] = { name: c.name, course: c.course }; });
    }
  }

  const enriched = (data || []).map(s => {
    const t = s.task_id ? taskMap[s.task_id] : null;
    const cls = t?.class_id ? classMap[t.class_id] : null;
    return {
      ...s,
      task_title: t?.title || null,
      class_id: t?.class_id || null,
      class_name: cls?.name || null,
      course: s.course || t?.course || cls?.course || null,
    };
  });
  return res.status(200).json(enriched);
}

async function returnTaskDrafts(req: VercelRequest, res: VercelResponse, userId: string) {
  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('submissions')
    .select('draft_text, feedback, draft_version, created_at, question, course')
    .eq('student_id', userId)
    .eq('task_id', taskId)
    .order('draft_version', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ drafts: data || [] });
}
