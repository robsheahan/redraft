import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import {
  getSchoolTeacherIds,
  resolveInsightsAccess,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';

/**
 * Returns the populated card data for the school insights dashboard.
 * Every card is server-computed in a single round-trip so the UI can
 * render a populated grid on first paint (no client-side aggregation).
 *
 * Faculty scope is applied server-side: leaders restricted to specific
 * NSW KLAs only see data for tasks in those faculties. For a restricted
 * leader with exactly one faculty, the Faculty Engagement card switches
 * to a per-class breakdown (a single-bar chart isn't useful), and the
 * Mark Distribution by Faculty card is hidden entirely.
 *
 * Each card has its own empty shape so the UI can show a structural
 * skeleton on day one before any data exists.
 */

const NESA_BANDS = [
  { code: 'A', label: 'Outstanding', minPct: 90 },
  { code: 'B', label: 'High',        minPct: 75 },
  { code: 'C', label: 'Sound',       minPct: 50 },
  { code: 'D', label: 'Basic',       minPct: 20 },
  { code: 'E', label: 'Elementary',  minPct: 0  },
];

function bandFor(awarded: number, total: number): string {
  if (!total || total <= 0) return 'E';
  const pct = (awarded / total) * 100;
  for (const b of NESA_BANDS) if (pct >= b.minPct) return b.code;
  return 'E';
}

// Week-start (Monday) UTC-ish; we just need stable buckets, not timezones.
function weekStart(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday-based
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();
  const overrideId = (req.query.school_id as string) || null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, schoolName, callerRole, restrictedFaculties } = access;

  // Share the listUsers fetch across helpers — same pattern as admin-stats.
  const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const teacherIds = await getSchoolTeacherIds(supabase, schoolId, allUsers as any);

  const userInfo: Record<string, { name: string; email: string }> = {};
  (allUsers as any[]).forEach(u => {
    userInfo[u.id] = {
      name: u.user_metadata?.display_name || u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Unknown',
      email: u.email || '',
    };
  });

  if (teacherIds.length === 0) {
    return res.status(200).json(emptyResponse(schoolId, schoolName, callerRole, restrictedFaculties));
  }

  const { data: rawClasses } = await supabase
    .from('classes')
    .select('id, name, course, teacher_id')
    .in('teacher_id', teacherIds);

  const classIds = (rawClasses || []).map(c => c.id);
  if (classIds.length === 0) {
    return res.status(200).json(emptyResponse(schoolId, schoolName, callerRole, restrictedFaculties));
  }

  const { data: rawTasks } = await supabase
    .from('tasks')
    .select('id, title, class_id, course, total_marks, published_at, created_at, class_feedback_count')
    .in('class_id', classIds);

  const taskIds = (rawTasks || []).map(t => t.id);
  const { data: rawSubs } = taskIds.length > 0
    ? await supabase
      .from('submissions')
      .select('id, task_id, student_id, draft_version, graded_at, total_mark, created_at, submitted_for_marking')
      .in('task_id', taskIds)
    : { data: [] as any[] };

  // Tag classes + tasks with faculty (from course → NESA discipline).
  const classMap: Record<string, { id: string; name: string; course: string; teacher_id: string; faculty: string }> = {};
  (rawClasses || []).forEach(c => {
    const faculty = c.course ? (getDisciplineForCourse(c.course) || 'Other') : 'Other';
    classMap[c.id] = {
      id: c.id,
      name: c.name || '',
      course: c.course || '',
      teacher_id: c.teacher_id || '',
      faculty,
    };
  });

  const taskMap: Record<string, any> = {};
  (rawTasks || []).forEach(t => {
    const cls = classMap[t.class_id];
    const faculty = t.course
      ? (getDisciplineForCourse(t.course) || cls?.faculty || 'Other')
      : (cls?.faculty || 'Other');
    taskMap[t.id] = {
      id: t.id,
      title: t.title || '',
      class_id: t.class_id,
      course: t.course || '',
      total_marks: t.total_marks,
      published_at: t.published_at,
      created_at: t.created_at,
      faculty,
      has_class_feedback: !!t.class_feedback_count,
    };
  });

  // Apply faculty scope.
  const allowed = restrictedFaculties ? new Set(restrictedFaculties) : null;
  const inScope = (faculty: string) => !allowed || allowed.has(faculty);

  const tasks = Object.values(taskMap).filter((t: any) => inScope(t.faculty)) as any[];
  const tasksInScopeIds = new Set(tasks.map(t => t.id));
  const classesInScope = Object.values(classMap)
    .filter((c: any) => tasks.some(t => t.class_id === c.id)) as any[];
  const teachersInScopeIds = new Set(classesInScope.map(c => c.teacher_id).filter(Boolean));
  const submissions = (rawSubs || []).filter(s => tasksInScopeIds.has(s.task_id));

  // -- Card: Activity sparkline (last 12 weeks) --
  const activity = computeActivity(submissions);

  // -- Card: Faculty engagement (or Class engagement if restricted to 1 faculty) --
  const engagement = (allowed && allowed.size === 1)
    ? computeClassEngagement([...allowed][0], classesInScope, tasks, submissions, userInfo)
    : computeFacultyEngagement(classesInScope, tasks, submissions);

  // -- Card: Mark distribution (A–E) --
  const markDistribution = computeMarkDistribution(submissions, taskMap);

  // -- Card: Mark distribution by faculty (hidden when only one in scope) --
  const facultiesInScope = new Set(tasks.map(t => t.faculty));
  const showMarkByFaculty = facultiesInScope.size > 1;
  const markByFaculty = showMarkByFaculty
    ? computeMarkByFaculty(submissions, taskMap)
    : null;

  // -- Card: Marking progress (submissions marked vs unmarked) --
  const marked = submissions.filter(s => s.graded_at).length;
  const submittedForMarking = submissions.filter(s => s.submitted_for_marking && !s.graded_at).length;
  const marking = {
    total: submissions.length,
    marked,
    awaiting_marking: submittedForMarking,
    unmarked: submissions.length - marked - submittedForMarking,
  };

  // -- Card: Teacher activity --
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const teacherActivity = [...teachersInScopeIds].map(tid => {
    const tClasses = classesInScope.filter(c => c.teacher_id === tid);
    const tClassIds = new Set(tClasses.map(c => c.id));
    const tTasks = tasks.filter(t => tClassIds.has(t.class_id));
    const tSubs = submissions.filter(s => {
      const t = taskMap[s.task_id];
      return t && tClassIds.has(t.class_id);
    });
    const lastActivity = [
      ...tTasks.map(t => t.created_at),
      ...tSubs.map(s => s.created_at),
    ].filter(Boolean).sort();
    const lastActive = lastActivity.length ? lastActivity[lastActivity.length - 1] : null;
    const tasksLast30d = tTasks.filter(t => t.created_at && t.created_at >= cutoff30d).length;
    return {
      teacher_id: tid,
      name: userInfo[tid]?.name || '(unknown)',
      email: userInfo[tid]?.email || '',
      class_count: tClasses.length,
      task_count: tTasks.length,
      tasks_last_30d: tasksLast30d,
      last_active: lastActive,
    };
  }).sort((a, b) => {
    if (!a.last_active && !b.last_active) return (a.name || '').localeCompare(b.name || '');
    if (!a.last_active) return 1;
    if (!b.last_active) return -1;
    return b.last_active.localeCompare(a.last_active);
  });

  // -- Counts (header KPI strip) --
  const counts = {
    teachers: teachersInScopeIds.size,
    classes: classesInScope.length,
    tasks: tasks.length,
    submissions: submissions.length,
    tasks_with_class_feedback: tasks.filter(t => t.has_class_feedback).length,
  };

  return res.status(200).json({
    school: { id: schoolId, name: schoolName },
    caller_role: callerRole,
    restricted_faculties: restrictedFaculties,
    scope: restrictedFaculties
      ? { type: 'faculty', faculties: restrictedFaculties }
      : { type: 'school' },
    cards: {
      activity,
      engagement,
      mark_distribution: markDistribution,
      mark_by_faculty: markByFaculty,
      marking,
      teacher_activity: teacherActivity,
    },
    counts,
  });
}

