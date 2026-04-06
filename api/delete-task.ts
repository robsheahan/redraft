import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Task code is required' });
  }

  const supabase = getSupabase();

  // Verify the task belongs to this teacher
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('teacher_id')
    .eq('code', code)
    .single();

  if (taskError || !task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (task.teacher_id !== user.id) {
    return res.status(403).json({ error: 'You can only delete your own tasks' });
  }

  // Delete submissions first, then the task
  await supabase.from('submissions').delete().eq('task_code', code);
  const { error: deleteError } = await supabase.from('tasks').delete().eq('code', code);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message });
  }

  return res.status(200).json({ success: true });
}
