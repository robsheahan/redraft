import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { getUserInfoBatch } from '../lib/user-names.js';

/**
 * Teacher view of all submissions for one of their tasks.
 * Authorised iff the task belongs to a class the teacher owns.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();

  const { data: task } = await supabase
    .from('tasks').select('*, classes(teacher_id, name, course)').eq('id', taskId).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (task.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'Not authorised.' });

  const { data: submissions, error } = await supabase
    .from('submissions').select('*').eq('task_id', taskId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const studentIds = [...new Set((submissions || []).map(s => s.student_id).filter(Boolean))] as string[];
  const userInfo = await getUserInfoBatch(supabase, studentIds);

  const enriched = (submissions || []).map(s => ({
    ...s,
    student_name: userInfo[s.student_id]?.name || 'Unknown student',
  }));

  return res.status(200).json({ task, submissions: enriched });
}
