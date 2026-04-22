import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { createClient } from '@supabase/supabase-js';

/**
 * Unified task CRUD endpoint — merged to stay under Vercel Hobby's
 * 12-serverless-function limit.
 *
 *   GET    /api/task?code=XYZ     — fetch a single task (public, students joining by code)
 *                                   response strips teacher notes
 *   POST   /api/task              — create a new task (teacher auth)
 *   PUT    /api/task              — update an existing task (teacher auth, owner only)
 *   DELETE /api/task              — delete a task + its submissions (teacher auth, owner only)
 */

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.method) {
    case 'GET':    return handleGet(req, res);
    case 'POST':   return handleCreate(req, res);
    case 'PUT':    return handleUpdate(req, res);
    case 'DELETE': return handleDelete(req, res);
    default:
      return res.status(405).json({ error: 'Method not allowed' });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  // Public: student needs this to join a task by code. Uses service key but
  // strips teacher notes before returning.
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
  );

  const code = (req.query.code as string || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Code is required' });
  }

  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('code', code)
    .single();
  if (error || !data) {
    return res.status(404).json({ error: 'Task not found. Check the code and try again.' });
  }

  let teacherName = null;
  if (data.teacher_id) {
    try {
      const { data: teacherData } = await supabase.auth.admin.getUserById(data.teacher_id);
      teacherName = teacherData?.user?.user_metadata?.display_name || null;
    } catch { /* silently skip */ }
  }

  const { notes, ...studentData } = data;
  return res.status(200).json({ ...studentData, teacher_name: teacherName });
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();
  const { course, class_name, title, question, task_type, total_marks, due_date, outcomes, criteria, criteria_text, notes } = req.body;

  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Task question is required' });
  }
  if (!course || !String(course).trim()) {
    return res.status(400).json({ error: 'Course is required' });
  }

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
    class_name: class_name || null,
    title: title || null,
    question: question || null,
    task_type: task_type || null,
    total_marks: total_marks || null,
    due_date: due_date || null,
    outcomes: outcomes || [],
    criteria: criteria || [],
    criteria_text: criteria_text || null,
    notes: notes || null,
  }).select('code').single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ code: data.code });
}

async function handleUpdate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { code, course, class_name, title, question, task_type, total_marks, due_date, outcomes, criteria, criteria_text, notes } = req.body;
  if (!code) return res.status(400).json({ error: 'Task code is required' });

  const supabase = getSupabase();

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
      class_name: class_name || null,
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

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Task code is required' });

  const supabase = getSupabase();

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('teacher_id')
    .eq('code', code)
    .single();
  if (taskError || !task) return res.status(404).json({ error: 'Task not found' });
  if (task.teacher_id !== user.id) return res.status(403).json({ error: 'You can only delete your own tasks' });

  await supabase.from('submissions').delete().eq('task_code', code);
  const { error: deleteError } = await supabase.from('tasks').delete().eq('code', code);

  if (deleteError) return res.status(500).json({ error: deleteError.message });
  return res.status(200).json({ success: true });
}
