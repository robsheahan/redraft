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

  const code = req.query.code as string;
  if (!code) {
    return res.status(400).json({ error: 'Task code is required' });
  }

  const supabase = getSupabase();

  // Verify this task belongs to the authenticated teacher
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('*')
    .eq('code', code)
    .eq('teacher_id', user.id)
    .single();

  if (taskError || !task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { data: submissions, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('task_code', code)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ task, submissions: submissions || [] });
}
