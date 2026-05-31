import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';
import { captureError } from '../lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const {
    submission_id,
    criterion_marks,
    total_mark,
    teacher_comment,
    teacher_annotations,
    completion_status,
  } = req.body || {};

  if (!submission_id) return res.status(400).json({ error: 'submission_id is required.' });
  if (total_mark != null && typeof total_mark !== 'number') {
    return res.status(400).json({ error: 'total_mark must be a number.' });
  }
  if (teacher_annotations != null && !Array.isArray(teacher_annotations)) {
    return res.status(400).json({ error: 'teacher_annotations must be an array.' });
  }
  if (completion_status != null && completion_status !== 'completed') {
    return res.status(400).json({ error: 'completion_status must be "completed" or null.' });
  }

  const supabase = getSupabase();

  const { data: submission, error: subErr } = await supabase
    .from('submissions')
    .select('id, task_id, student_id, graded_at, tasks(class_id, total_marks, classes(teacher_id))')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr || !submission) return res.status(404).json({ error: 'Submission not found.' });

  const teacherId = (submission.tasks as any)?.classes?.teacher_id;
  if (teacherId !== user.id) {
    return res.status(403).json({ error: 'Only the class teacher can grade this submission.' });
  }

  const patch: Record<string, unknown> = {
    criterion_marks: criterion_marks ?? null,
    total_mark: total_mark ?? null,
    teacher_comment: teacher_comment ?? null,
    teacher_annotations: teacher_annotations ?? null,
    completion_status: completion_status ?? null,
    graded_by: user.id,
  };
  if (!submission.graded_at) patch.graded_at = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('submissions').update(patch).eq('id', submission_id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await supabase
    .from('draft_autosaves')
    .delete()
    .eq('student_id', submission.student_id)
    .eq('task_id', submission.task_id);

  // Mark the longitudinal profile stale (kept, not deleted) — new marking data
  // means the read path should refresh it on next individual view, while the
  // class summary keeps the last-known-good row in the meantime.
  const { error: profileCacheErr } = await supabase
    .from('student_profile_synthesis')
    .update({ stale: true })
    .eq('student_id', submission.student_id);
  if (profileCacheErr) {
    captureError(new Error(profileCacheErr.message), { stage: 'profile-cache-invalidate', submission_id });
  }

  const taskTotalMarks = (submission.tasks as any)?.total_marks;
  if (typeof total_mark === 'number' && typeof taskTotalMarks === 'number' && taskTotalMarks > 0) {
    postCompletionIfLinked({
      taskId: submission.task_id as string,
      studentId: submission.student_id as string,
      scoreGiven: total_mark,
      scoreMaximum: taskTotalMarks,
      comment: `Graded by teacher: ${total_mark}/${taskTotalMarks}`,
    }).catch(err => captureError(err, { stage: 'ags-grade-passback', submission_id }));
  }

  return res.status(200).json({ ok: true });
}
