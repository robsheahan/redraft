import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const supabase = getSupabase();
  const { course, title, question, task_type, total_marks, due_date, outcomes, criteria, notes } = req.body;

  // Generate unique code
  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await supabase.from('tasks').select('code').eq('code', code).single();
    if (!existing) break;
    code = generateCode();
  }

  const { data, error } = await supabase.from('tasks').insert({
    code,
    teacher_id: user.id,
    course: course || null,
    title: title || null,
    question: question || null,
    task_type: task_type || null,
    total_marks: total_marks || null,
    due_date: due_date || null,
    outcomes: outcomes || [],
    criteria: criteria || [],
    notes: notes || null,
  }).select('code').single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ code: data.code });
}
