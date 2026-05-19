import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { captureError } from './../lib/sentry.js';

const MAX_DRAFT_CHARS = 50_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const {
    task_id,
    draft,
    keystroke_count,
    paste_attempts_blocked,
    typing_session_count,
    total_typing_time_ms,
    time_to_first_keystroke_ms,
  } = (req.body || {}) as Record<string, unknown>;

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (typeof draft !== 'string') return res.status(400).json({ error: 'draft must be a string.' });
  const draftText = draft.trim();
  if (draftText.length < 50) {
    return res.status(400).json({ error: 'Your draft is too short. Write at least a paragraph and try again.' });
  }
  if (draftText.length > MAX_DRAFT_CHARS) {
    return res.status(400).json({ error: 'Your draft is too long.' });
  }

  const supabase = getSupabase();

  // Reject if the task is already locked for this student (graded OR
  // already submitted-for-marking).
  const { data: locked } = await supabase
    .from('submissions')
    .select('id, graded_at, submitted_for_marking')
    .eq('student_id', user.id)
    .eq('task_id', task_id as string)
    .or('graded_at.not.is.null,submitted_for_marking.eq.true')
    .maybeSingle();
  if (locked) {
    const reason = locked.graded_at
      ? 'This task has already been marked by your teacher.'
      : 'You have already submitted this task for marking.';
    return res.status(403).json({ error: reason });
  }

  // Read task context for the submission row
  const { data: task } = await supabase
    .from('tasks').select('id, question, course, class_id').eq('id', task_id as string).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  // Confirm the student is a member of the class
  const { data: member } = await supabase
    .from('class_members').select('class_id')
    .eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
  if (!member) return res.status(403).json({ error: 'You are not enrolled in this class.' });

  // Determine the next draft version (continues the existing per-task sequence)
  const { data: existingDrafts } = await supabase
    .from('submissions').select('draft_version')
    .eq('student_id', user.id).eq('task_id', task_id as string)
    .order('draft_version', { ascending: false }).limit(1);
  const nextVersion = (existingDrafts && existingDrafts[0]?.draft_version ? existingDrafts[0].draft_version : 0) + 1;

  const { error: insertErr } = await supabase.from('submissions').insert({
    student_id: user.id,
    task_id: task_id as string,
    question: task.question,
    course: task.course,
    draft_text: draftText,
    feedback: null,
    draft_version: nextVersion,
    submitted_for_marking: true,
    keystroke_count: typeof keystroke_count === 'number' ? keystroke_count : null,
    paste_attempts_blocked: typeof paste_attempts_blocked === 'number' ? paste_attempts_blocked : null,
    typing_session_count: typeof typing_session_count === 'number' ? typing_session_count : null,
    total_typing_time_ms: typeof total_typing_time_ms === 'number' ? total_typing_time_ms : null,
    time_to_first_keystroke_ms: typeof time_to_first_keystroke_ms === 'number' ? time_to_first_keystroke_ms : null,
  });
  if (insertErr) {
    captureError(insertErr, { stage: 'submit-for-marking-insert', task_id, user_id: user.id });
    return res.status(500).json({ error: 'Could not save your submission.' });
  }

  // Clear the in-progress autosave
  await supabase
    .from('draft_autosaves').delete()
    .eq('student_id', user.id).eq('task_id', task_id as string);

  return res.status(200).json({ ok: true, draft_version: nextVersion });
}
