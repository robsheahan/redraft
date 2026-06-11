import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';

/**
 * "Data about the currently signed-in user" endpoint.
 *
 *   GET /api/me?resource=submissions              → student's submissions across all classes
 *   GET /api/me?resource=task-drafts&task_id=X    → student's drafts for one task
 *   GET /api/me?resource=results                  → student's full markbook: classes → tasks → latest submission
 *   GET /api/me?resource=teacher-markbook         → teacher's full markbook: classes → tasks + students + per-cell marks
 */

export default withHandler({ methods: ['GET'], label: 'me' }, async (req, res, { user }) => {
  const resource = (req.query.resource as string || '').trim();
  switch (resource) {
    case 'submissions':       return returnSubmissions(req, res, user!.id);
    case 'task-drafts':       return returnTaskDrafts(req, res, user!.id);
    case 'results':           return returnResults(req, res, user!.id);
    case 'teacher-markbook':  return returnTeacherMarkbook(req, res, user!.id);
    default:
      return res.status(400).json({ error: 'Unknown resource. Use ?resource=submissions|task-drafts|results|teacher-markbook' });
  }
});

async function returnSubmissions(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  // Explicit column list: skill_assessment (the per-dimension developmental
  // read) must never reach students — mirror returnTaskDrafts below.
  const { data, error } = await supabase
    .from('submissions')
    .select('id, task_id, own_task_id, own_task_title, own_task_class_id, draft_text, feedback, draft_version, created_at, question, course, criterion_marks, total_mark, teacher_comment, teacher_annotations, graded_at, graded_by, submitted_for_marking, working_lines, input_mode, student_attachments')
    .eq('student_id', userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const taskIds = [...new Set((data || []).map(s => s.task_id).filter(Boolean))] as string[];
  const taskMap: Record<string, { title: string | null; class_id: string | null; course: string | null }> = {};
  const classMap: Record<string, { name: string | null; course: string | null }> = {};
  if (taskIds.length > 0) {
    const { data: tasks } = await supabase
      .from('tasks').select('id, title, class_id, course').in('id', taskIds);
    (tasks || []).forEach(t => { taskMap[t.id] = { title: t.title, class_id: t.class_id, course: t.course }; });
    const classIds = [...new Set((tasks || []).map(t => t.class_id).filter(Boolean))] as string[];
    if (classIds.length > 0) {
      const { data: classes } = await supabase.from('classes').select('id, name, course').in('id', classIds);
      (classes || []).forEach(c => { classMap[c.id] = { name: c.name, course: c.course }; });
    }
  }

  const enriched = (data || []).map(s => {
    const t = s.task_id ? taskMap[s.task_id] : null;
    const cls = t?.class_id ? classMap[t.class_id] : null;
    return {
      ...s,
      task_title: t?.title || null,
      class_id: t?.class_id || null,
      class_name: cls?.name || null,
      course: s.course || t?.course || cls?.course || null,
    };
  });
  return res.status(200).json(enriched);
}

async function returnResults(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  const { data: memberRows, error: memErr } = await supabase
    .from('class_members').select('class_id').eq('student_id', userId);
  if (memErr) return res.status(500).json({ error: memErr.message });
  const classIds = (memberRows || []).map(r => r.class_id);
  if (classIds.length === 0) return res.status(200).json({ classes: [] });

  const { data: classes, error: clsErr } = await supabase
    .from('classes')
    .select('id, name, course, teacher_id')
    .in('id', classIds)
    .order('name', { ascending: true });
  if (clsErr) return res.status(500).json({ error: clsErr.message });

  const teacherIds = [...new Set((classes || []).map(c => c.teacher_id).filter(Boolean))] as string[];
  const teacherNameById: Record<string, string> = {};
  if (teacherIds.length > 0) {
    const { getUserInfoBatch } = await import('../lib/user-names.js');
    const info = await getUserInfoBatch(supabase, teacherIds);
    Object.entries(info).forEach(([id, v]) => { teacherNameById[id] = v?.name || ''; });
  }

  const { data: tasks, error: tasksErr } = await supabase
    .from('tasks')
    .select('id, class_id, title, question, course, total_marks, due_date, published_at, criteria_structured, criteria_text, hide_criteria_from_students, subject_type, marking_guideline')
    .in('class_id', classIds)
    .not('published_at', 'is', null)
    .order('due_date', { ascending: true });
  if (tasksErr) return res.status(500).json({ error: tasksErr.message });

  const taskIds = (tasks || []).map(t => t.id);
  let submissionsByTask: Record<string, any> = {};
  if (taskIds.length > 0) {
    const { data: subs, error: subsErr } = await supabase
      .from('submissions')
      .select('id, task_id, draft_version, created_at, total_mark, criterion_marks, graded_at, teacher_comment, submitted_for_marking')
      .eq('student_id', userId)
      .in('task_id', taskIds)
      .order('draft_version', { ascending: false });
    if (subsErr) return res.status(500).json({ error: subsErr.message });
    (subs || []).forEach(s => {
      // Preference order for "the submission to display": graded > submitted-for-marking > latest.
      const existing = submissionsByTask[s.task_id];
      if (!existing) {
        submissionsByTask[s.task_id] = s;
      } else if (s.graded_at && !existing.graded_at) {
        submissionsByTask[s.task_id] = s;
      } else if (s.submitted_for_marking && !existing.graded_at && !existing.submitted_for_marking) {
        submissionsByTask[s.task_id] = s;
      }
    });
  }

  const tasksByClass: Record<string, any[]> = {};
  (tasks || []).forEach(t => {
    if (!tasksByClass[t.class_id]) tasksByClass[t.class_id] = [];
    const sub = submissionsByTask[t.id] || null;
    const isGraded = !!(sub && sub.graded_at);
    // Strip rubric / marking guideline until the student's own submission
    // has been graded. Once graded, both reveal so the post-grading view
    // can render per-criterion breakdown (essays) or marking guideline (maths).
    const hideEssayRubric = !!t.hide_criteria_from_students && !isGraded;
    const hideMathsGuideline = t.subject_type === 'maths' && !isGraded;
    const taskOut = (hideEssayRubric || hideMathsGuideline)
      ? {
          ...t,
          criteria_text: hideEssayRubric ? null : t.criteria_text,
          criteria_structured: hideEssayRubric ? null : t.criteria_structured,
          marking_guideline: hideMathsGuideline ? null : t.marking_guideline,
        }
      : t;
    tasksByClass[t.class_id].push({
      ...taskOut,
      submission: sub,
    });
  });

  const result = (classes || []).map(c => ({
    id: c.id,
    name: c.name,
    course: c.course,
    teacher_name: c.teacher_id ? (teacherNameById[c.teacher_id] || null) : null,
    tasks: tasksByClass[c.id] || [],
  }));

  return res.status(200).json({ classes: result });
}

async function returnTeacherMarkbook(_req: VercelRequest, res: VercelResponse, userId: string) {
  const supabase = getSupabase();

  const { data: classes, error: clsErr } = await supabase
    .from('classes')
    .select('id, name, course, archived_at')
    .eq('teacher_id', userId)
    .order('name', { ascending: true });
  if (clsErr) return res.status(500).json({ error: clsErr.message });
  const liveClasses = (classes || []).filter(c => !c.archived_at);
  if (liveClasses.length === 0) return res.status(200).json({ classes: [] });

  const classIds = liveClasses.map(c => c.id);

  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, class_id, title, question, total_marks, due_date')
    .in('class_id', classIds)
    .not('published_at', 'is', null)
    .order('due_date', { ascending: true, nullsFirst: false });

  const { data: memberRows } = await supabase
    .from('class_members').select('class_id, student_id').in('class_id', classIds);

  const studentIds = [...new Set((memberRows || []).map(m => m.student_id))] as string[];
  const { getUserInfoBatch } = await import('../lib/user-names.js');
  const userInfo = studentIds.length ? await getUserInfoBatch(supabase, studentIds) : {};

  const taskIds = (tasks || []).map(t => t.id);
  type CellEntry = {
    submission_id: string;
    total_mark: number | null;
    graded_at: string | null;
    submitted_for_marking: boolean;
  };
  const cellByTaskStudent: Record<string, Record<string, CellEntry>> = {};
  if (taskIds.length > 0) {
    const { data: subs } = await supabase
      .from('submissions')
      .select('id, task_id, student_id, draft_version, total_mark, graded_at, submitted_for_marking, created_at')
      .in('task_id', taskIds)
      .order('draft_version', { ascending: false });
    (subs || []).forEach((s: any) => {
      if (!s.task_id || !s.student_id) return;
      if (!cellByTaskStudent[s.task_id]) cellByTaskStudent[s.task_id] = {};
      const existing = cellByTaskStudent[s.task_id][s.student_id];
      // Priority: graded > submitted-for-marking > latest.
      const incomingPriority = s.graded_at ? 3 : (s.submitted_for_marking ? 2 : 1);
      const existingPriority = !existing ? 0 : (existing.graded_at ? 3 : (existing.submitted_for_marking ? 2 : 1));
      if (incomingPriority > existingPriority) {
        cellByTaskStudent[s.task_id][s.student_id] = {
          submission_id: s.id,
          total_mark: s.total_mark ?? null,
          graded_at: s.graded_at || null,
          submitted_for_marking: !!s.submitted_for_marking,
        };
      }
    });
  }

  const result = liveClasses.map(c => {
    const classTasks = (tasks || []).filter(t => t.class_id === c.id);
    const classMembers = (memberRows || []).filter(m => m.class_id === c.id);
    const sortedMembers = classMembers
      .map(m => ({ id: m.student_id, name: userInfo[m.student_id]?.name || 'Unknown student' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }));
    return {
      id: c.id,
      name: c.name,
      course: c.course,
      tasks: classTasks.map(t => ({
        id: t.id,
        title: t.title || t.question || 'Untitled',
        total_marks: t.total_marks,
        due_date: t.due_date,
      })),
      students: sortedMembers.map(stu => ({
        id: stu.id,
        name: stu.name,
        cells: classTasks.map(t => cellByTaskStudent[t.id]?.[stu.id] || null),
      })),
    };
  });

  return res.status(200).json({ classes: result });
}

async function returnTaskDrafts(req: VercelRequest, res: VercelResponse, userId: string) {
  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('submissions')
    .select('id, draft_text, feedback, draft_version, created_at, question, course, criterion_marks, total_mark, teacher_comment, teacher_annotations, graded_at, graded_by, submitted_for_marking, working_lines, input_mode, student_attachments')
    .eq('student_id', userId)
    .eq('task_id', taskId)
    .order('draft_version', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ drafts: data || [] });
}
