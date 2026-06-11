import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { getSchoolTeacherIds, resolveInsightsAccess, listAllAuthUsers } from '../lib/schools.js';
import { getUserInfoBatch } from '../lib/user-names.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import {
  parseFiltersFromQuery,
  getTimeWindowCutoff,
  applyFacultyScope,
  userIdsForYearLevel,
} from '../lib/insights-filters.js';

/**
 * Detail lists for the KPI cards + card drill-downs.
 *
 *   GET /api/insights-detail?kind=teachers       → teachers in the school
 *   GET /api/insights-detail?kind=classes        → classes
 *   GET /api/insights-detail?kind=tasks          → tasks
 *   GET /api/insights-detail?kind=submissions    → submissions
 *
 * Common filters (applied across all kinds where applicable):
 *   faculty, course, class_id, year_level
 *
 * Drill-down filters:
 *   teacher_id      — limits to that teacher's data
 *   band            — submissions kind only: A/B/C/D/E grade band
 *   marking_status  — submissions kind only: marked / awaiting / unmarked
 *
 * Auth: explicit school_member or global-admin bypass (?school_id=).
 */

const BAND_THRESHOLDS = [
  { code: 'A', minPct: 90 },
  { code: 'B', minPct: 75 },
  { code: 'C', minPct: 50 },
  { code: 'D', minPct: 20 },
  { code: 'E', minPct: 0 },
];
function bandFor(awarded: number, total: number): string {
  if (!total || total <= 0) return 'E';
  const pct = (awarded / total) * 100;
  for (const b of BAND_THRESHOLDS) if (pct >= b.minPct) return b.code;
  return 'E';
}

