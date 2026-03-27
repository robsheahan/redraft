import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

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

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  const { course, title, question, task_type, total_marks, due_date, outcomes, criteria, notes } = req.body;

  // Generate unique code (retry on collision)
  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await supabase.from('tasks').select('code').eq('code', code).single();
    if (!existing) break;
    code = generateCode();
  }

  const { data, error } = await supabase.from('tasks').insert({
    code,
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
