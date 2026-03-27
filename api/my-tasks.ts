import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const supabase = getSupabase();

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('teacher_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Get submission counts for each task
  const codes = tasks.map(t => t.code);
  const { data: counts } = await supabase
    .from('submissions')
    .select('task_code')
    .in('task_code', codes);

  const countMap: Record<string, number> = {};
  (counts || []).forEach(s => {
    countMap[s.task_code] = (countMap[s.task_code] || 0) + 1;
  });

  const result = tasks.map(t => ({
    ...t,
    submission_count: countMap[t.code] || 0,
  }));

  return res.status(200).json(result);
}