function computeActivity(submissions: any[]) {
  const weeks: { week_start: string; count: number }[] = [];
  const now = new Date();
  const buckets: Record<string, number> = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = weekStart(d).toISOString().slice(0, 10);
    buckets[key] = 0;
    weeks.push({ week_start: key, count: 0 });
  }
  submissions.forEach(s => {
    if (!s.created_at) return;
    const key = weekStart(new Date(s.created_at)).toISOString().slice(0, 10);
    if (key in buckets) buckets[key]++;
  });
  weeks.forEach(w => { w.count = buckets[w.week_start] || 0; });
  return { weeks, total_in_window: weeks.reduce((a, w) => a + w.count, 0) };
}

function computeFacultyEngagement(classes: any[], tasks: any[], submissions: any[]) {
  const map: Record<string, {
    faculty: string;
    teachers: Set<string>;
    classes: Set<string>;
    task_count: number;
    submission_count: number;
  }> = {};
  const ensure = (f: string) => {
    map[f] ||= { faculty: f, teachers: new Set(), classes: new Set(), task_count: 0, submission_count: 0 };
    return map[f];
  };
  classes.forEach(c => {
    const e = ensure(c.faculty);
    if (c.teacher_id) e.teachers.add(c.teacher_id);
    e.classes.add(c.id);
  });
  tasks.forEach(t => { ensure(t.faculty).task_count++; });
  submissions.forEach(s => {
    // task lookup via class faculty already known on the task in scope; we
    // get the faculty via the joined tasks array
    const t = tasks.find(x => x.id === s.task_id);
    if (t) ensure(t.faculty).submission_count++;
  });
  return {
    mode: 'faculty',
    rows: Object.values(map).map(v => ({
      faculty: v.faculty,
      teacher_count: v.teachers.size,
      class_count: v.classes.size,
      task_count: v.task_count,
      submission_count: v.submission_count,
    })).sort((a, b) => b.submission_count - a.submission_count),
  };
}

