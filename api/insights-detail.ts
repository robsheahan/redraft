import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { resolveUserSchool, getSchoolTeacherIds, canViewInsights } from '../lib/schools.js';
import { getUserInfoBatch } from '../lib/user-names.js';
import { isGlobalAdmin } from '../lib/admin.js';

/**
 * Detail lists for the leadership insights KPI cards.
 *
 *   GET /api/insights-detail?kind=teachers   → teachers in the school
 *   GET /api/insights-detail?kind=classes    → classes in the school
 *   GET /api/insights-detail?kind=tasks      → tasks in the school
 *   GET /api/insights-detail?kind=submissions→ submissions in the school
 *
 * Auth: same as /api/insights-synthesis — explicit school_member or
 * global-admin bypass (via lib/admin.ts) with ?school_id=.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const kind = String(req.query.kind || '').trim();
  if (!['teachers', 'classes', 'tasks', 'submissions'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be one of: teachers, classes, tasks, submissions' });
  }

  const supabase = getSupabase();

  let schoolId: string | null = null;
  const overrideId = (req.query.school_id as string) || null;
  if (overrideId && isGlobalAdmin(user)) {
    schoolId = overrideId;
  } else {
    const ctx = await resolveUserSchool(supabase, user.id);
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const allowed = ctx.role !== null
      || await canViewInsights(supabase, user.id, ctx.school_id)
      || isGlobalAdmin(user);
    if (!allowed) return res.status(404).json({ error: 'Not found' });
    schoolId = ctx.school_id;
  }

  const teacherIds = await getSchoolTeacherIds(supabase, schoolId);
  if (teacherIds.length === 0) {
    return res.status(200).json({ rows: [] });
  }

  if (kind === 'teachers') {
    const lookup = await getUserInfoBatch(supabase, teacherIds);
    const { data: classes } = await supabase
      .from('classes').select('id, teacher_id').in('teacher_id', teacherIds);
    const classCounts: Record<string, number> = {};
    const classIdsByTeacher: Record<string, string[]> = {};
    (classes || []).forEach(c => {
      if (!c.teacher_id) return;
      classCounts[c.teacher_id] = (classCounts[c.teacher_id] || 0) + 1;
      (classIdsByTeacher[c.teacher_id] ||= []).push(c.id);
    });
    const allClassIds = (classes || []).map(c => c.id);
    const taskCounts: Record<string, number> = {};
    if (allClassIds.length > 0) {
      const { data: tasks } = await supabase
        .from('tasks').select('class_id').in('class_id', allClassIds);
      const tasksPerClass: Record<string, number> = {};
      (tasks || []).forEach(t => {
        if (t.class_id) tasksPerClass[t.class_id] = (tasksPerClass[t.class_id] || 0) + 1;
      });
      Object.entries(classIdsByTeacher).forEach(([tid, cids]) => {
        taskCounts[tid] = cids.reduce((sum, cid) => sum + (tasksPerClass[cid] || 0), 0);
      });
    }
    const { data: members } = await supabase
      .from('school_members').select('user_id, role').eq('school_id', schoolId);
    const roleByUser: Record<string, string> = {};
    (members || []).forEach(m => { if (m.user_id) roleByUser[m.user_id] = m.role; });

    const rows = teacherIds.map(id => ({
      id,
      name: lookup[id]?.name || lookup[id]?.email || '(unknown)',
      email: lookup[id]?.email || '',
      role: roleByUser[id] || null,
      class_count: classCounts[id] || 0,
      task_count: taskCounts[id] || 0,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json({ rows });
  }

  if (kind === 'classes') {
    const { data: classes } = await supabase
      .from('classes').select('id, name, course, teacher_id, code, created_at')
      .in('teacher_id', teacherIds)
      .order('name');
    const lookup = await getUserInfoBatch(supabase, teacherIds);
    const classIds = (classes || []).map(c => c.id);
    const studentCounts: Record<string, number> = {};
    const taskCounts: Record<string, number> = {};
    if (classIds.length > 0) {
      const { data: members } = await supabase
        .from('class_members').select('class_id').in('class_id', classIds);
      (members || []).forEach(m => {
        if (m.class_id) studentCounts[m.class_id] = (studentCounts[m.class_id] || 0) + 1;
      });
      const { data: tasks } = await supabase
        .from('tasks').select('class_id').in('class_id', classIds);
      (tasks || []).forEach(t => {
        if (t.class_id) taskCounts[t.class_id] = (taskCounts[t.class_id] || 0) + 1;
      });
    }
    const rows = (classes || []).map(c => ({
      id: c.id,
      name: c.name || '(untitled)',
      course: c.course || '',
      code: c.code || '',
      teacher_name: c.teacher_id ? lookup[c.teacher_id]?.name || '(unknown)' : '(unknown)',
      student_count: studentCounts[c.id] || 0,
      task_count: taskCounts[c.id] || 0,
    }));
    return res.status(200).json({ rows });
  }

  if (kind === 'tasks') {
    const { data: classes } = await supabase
      .from('classes').select('id, name, teacher_id').in('teacher_id', teacherIds);
    const classMap: Record<string, { name: string; teacher_id: string | null }> = {};
    (classes || []).forEach(c => { classMap[c.id] = { name: c.name || '', teacher_id: c.teacher_id }; });
    const classIds = Object.keys(classMap);
    if (classIds.length === 0) return res.status(200).json({ rows: [] });

    const { data: tasks } = await supabase
      .from('tasks')
      .select('id, title, course, class_id, total_marks, due_date, published_at, class_feedback_count, class_feedback_generated_at, created_at')
      .in('class_id', classIds)
      .order('created_at', { ascending: false });

    const taskIds = (tasks || []).map(t => t.id);
    const subCounts: Record<string, number> = {};
    if (taskIds.length > 0) {
      const { data: subs } = await supabase
        .from('submissions').select('task_id').in('task_id', taskIds);
      (subs || []).forEach(s => {
        if (s.task_id) subCounts[s.task_id] = (subCounts[s.task_id] || 0) + 1;
      });
    }
    const lookup = await getUserInfoBatch(supabase, teacherIds);

    const rows = (tasks || []).map(t => {
      const cls = classMap[t.class_id] || { name: '', teacher_id: null };
      return {
        id: t.id,
        title: t.title || '(untitled)',
        course: t.course || '',
        class_name: cls.name,
        teacher_name: cls.teacher_id ? lookup[cls.teacher_id]?.name || '(unknown)' : '(unknown)',
        total_marks: t.total_marks,
        due_date: t.due_date,
        published: !!t.published_at,
        submission_count: subCounts[t.id] || 0,
        has_class_feedback: !!t.class_feedback_count,
        created_at: t.created_at,
      };
    });
    return res.status(200).json({ rows });
  }

  if (kind === 'submissions') {
    const { data: classes } = await supabase
      .from('classes').select('id').in('teacher_id', teacherIds);
    const classIds = (classes || []).map(c => c.id);
    if (classIds.length === 0) return res.status(200).json({ rows: [] });
    const { data: tasks } = await supabase
      .from('tasks').select('id, title, course, class_id').in('class_id', classIds);
    const taskMap: Record<string, { title: string; course: string }> = {};
    (tasks || []).forEach(t => { taskMap[t.id] = { title: t.title || '', course: t.course || '' }; });
    const taskIds = Object.keys(taskMap);
    if (taskIds.length === 0) return res.status(200).json({ rows: [] });

    const { data: subs } = await supabase
      .from('submissions')
      .select('id, task_id, student_id, draft_version, graded_at, total_mark, submitted_for_marking, created_at')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false })
      .limit(200);
    const studentIds = [...new Set((subs || []).map(s => s.student_id).filter(Boolean))] as string[];
    const lookup = await getUserInfoBatch(supabase, studentIds);

    const rows = (subs || []).map(s => {
      const t = taskMap[s.task_id] || { title: '', course: '' };
      return {
        id: s.id,
        task_id: s.task_id,
        task_title: t.title,
        course: t.course,
        student_name: s.student_id ? lookup[s.student_id]?.name || '(unknown)' : '(anon)',
        draft_version: s.draft_version || 1,
        graded: !!s.graded_at,
        total_mark: s.total_mark,
        submitted_for_marking: !!s.submitted_for_marking,
        created_at: s.created_at,
      };
    });
    return res.status(200).json({ rows, truncated_at: 200 });
  }

  return res.status(400).json({ error: 'Unknown kind' });
}
