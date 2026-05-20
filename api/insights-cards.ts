import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import {
  getSchoolTeacherIds,
  resolveInsightsAccess,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import {
  parseFiltersFromQuery,
  applyFacultyScope,
  userIdsForYearLevel,
  isFilterActive,
} from '../lib/insights-filters.js';

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

  // Filter parsing + scope clamping. A faculty-scoped leader cannot widen
  // their view by asking for a faculty they don't have access to; that
  // returns no data (we don't 403 because empty is a useful UI signal).
  const rawFilters = parseFiltersFromQuery(req.query as any);
  const filters = applyFacultyScope(rawFilters, restrictedFaculties);
  const filtersDenied = !!filters._denied;

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
      .select('id, task_id, student_id, draft_version, graded_at, total_mark, criterion_marks, feedback, created_at, submitted_for_marking')
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

  // Apply faculty scope (caller's role-based restriction) AND the request
  // filters (faculty/course/class_id from query params).
  const allowed = restrictedFaculties ? new Set(restrictedFaculties) : null;
  const inFacultyScope = (faculty: string) => !allowed || allowed.has(faculty);

  // year_level filter is applied at submission scope (since each task can
  // host submissions from students in different years).
  let allowedStudentIds: Set<string> | null = null;
  if (filters.year_level != null) {
    allowedStudentIds = userIdsForYearLevel(allUsers as any, filters.year_level);
  }

  function passesFilters(task: any): boolean {
    if (!inFacultyScope(task.faculty)) return false;
    if (filtersDenied) return false;
    if (filters.faculty && task.faculty !== filters.faculty) return false;
    if (filters.course && task.course !== filters.course) return false;
    if (filters.class_id && task.class_id !== filters.class_id) return false;
    return true;
  }
  function classPassesFilters(cls: any): boolean {
    if (!inFacultyScope(cls.faculty)) return false;
    if (filtersDenied) return false;
    if (filters.faculty && cls.faculty !== filters.faculty) return false;
    if (filters.course && cls.course !== filters.course) return false;
    if (filters.class_id && cls.id !== filters.class_id) return false;
    return true;
  }

  const tasks = Object.values(taskMap).filter((t: any) => passesFilters(t)) as any[];
  const tasksInScopeIds = new Set(tasks.map(t => t.id));
  const classesInScope = Object.values(classMap)
    .filter((c: any) => classPassesFilters(c)) as any[];
  // Teachers "in scope" for the headline KPI + activity table:
  //   - no filters / unrestricted view: every staff member at the school
  //     (including teachers who haven't created a class yet)
  //   - any filter active: only teachers who own a class in scope (since
  //     a filtered view should narrow to what's relevant)
  const anyFilter = !!(allowed || isFilterActive(filters));
  const teachersInScopeIds = new Set<string>(
    anyFilter
      ? classesInScope.map((c: any) => c.teacher_id).filter(Boolean) as string[]
      : teacherIds
  );

  let submissions = (rawSubs || []).filter(s => tasksInScopeIds.has(s.task_id));
  if (allowedStudentIds) {
    submissions = submissions.filter(s => s.student_id && allowedStudentIds!.has(s.student_id));
  }

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

  // -- Card: Per-criterion lows --
  const perCriterionLows = computePerCriterionLows(submissions);

  // -- Card: Improvement velocity --
  const improvementVelocity = computeImprovementVelocity(submissions);

  // -- Card: Keyword struggles (NESA-glossary pattern match) --
  const keywordStruggles = computeKeywordStruggles(submissions);

  // -- Counts (header KPI strip) --
  const counts = {
    teachers: teachersInScopeIds.size,
    classes: classesInScope.length,
    tasks: tasks.length,
    submissions: submissions.length,
    tasks_with_class_feedback: tasks.filter(t => t.has_class_feedback).length,
  };

  // Filter options for the dropdowns. Derived from ALL school data (not
  // just in-scope) so leaders can change filters without first clearing
  // them. Faculty list is clamped to the caller's allowed faculties.
  const allClassesArr = Object.values(classMap) as any[];
  const allTasksArr = Object.values(taskMap) as any[];
  const facultyOptions = [...new Set(allClassesArr.map(c => c.faculty).concat(allTasksArr.map(t => t.faculty)))]
    .filter((f): f is string => !!f && f !== 'Other')
    .filter(f => !restrictedFaculties || restrictedFaculties.includes(f))
    .sort();
  const courseOptions = [...new Set(allClassesArr.map(c => c.course).filter(Boolean))].sort() as string[];
  const classOptions = allClassesArr
    .map(c => ({ id: c.id, name: c.name, course: c.course, faculty: c.faculty }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return res.status(200).json({
    school: { id: schoolId, name: schoolName },
    caller_role: callerRole,
    restricted_faculties: restrictedFaculties,
    scope: restrictedFaculties
      ? { type: 'faculty', faculties: restrictedFaculties }
      : { type: 'school' },
    filters: {
      active: { ...filters, _denied: undefined },
      denied: filtersDenied,
      options: {
        faculties: facultyOptions,
        courses: courseOptions,
        classes: classOptions,
        year_levels: [7, 8, 9, 10, 11, 12],
      },
    },
    cards: {
      activity,
      engagement,
      mark_distribution: markDistribution,
      mark_by_faculty: markByFaculty,
      marking,
      teacher_activity: teacherActivity,
      per_criterion_lows: perCriterionLows,
      improvement_velocity: improvementVelocity,
      keyword_struggles: keywordStruggles,
    },
    counts,
  });
}

// ─────────────── New SQL-derived performance cards ───────────────

/**
 * Per-criterion average performance, sorted lowest first. Pulls from
 * submissions.criterion_marks (jsonb array of {name, mark, max}) and
 * groups by exact criterion name.
 */
function computePerCriterionLows(submissions: any[]) {
  const map: Record<string, { sum_pct: number; count: number }> = {};
  let analysed = 0;
  for (const s of submissions) {
    if (!s.graded_at) continue;
    const cm = s.criterion_marks;
    if (!Array.isArray(cm)) continue;
    let counted = false;
    for (const c of cm) {
      if (!c || typeof c.name !== 'string') continue;
      const mark = Number(c.mark);
      const max = Number(c.max);
      if (!Number.isFinite(mark) || !Number.isFinite(max) || max <= 0) continue;
      const name = c.name.trim();
      if (!name) continue;
      map[name] ||= { sum_pct: 0, count: 0 };
      map[name].sum_pct += (mark / max) * 100;
      map[name].count++;
      counted = true;
    }
    if (counted) analysed++;
  }
  const rows = Object.entries(map)
    .map(([name, v]) => ({ name, avg_pct: v.sum_pct / v.count, sample_size: v.count }))
    .filter(r => r.sample_size >= 2)  // need at least 2 samples to be meaningful
    .sort((a, b) => a.avg_pct - b.avg_pct)
    .slice(0, 8);
  return { rows, total_analyzed: analysed };
}

/**
 * "Do multi-draft students improve?" — for each (student, task) pair
 * with two or more drafts, compare the count of improvement bullets in
 * the AI feedback between v1 and the final draft. Fewer bullets = the
 * model found fewer things to flag = improvement.
 *
 * Output is intentionally a simple % reduction figure; deeper analysis
 * (mark deltas) is harder because we rarely grade every draft.
 */
function computeImprovementVelocity(submissions: any[]) {
  const byPair: Record<string, any[]> = {};
  for (const s of submissions) {
    if (!s.student_id || !s.task_id) continue;
    const key = s.student_id + '|' + s.task_id;
    (byPair[key] ||= []).push(s);
  }
  let sampleSize = 0;
  let v1ImprSum = 0;
  let vNImprSum = 0;
  let increased = 0;
  let decreased = 0;
  let unchanged = 0;
  for (const subs of Object.values(byPair)) {
    if (subs.length < 2) continue;
    subs.sort((a, b) => (a.draft_version || 0) - (b.draft_version || 0));
    const first = subs[0];
    const last = subs[subs.length - 1];
    const c1 = countImprovements(first?.feedback);
    const cN = countImprovements(last?.feedback);
    if (c1 == null || cN == null) continue;
    sampleSize++;
    v1ImprSum += c1;
    vNImprSum += cN;
    if (cN < c1) decreased++;
    else if (cN > c1) increased++;
    else unchanged++;
  }
  if (sampleSize === 0) return { sample_size: 0, avg_v1: 0, avg_vN: 0, avg_delta_pct: 0, decreased: 0, increased: 0, unchanged: 0 };
  const avgV1 = v1ImprSum / sampleSize;
  const avgVN = vNImprSum / sampleSize;
  const deltaPct = avgV1 > 0 ? ((avgV1 - avgVN) / avgV1) * 100 : 0;
  return {
    sample_size: sampleSize,
    avg_v1: avgV1,
    avg_vN: avgVN,
    avg_delta_pct: deltaPct,
    decreased,
    increased,
    unchanged,
  };
}

function countImprovements(feedback: any): number | null {
  if (!feedback || typeof feedback !== 'object') return null;
  const imp = feedback.improvements;
  if (!imp || typeof imp !== 'object') return null;
  if (Array.isArray(imp.summary)) return imp.summary.length;
  if (Array.isArray(imp)) return imp.length;
  return null;
}

/**
 * NESA-glossary keyword struggle map. Scans every submission's AI
 * improvement feedback text for occurrences of high-signal NESA terms
 * and surfaces the most-mentioned ones. Pure SQL/JS — no LLM needed.
 *
 * The list is deliberately curated: directive verbs at the top
 * (analyse / evaluate / justify) plus the writing-craft terms that
 * appear most often in HSC marking centre commentary (evidence,
 * structure, thesis, etc.).
 */
const STRUGGLE_KEYWORDS = [
  // NESA directive verbs
  'analyse', 'evaluate', 'justify', 'assess', 'explain', 'discuss', 'compare',
  'contrast', 'examine', 'describe', 'identify', 'outline', 'synthesise',
  'apply', 'demonstrate', 'critique',
  // Writing-craft terms
  'evidence', 'examples', 'structure', 'thesis', 'argument', 'conclusion',
  'introduction', 'paragraph', 'topic sentence', 'transitions', 'cohesion',
  'terminology', 'vocabulary', 'concept', 'context', 'audience', 'purpose',
  // Analysis-quality terms
  'depth', 'detail', 'specificity', 'critical thinking', 'reasoning',
  'integration', 'connection', 'relevance', 'sustained',
];

function computeKeywordStruggles(submissions: any[]) {
  const counts: Record<string, number> = {};
  for (const k of STRUGGLE_KEYWORDS) counts[k] = 0;
  let analysed = 0;
  const wordRe = (kw: string) => new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const compiled = STRUGGLE_KEYWORDS.map(k => ({ kw: k, re: wordRe(k) }));
  for (const s of submissions) {
    const fb = s.feedback;
    if (!fb || typeof fb !== 'object') continue;
    // Concatenate the improvement-related text fields.
    const parts: string[] = [];
    const collect = (v: any) => {
      if (!v) return;
      if (typeof v === 'string') parts.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (typeof v === 'object') { if (typeof v.summary !== 'undefined') collect(v.summary); if (typeof v.detail !== 'undefined') collect(v.detail); }
    };
    collect(fb.improvements);
    collect(fb.top_priority);
    if (parts.length === 0) continue;
    const text = parts.join(' ');
    analysed++;
    for (const { kw, re } of compiled) {
      if (re.test(text)) counts[kw]++;
    }
  }
  const rows = Object.entries(counts)
    .filter(([_, c]) => c > 0)
    .map(([keyword, count]) => ({ keyword, count, pct: analysed > 0 ? (count / analysed) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { rows, total_analyzed: analysed };
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
      per_criterion_lows: { rows: [], total_analyzed: 0 },
      improvement_velocity: { sample_size: 0, avg_v1: 0, avg_vN: 0, avg_delta_pct: 0, decreased: 0, increased: 0, unchanged: 0 },
      keyword_struggles: { rows: [], total_analyzed: 0 },
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