function computeClassEngagement(
  faculty: string,
  classes: any[],
  tasks: any[],
  submissions: any[],
  userInfo: Record<string, { name: string; email: string }>,
) {
  const rows = classes.map(c => {
    const cTasks = tasks.filter(t => t.class_id === c.id);
    const cTaskIds = new Set(cTasks.map(t => t.id));
    const cSubs = submissions.filter(s => cTaskIds.has(s.task_id));
    return {
      id: c.id,
      name: c.name,
      course: c.course,
      teacher_name: userInfo[c.teacher_id]?.name || '(unknown)',
      task_count: cTasks.length,
      submission_count: cSubs.length,
    };
  }).sort((a, b) => b.submission_count - a.submission_count);
  return { mode: 'classes', faculty, rows };
}

function computeMarkDistribution(submissions: any[], taskMap: any) {
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let total = 0;
  for (const s of submissions) {
    if (s.graded_at == null || s.total_mark == null) continue;
    const t = taskMap[s.task_id];
    if (!t || !t.total_marks) continue;
    const code = bandFor(Number(s.total_mark), Number(t.total_marks));
    counts[code]++;
    total++;
  }
  return { counts, total, bands: NESA_BANDS };
}

function computeMarkByFaculty(submissions: any[], taskMap: any) {
  const byFaculty: Record<string, { faculty: string; counts: Record<string, number>; total: number }> = {};
  for (const s of submissions) {
    if (s.graded_at == null || s.total_mark == null) continue;
    const t = taskMap[s.task_id];
    if (!t || !t.total_marks) continue;
    const f = t.faculty;
    byFaculty[f] ||= { faculty: f, counts: { A: 0, B: 0, C: 0, D: 0, E: 0 }, total: 0 };
    const code = bandFor(Number(s.total_mark), Number(t.total_marks));
    byFaculty[f].counts[code]++;
    byFaculty[f].total++;
  }
  return {
    rows: Object.values(byFaculty).sort((a, b) => b.total - a.total),
    bands: NESA_BANDS,
  };
}

function emptyResponse(
  schoolId: string,
  schoolName: string,
  callerRole: 'admin' | 'leader' | null,
  restrictedFaculties: string[] | null,
) {
  return {
    school: { id: schoolId, name: schoolName },
    caller_role: callerRole,
    restricted_faculties: restrictedFaculties,
    scope: restrictedFaculties
      ? { type: 'faculty', faculties: restrictedFaculties }
      : { type: 'school' },
    cards: {
      activity: { weeks: [], total_in_window: 0 },
      engagement: { mode: 'faculty', rows: [] },
      mark_distribution: { counts: { A: 0, B: 0, C: 0, D: 0, E: 0 }, total: 0, bands: NESA_BANDS },
      mark_by_faculty: restrictedFaculties && restrictedFaculties.length <= 1 ? null : { rows: [], bands: NESA_BANDS },
      marking: { total: 0, marked: 0, awaiting_marking: 0, unmarked: 0 },
      teacher_activity: [],
    },
    counts: {
      teachers: 0,
      classes: 0,
      tasks: 0,
      submissions: 0,
      tasks_with_class_feedback: 0,
    },
  };
}
