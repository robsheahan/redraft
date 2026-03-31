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

  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('student_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Look up task titles for submissions with a task_code
  const taskCodes = [...new Set((data || []).map(s => s.task_code).filter(Boolean))];
  const titleMap: Record<string, string> = {};

  if (taskCodes.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('code, title')
      .in('code', taskCodes);

    (tasks || []).forEach(t => {
      if (t.title) titleMap[t.code] = t.title;
    });
  }

  const enriched = (data || []).map(s => ({
    ...s,
    task_title: (s.task_code && titleMap[s.task_code]) || null,
  }));

  return res.status(200).json(enriched);
}
