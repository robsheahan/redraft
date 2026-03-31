import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { code, course, title, question, task_type, total_marks, due_date, outcomes, criteria, criteria_text, notes } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Task code is required' });
  }

  const supabase = getSupabase();

  // Verify teacher owns the task
  const { data: existing, error: findError } = await supabase
    .from('tasks')
    .select('id')
    .eq('code', code)
    .eq('teacher_id', user.id)
    .single();

  if (findError || !existing) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { error } = await supabase
    .from('tasks')
    .update({
      course: course || null,
      title: title || null,
      question: question || null,
      task_type: task_type || null,
      total_marks: total_marks || null,
      due_date: due_date || null,
      outcomes: outcomes || [],
      criteria: criteria || [],
      criteria_text: criteria_text || null,
      notes: notes || null,
    })
    .eq('code', code)
    .eq('teacher_id', user.id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ success: true });
}
