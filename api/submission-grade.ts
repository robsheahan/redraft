import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { postCompletionIfLinked } from '../lib/lti/ags.js';
import { captureError } from '../lib/sentry.js';
import { withHandler } from '../lib/with-handler.js';
import { mergeExamGrade } from '../lib/exam-submission.js';

export default withHandler({ methods: ['PUT'], label: 'submission-grade' }, async (req, res, ctx) => {
  const user = ctx.user!;

  const {
    submission_id,
    criterion_marks,
    total_mark,
    question_marks,
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
    .select('id, task_id, student_id, graded_at, answers, question_marks, tasks(class_id, total_marks, classes(teacher_id))')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr || !submission) return res.status(404).json({ error: 'Submission not found.' });

  const teacherId = (submission.tasks as any)?.classes?.teacher_id;
  if (teacherId !== user.id) {
    return res.status(403).json({ error: 'Only the class teacher can grade this submission.' });
  }

  // Multi-question exam grading. The teacher marks the TEXT questions only; the
  // MC rows were auto-marked at submit (source:'auto') and are preserved as-is.
  // The total is computed server-side as the sum of all marks — the client's
  // total_mark is ignored for exams.
  const examAnswers: any[] | null = Array.isArray((submission as any).answers) && (submission as any).answers.length > 0
    ? (submission as any).answers
    : null;
  const isExamGrade = !!examAnswers;
  let mergedQuestionMarks: any[] | null = null;
  let computedTotal: number | null = null;
  if (isExamGrade) {
    const merged = mergeExamGrade(examAnswers!, (submission as any).question_marks, question_marks);
    if ('error' in merged) return res.status(400).json({ error: merged.error });
    mergedQuestionMarks = merged.questionMarks;
    computedTotal = merged.total;
  }

  // Keep only annotations that anchor to a real answer (exam) — defensive against
  // a stale client. Non-exam annotations pass through unchanged.
  const cleanAnnotations = (isExamGrade && Array.isArray(teacher_annotations))
    ? teacher_annotations.filter((a: any) => !a?.question_id || examAnswers!.some((ans) => ans.question_id === a.question_id))
    : (teacher_annotations ?? null);

  const effectiveTotal = isExamGrade ? computedTotal : (total_mark ?? null);

  const patch: Record<string, unknown> = {
    criterion_marks: isExamGrade ? null : (criterion_marks ?? null),
    total_mark: effectiveTotal,
    teacher_comment: teacher_comment ?? null,
    teacher_annotations: cleanAnnotations,
    completion_status: isExamGrade ? null : (completion_status ?? null),
    graded_by: user.id,
  };
  if (isExamGrade) patch.question_marks = mergedQuestionMarks;
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
  if (typeof effectiveTotal === 'number' && typeof taskTotalMarks === 'number' && taskTotalMarks > 0) {
    // Await before responding — on Vercel the instance freezes once the response
    // is sent, which would tear down this in-flight passback socket (surfaces as
    // `write ETIMEDOUT` / `fetch failed`). The .catch keeps it non-fatal.
    await postCompletionIfLinked({
      taskId: submission.task_id as string,
      studentId: submission.student_id as string,
      scoreGiven: effectiveTotal,
      scoreMaximum: taskTotalMarks,
      comment: `Graded by teacher: ${effectiveTotal}/${taskTotalMarks}`,
    }).catch(err => captureError(err, { stage: 'ags-grade-passback', submission_id }));
  }

  return res.status(200).json({ ok: true });
});
