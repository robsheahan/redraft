import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Task CRUD under the classes redesign.
 *
 * Tasks always live inside a class. A task has a published_at timestamp:
 *   null     → draft, only visible to the teacher owner
 *   non-null → published, visible to class members
 *
 *   GET    /api/task?id=<uuid>      → fetch a task (teacher owner: full; student member: published + notes stripped)
 *   POST   /api/task                → create task inside a class (teacher owner only). Pass publish:true to publish immediately.
 *   PUT    /api/task                → update task (teacher owner only). Pass publish:true/false to toggle published_at.
 *   DELETE /api/task                → delete task + its submissions (teacher owner only)
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
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
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const id = (req.query.id as string || '').trim();
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: task } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const { data: cls } = await supabase
    .from('classes').select('id, name, course, teacher_id').eq('id', task.class_id).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'Class for this task is missing.' });

  const isOwner = cls.teacher_id === user.id;
  let isMember = false;
  if (!isOwner) {
    const { data: m } = await supabase.from('class_members')
      .select('student_id').eq('class_id', cls.id).eq('student_id', user.id).maybeSingle();
    isMember = !!m;
  }
  if (!isOwner && !isMember) return res.status(403).json({ error: 'Not authorised to view this task.' });

  // Students can only see published tasks
  if (!isOwner && !task.published_at) {
    return res.status(404).json({ error: 'Task not found.' });
  }

  // Scrub teacher notes for non-owners
  const payload: any = { ...task };
  if (!isOwner) delete payload.notes;

  return res.status(200).json({
    task: payload,
    class: { id: cls.id, name: cls.name, course: cls.course },
    role: isOwner ? 'teacher' : 'student',
  });
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();
  const { class_id, course, title, question, task_type, total_marks, due_date, outcomes, criteria, criteria_text, notes, publish } = req.body || {};

  if (!class_id) return res.status(400).json({ error: 'class_id is required — tasks must belong to a class.' });
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'Task question is required.' });

  const { data: cls } = await supabase.from('classes').select('id, teacher_id').eq('id', class_id).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  if (cls.teacher_id !== user.id) return res.status(403).json({ error: 'You can only add tasks to your own classes.' });

  const { data, error } = await supabase.from('tasks').insert({
    class_id,
    teacher_id: user.id,
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
    published_at: publish ? new Date().toISOString() : null,
  }).select('*').single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ task: data });
}

async function handleUpdate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { id, course, title, question, task_type, total_marks, due_date, outcomes, criteria, criteria_text, notes, publish } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('tasks').select('id, class_id, published_at, classes(teacher_id)').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (existing.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'You can only update your own tasks.' });

  const patch: any = {
    course: course ?? undefined,
    title: title ?? undefined,
    question: question ?? undefined,
    task_type: task_type ?? undefined,
    total_marks: total_marks ?? undefined,
    due_date: due_date ?? undefined,
    outcomes: outcomes ?? undefined,
    criteria: criteria ?? undefined,
    criteria_text: criteria_text ?? undefined,
    notes: notes ?? undefined,
  };
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

  if (typeof publish === 'boolean') {
    patch.published_at = publish ? (existing.published_at || new Date().toISOString()) : null;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { error } = await supabase.from('tasks').update(patch).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Task id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('tasks').select('id, classes(teacher_id)').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (existing.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'You can only delete your own tasks.' });

  await supabase.from('submissions').delete().eq('task_id', id);
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
