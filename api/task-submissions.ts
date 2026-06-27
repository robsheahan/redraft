import { getUserInfoBatch } from '../lib/user-names.js';
import { withHandler } from '../lib/with-handler.js';

/**
 * Teacher view of all submissions for one of their tasks.
 * Authorised iff the task belongs to a class the teacher owns.
 */

export default withHandler({ methods: ['GET'], label: 'task-submissions' }, async (req, res, { user, supabase }) => {
  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const { data: task } = await supabase
    .from('tasks').select('*, classes(teacher_id, name, course)').eq('id', taskId).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (task.classes as any)?.teacher_id;
  if (teacherId !== user!.id) return res.status(403).json({ error: 'Not authorised.' });

  const { data: submissions, error } = await supabase
    .from('submissions').select('*').eq('task_id', taskId).order('created_at', { ascending: false });
  if (error) throw error;

  // Lesson Builder: gather per-student differentiated activities + the full
  // enrolled list (so the teacher also sees students who haven't opened yet).
  let memberIds: string[] = [];
  const actByStudent: Record<string, any> = {};
  if (task.lesson_builder) {
    const { data: members } = await supabase
      .from('class_members').select('student_id').eq('class_id', task.class_id);
    memberIds = (members || []).map((m: any) => m.student_id).filter(Boolean);
    const { data: actRows } = await supabase
      .from('task_activities').select('student_id, is_differentiated, activity').eq('task_id', taskId);
    (actRows || []).forEach((a: any) => { actByStudent[a.student_id] = a; });
  }

  const subStudentIds = (submissions || []).map(s => s.student_id).filter(Boolean) as string[];
  const allIds = [...new Set([...subStudentIds, ...memberIds])];
  const userInfo = await getUserInfoBatch(supabase, allIds);

  const enriched = (submissions || []).map(s => ({
    ...s,
    student_name: userInfo[s.student_id]?.name || 'Unknown student',
  }));

  const activities = task.lesson_builder
    ? memberIds.map((sid) => {
        const a = actByStudent[sid];
        return {
          student_id: sid,
          student_name: userInfo[sid]?.name || 'Unknown student',
          status: !a ? 'not_started' : (a.is_differentiated ? 'differentiated' : 'main'),
          activity: a && a.is_differentiated ? a.activity : null,
        };
      }).sort((x, y) => x.student_name.localeCompare(y.student_name))
    : null;

  // "started" gates in-place task editing: a student has begun working (a
  // submission OR an in-progress autosaved draft) → the task's content locks.
  let started = (submissions || []).length > 0;
  if (!started) {
    const { count } = await supabase
      .from('draft_autosaves').select('task_id', { count: 'exact', head: true }).eq('task_id', taskId);
    started = (count || 0) > 0;
  }

  return res.status(200).json({ task, submissions: enriched, activities, started });
});
