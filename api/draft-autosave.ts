import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';

const MAX_DRAFT_CHARS = 50_000;

export default withHandler({ methods: ['GET', 'PUT'], label: 'draft-autosave' }, async (req, res, ctx) => {
  const user = ctx.user!;
  if (req.method === 'GET') return getAutosave(req, res, user.id);
  return putAutosave(req, res, user.id);
});

async function getAutosave(req: VercelRequest, res: VercelResponse, userId: string) {
  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('draft_autosaves')
    .select('draft_text, answers, telemetry, updated_at')
    .eq('student_id', userId)
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    draft_text: data?.draft_text || '',
    // Multi-question exams: in-progress per-question answers, keyed by
    // question_id. null/absent for single-response tasks.
    answers: data?.answers ?? null,
    telemetry: data?.telemetry || {},
    updated_at: data?.updated_at || null,
  });
}

/** Does an exam-style per-question answers object carry any real content? */
function answersHaveContent(answers: unknown): boolean {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  return Object.values(answers as Record<string, unknown>).some((v: any) => {
    if (typeof v === 'string') return v.trim().length > 0;
    if (v && typeof v === 'object') {
      return (typeof v.text === 'string' && v.text.trim().length > 0)
        || (typeof v.selected_option_id === 'string' && v.selected_option_id.length > 0);
    }
    return false;
  });
}

async function putAutosave(req: VercelRequest, res: VercelResponse, userId: string) {
  const { task_id, draft_text, answers, telemetry } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (typeof draft_text !== 'string') return res.status(400).json({ error: 'draft_text must be a string.' });
  if (draft_text.length > MAX_DRAFT_CHARS) {
    return res.status(413).json({ error: `Draft is too long (max ${MAX_DRAFT_CHARS} chars).` });
  }

  const supabase = getSupabase();

  // An autosave row is the "a student has started" signal that permanently locks
  // the teacher's ability to edit the question/criteria (api/task.ts), so it
  // must only ever exist for a real, published task the caller can actually see.
  const { data: task, error: taskErr } = await supabase
    .from('tasks').select('id, class_id, published_at').eq('id', task_id).maybeSingle();
  if (taskErr) return res.status(500).json({ error: taskErr.message });
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  // Draft (unpublished) tasks are invisible to students — mirror api/task.ts GET.
  if (!task.published_at) return res.status(404).json({ error: 'Task not found.' });

  const { data: member, error: memberErr } = await supabase
    .from('class_members').select('student_id')
    .eq('class_id', task.class_id).eq('student_id', userId).maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

  // An empty autosave shouldn't create the row that locks the task. Skip the
  // write (no-op success) until there's genuine in-progress work; once a row
  // exists the student truly started, and updates — even back to empty — save
  // normally via the upsert below.
  if (!draft_text.trim() && !answersHaveContent(answers)) {
    const { data: existing, error: existErr } = await supabase
      .from('draft_autosaves').select('task_id')
      .eq('student_id', userId).eq('task_id', task_id).maybeSingle();
    if (existErr) return res.status(500).json({ error: existErr.message });
    if (!existing) return res.status(200).json({ ok: true, skipped: true });
  }

  const { error } = await supabase.from('draft_autosaves').upsert({
    student_id: userId,
    task_id,
    draft_text,
    // Multi-question exams send a per-question answers object. Stored verbatim
    // (jsonb); null for single-response tasks. The serialized draft_text is
    // sent alongside so any legacy reader still sees the work.
    answers: answers && typeof answers === 'object' ? answers : null,
    telemetry: telemetry && typeof telemetry === 'object' ? telemetry : {},
    updated_at: new Date().toISOString(),
  }, { onConflict: 'student_id,task_id' });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}