export default withHandler({ methods: ['GET'], label: 'insights-detail' }, async (req, res, ctx) => {
  const user = ctx.user!;

  const kind = String(req.query.kind || '').trim();
  if (!['teachers', 'classes', 'tasks', 'submissions'].includes(kind)) {
    return res.status(400).json({ error: 'kind must be one of: teachers, classes, tasks, submissions' });
  }

  const supabase = getSupabase();
  const overrideId = (req.query.school_id as string) || null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, callerRole, restrictedFaculties } = access;

  const rawFilters = parseFiltersFromQuery(req.query as any);
  const filters = applyFacultyScope(rawFilters, restrictedFaculties);
  if (filters._denied) return res.status(200).json({ rows: [] });

  const drillTeacherId = (req.query.teacher_id as string || '').trim() || null;
  const drillBand = (req.query.band as string || '').trim().toUpperCase() || null;
  const drillMarking = (req.query.marking_status as string || '').trim() || null;
  if (drillBand && !['A', 'B', 'C', 'D', 'E'].includes(drillBand)) {
    return res.status(400).json({ error: 'band must be A, B, C, D, or E' });
  }
  if (drillMarking && !['marked', 'awaiting', 'unmarked'].includes(drillMarking)) {
    return res.status(400).json({ error: 'marking_status must be marked / awaiting / unmarked' });
  }

  const allUsers = await listAllAuthUsers(supabase);
  // Teacher tier sees only their own classes — same constraint as the
  // cards endpoint. ?class_id= they don't own falls out via the
  // teacher_id IN clause below.
  const teacherIds = callerRole === 'teacher'
    ? [user.id]
    : await getSchoolTeacherIds(supabase, schoolId, allUsers as any);
  if (teacherIds.length === 0) return res.status(200).json({ rows: [] });

  // Build the canonical maps once.
  const { data: rawClasses } = await supabase
    .from('classes').select('id, name, course, teacher_id, code, created_at').in('teacher_id', teacherIds);
  const classMap: Record<string, any> = {};
  (rawClasses || []).forEach(c => {
    classMap[c.id] = {
      ...c,
      faculty: c.course ? (getDisciplineForCourse(c.course) || 'Other') : 'Other',
    };
  });
  const classIds = Object.keys(classMap);
  if (classIds.length === 0) return res.status(200).json({ rows: [] });

  const { data: rawTasks } = await supabase
    .from('tasks')
    .select('id, title, course, class_id, total_marks, due_date, published_at, class_feedback_count, class_feedback_generated_at, created_at')
    .in('class_id', classIds);
  const taskMap: Record<string, any> = {};
  (rawTasks || []).forEach(t => {
    const cls = classMap[t.class_id];
    taskMap[t.id] = {
      ...t,
      faculty: t.course
        ? (getDisciplineForCourse(t.course) || cls?.faculty || 'Other')
        : (cls?.faculty || 'Other'),
    };
  });

  // CRITICAL: every match function must enforce the caller's faculty
  // scope. Without this guard, a leader restricted to PDHPE could pass
  // ?course=English%20Standard or ?class_id=<English-class> and pull
  // data outside their granted KLAs. We re-check the faculty against
  // the caller's restrictedFaculties on every row.
  const allowed = restrictedFaculties ? new Set(restrictedFaculties) : null;
  const inFacultyScope = (faculty: string) => !allowed || allowed.has(faculty);

  function classMatches(cls: any): boolean {
    if (!inFacultyScope(cls.faculty)) return false;
    if (filters.faculty && cls.faculty !== filters.faculty) return false;
    if (filters.course && cls.course !== filters.course) return false;
    if (filters.class_id && cls.id !== filters.class_id) return false;
    if (drillTeacherId && cls.teacher_id !== drillTeacherId) return false;
    return true;
  }
  function taskMatches(t: any): boolean {
    if (!inFacultyScope(t.faculty)) return false;
    if (filters.faculty && t.faculty !== filters.faculty) return false;
    if (filters.course && t.course !== filters.course) return false;
    if (filters.class_id && t.class_id !== filters.class_id) return false;
    if (drillTeacherId) {
      const cls = classMap[t.class_id];
      if (!cls || cls.teacher_id !== drillTeacherId) return false;
    }
    return true;
  }

  const filteredClasses = Object.values(classMap).filter(classMatches) as any[];
  const filteredTasks = Object.values(taskMap).filter(taskMatches) as any[];

  // Year-level filter applies at submission scope.
  const allowedStudentIds = filters.year_level != null
    ? userIdsForYearLevel(allUsers as any, filters.year_level)
    : null;

  const userLookup: Record<string, { name: string; email: string }> = {};
  (allUsers as any[]).forEach(u => {
    userLookup[u.id] = {
      name: u.user_metadata?.display_name || u.user_metadata?.full_name || u.email || 'Unknown',
      email: u.email || '',
    };
  });

  // -------- TEACHERS --------
  if (kind === 'teachers') {
    // If any filter is active, narrow teachers to those who own a class in
    // the filtered set. Otherwise return every school teacher.
    const hasFilter = !!(filters.faculty || filters.course || filters.class_id || drillTeacherId);
    let scopedTeacherIds: string[];
    if (hasFilter) {
      scopedTeacherIds = [...new Set(filteredClasses.map(c => c.teacher_id).filter(Boolean))] as string[];
    } else {
      scopedTeacherIds = teacherIds;
    }
    const { data: members } = await supabase
      .from('school_members').select('user_id, role').eq('school_id', schoolId);
    const roleByUser: Record<string, string> = {};
    (members || []).forEach(m => { if (m.user_id) roleByUser[m.user_id] = m.role; });

    const classCounts: Record<string, number> = {};
    const taskCountsByTeacher: Record<string, number> = {};
    filteredClasses.forEach(c => {
      if (!c.teacher_id) return;
      classCounts[c.teacher_id] = (classCounts[c.teacher_id] || 0) + 1;
    });
    filteredTasks.forEach(t => {
      const cls = classMap[t.class_id];
      if (cls?.teacher_id) taskCountsByTeacher[cls.teacher_id] = (taskCountsByTeacher[cls.teacher_id] || 0) + 1;
    });

    const rows = scopedTeacherIds.map(id => ({
      id,
      name: userLookup[id]?.name || '(unknown)',
      email: userLookup[id]?.email || '',
      role: roleByUser[id] || null,
      class_count: classCounts[id] || 0,
      task_count: taskCountsByTeacher[id] || 0,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json({ rows });
  }

  // -------- CLASSES --------
  if (kind === 'classes') {
    const taskCountsByClass: Record<string, number> = {};
    filteredTasks.forEach(t => { taskCountsByClass[t.class_id] = (taskCountsByClass[t.class_id] || 0) + 1; });
    const fcIds = filteredClasses.map(c => c.id);
    const studentCounts: Record<string, number> = {};
    if (fcIds.length > 0) {
      const { data: members } = await supabase
        .from('class_members').select('class_id').in('class_id', fcIds);
      (members || []).forEach(m => {
        if (m.class_id) studentCounts[m.class_id] = (studentCounts[m.class_id] || 0) + 1;
      });
    }
    const rows = filteredClasses.map(c => ({
      id: c.id,
      name: c.name || '(untitled)',
      course: c.course || '',
      code: c.code || '',
      faculty: c.faculty,
      teacher_name: c.teacher_id ? userLookup[c.teacher_id]?.name || '(unknown)' : '(unknown)',
      student_count: studentCounts[c.id] || 0,
      task_count: taskCountsByClass[c.id] || 0,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json({ rows });
  }

  // -------- TASKS --------
  if (kind === 'tasks') {
    const taskIds = filteredTasks.map(t => t.id);
    const subCounts: Record<string, number> = {};
    const cutoff = getTimeWindowCutoff(filters.time_window);
    if (taskIds.length > 0) {
      let q = supabase.from('submissions').select('task_id, created_at').in('task_id', taskIds);
      if (cutoff) q = q.gte('created_at', cutoff.toISOString());
      const { data: subs } = await q;
      (subs || []).forEach(s => { if (s.task_id) subCounts[s.task_id] = (subCounts[s.task_id] || 0) + 1; });
    }
    const rows = filteredTasks.map(t => {
      const cls = classMap[t.class_id] || {};
      return {
        id: t.id,
        title: t.title || '(untitled)',
        course: t.course || '',
        faculty: t.faculty,
        class_name: cls.name || '',
        teacher_name: cls.teacher_id ? userLookup[cls.teacher_id]?.name || '(unknown)' : '(unknown)',
        total_marks: t.total_marks,
        due_date: t.due_date,
        published: !!t.published_at,
        submission_count: subCounts[t.id] || 0,
        has_class_feedback: !!t.class_feedback_count,
        created_at: t.created_at,
      };
    }).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return res.status(200).json({ rows });
  }

  // -------- SUBMISSIONS --------
  if (kind === 'submissions') {
    const taskIds = filteredTasks.map(t => t.id);
    if (taskIds.length === 0) return res.status(200).json({ rows: [] });
    const cutoff = getTimeWindowCutoff(filters.time_window);
    let subQ = supabase
      .from('submissions')
      .select('id, task_id, student_id, draft_version, graded_at, total_mark, submitted_for_marking, created_at')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false });
    if (cutoff) subQ = subQ.gte('created_at', cutoff.toISOString());
    const { data: subs } = await subQ;

    let filtered = (subs || []).filter(s => {
      if (allowedStudentIds && (!s.student_id || !allowedStudentIds.has(s.student_id))) return false;
      if (drillMarking === 'marked' && !s.graded_at) return false;
      if (drillMarking === 'awaiting' && (s.graded_at || !s.submitted_for_marking)) return false;
      if (drillMarking === 'unmarked' && (s.graded_at || s.submitted_for_marking)) return false;
      if (drillBand) {
        if (!s.graded_at || s.total_mark == null) return false;
        const t = taskMap[s.task_id];
        if (!t || !t.total_marks) return false;
        if (bandFor(Number(s.total_mark), Number(t.total_marks)) !== drillBand) return false;
      }
      return true;
    });

    const TRUNCATE = 200;
    const truncated = filtered.length > TRUNCATE;
    if (truncated) filtered = filtered.slice(0, TRUNCATE);

    const rows = filtered.map(s => {
      const t = taskMap[s.task_id] || {};
      const cls = t.class_id ? classMap[t.class_id] : null;
      const totalMarks = t.total_marks;
      const band = (s.graded_at && s.total_mark != null && totalMarks)
        ? bandFor(Number(s.total_mark), Number(totalMarks))
        : null;
      return {
        id: s.id,
        task_id: s.task_id,
        task_title: t.title || '',
        course: t.course || '',
        faculty: t.faculty,
        class_name: cls?.name || '',
        student_name: s.student_id ? userLookup[s.student_id]?.name || '(unknown)' : '(anon)',
        draft_version: s.draft_version || 1,
        graded: !!s.graded_at,
        total_mark: s.total_mark,
        total_marks_max: totalMarks,
        band,
        submitted_for_marking: !!s.submitted_for_marking,
        created_at: s.created_at,
      };
    });
    return res.status(200).json({ rows, truncated_at: truncated ? TRUNCATE : null });
  }

  return res.status(400).json({ error: 'Unknown kind' });
});
