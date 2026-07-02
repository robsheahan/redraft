import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import {
  getSchoolTeacherIds,
  resolveInsightsAccess,
  listAllAuthUsers,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { fetchAllRows } from '../lib/db-page.js';
import { computeSkillMatrix } from '../lib/skill-matrix.js';
import { computeSkillGrowth } from '../lib/skill-history.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import {
  parseFiltersFromQuery,
  applyFacultyScope,
  getTimeWindowCutoff,
  userIdsForYearLevel,
  isFilterActive,
  scopeKeyForFilters,
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

export default withHandler({ methods: ['GET'], label: 'insights-cards' }, async (req, res, ctx) => {
  const user = ctx.user!;

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
  // Paginate through Supabase's 1000/page cap so we don't silently truncate.
  const allUsers = await listAllAuthUsers(supabase);

  // Teacher tier sees only their own classes (regardless of school context).
  // Leader/admin tiers see every teacher at the school. A teacher passing a
  // ?class_id= they don't own falls out naturally — the classes query is
  // constrained to teacher_id IN [user.id] so unowned class_ids return zero
  // rows downstream.
  const teacherIds = callerRole === 'teacher'
    ? [user.id]
    : await getSchoolTeacherIds(supabase, schoolId, allUsers as any);

  const userInfo: Record<string, { name: string; email: string }> = {};
  (allUsers as any[]).forEach(u => {
    userInfo[u.id] = {
      name: u.user_metadata?.display_name || u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Unknown',
      email: u.email || '',
    };
  });

  // Don't short-circuit on empty teachers — the main flow handles empty
  // arrays cleanly and returns a fully-formed response (with filter
  // options etc.), whereas the dedicated emptyResponse() skipped those.
  const { data: rawClasses } = teacherIds.length > 0
    ? await supabase
      .from('classes')
      .select('id, name, course, teacher_id')
      .in('teacher_id', teacherIds)
    : { data: [] as any[] };

  // Don't short-circuit if classes is empty. A school can have staff
  // signed up but no classes yet — we still want to show the headline
  // Teachers count (and the empty states on the other cards), not zero
  // out the entire dashboard.
  const classIds = (rawClasses || []).map(c => c.id);

  const { data: rawTasks } = classIds.length > 0
    ? await supabase
      .from('tasks')
      .select('id, title, class_id, course, total_marks, published_at, created_at, class_feedback_count, task_mode')
      .in('class_id', classIds)
    : { data: [] as any[] };

  const taskIds = (rawTasks || []).map(t => t.id);
  const subsCutoff = getTimeWindowCutoff(filters.time_window);
  let rawSubs: any[] = [];
  if (taskIds.length > 0) {
    // Paginate — a school with >1000 in-window submissions would otherwise get an
    // arbitrary, unordered 1000-row subset (wrong card stats, flapping fingerprint).
    rawSubs = await fetchAllRows((from, to) => {
      let q = supabase
        .from('submissions')
        .select('id, task_id, student_id, draft_version, graded_at, total_mark, criterion_marks, feedback, created_at, submitted_for_marking')
        .in('task_id', taskIds)
        .order('id')
        .range(from, to);
      if (subsCutoff) q = q.gte('created_at', subsCutoff.toISOString());
      return q;
    });
  }

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
      task_mode: t.task_mode || 'feedback_task',
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

  // -- Card: Maths error categories (from per-line annotations on
  // submissions where feedback.kind === 'maths') --
  const mathsErrorCategories = computeMathsErrorCategories(submissions);

  // -- Card: Cohort skill matrix (deterministic, from student_skill_profile) --
  // The first insights reader of the skill database. Aggregates the rollup rows
  // of the in-scope, in-discipline cohort into a per-dimension distribution. No
  // LLM, no rate limit. Scoped by (a) students enrolled in the in-scope classes
  // and (b) the disciplines those classes belong to — so faculty restriction is
  // honoured (a restricted leader never sees a KLA they weren't granted, because
  // its discipline isn't in classesInScope).
  let skillMatrix: any = { writing: null, maths: null };
  // -- Card: Cohort skill growth (deterministic, from skill_observations) --
  // R2 — within-student growth over time. Same cohort + discipline scope as the
  // matrix, honouring the page's time window.
  let skillGrowth: any = { writing: null, maths: null };
  const inScopeClassIds = classesInScope.map((c: any) => c.id);
  const inScopeDisciplines = [...new Set(classesInScope.map((c: any) => c.faculty).filter(Boolean))] as string[];
  if (inScopeClassIds.length > 0 && inScopeDisciplines.length > 0) {
    const memberRows = await fetchAllRows((from, to) =>
      supabase.from('class_members')
        .select('student_id')
        .in('class_id', inScopeClassIds)
        .order('student_id')
        .range(from, to));
    let cohortStudentIds = [...new Set((memberRows || []).map((m: any) => m.student_id).filter(Boolean))] as string[];
    if (allowedStudentIds) cohortStudentIds = cohortStudentIds.filter(id => allowedStudentIds!.has(id));
    if (cohortStudentIds.length > 0) {
      const skillRows = await fetchAllRows((from, to) =>
        supabase.from('student_skill_profile')
          .select('student_id, discipline, dimension, level, level_label, confidence, trend, observation_count')
          .in('student_id', cohortStudentIds)
          .in('discipline', inScopeDisciplines)
          .order('student_id')
          .range(from, to));
      skillMatrix = computeSkillMatrix(skillRows || []);

      // Growth history — the observation log, windowed to match the dashboard.
      const obsRows = await fetchAllRows((from, to) => {
        let q = supabase.from('skill_observations')
          .select('student_id, dimension, level, observed_at')
          .in('student_id', cohortStudentIds)
          .in('discipline', inScopeDisciplines)
          .order('student_id')
          .range(from, to);
        if (subsCutoff) q = q.gte('observed_at', subsCutoff.toISOString());
        return q;
      });
      skillGrowth = computeSkillGrowth(obsRows || []);
    }
  }

  // -- Cached LLM cards (Tier A) --
  // Cards are cached per scope so a generated card persists across reloads and
  // is reused by anyone viewing the same scope. Teacher tier reads its own
  // per-teacher cache; leader/admin read the per-school cache.
  const llm: Record<string, any> = {};
  const scopeKey = scopeKeyForFilters(filters, restrictedFaculties);
  if (callerRole !== 'teacher' && schoolId) {
    // Per (school, kind, scope) — so an English HOD never sees the HSIE HOD's
    // card (and vice versa); each scope has its own row.
    const { data: llmRows } = await supabase
      .from('school_insights_cards')
      .select('card_kind, content, filters, source_submission_count, source_task_count, generated_at')
      .eq('school_id', schoolId)
      .eq('scope_key', scopeKey);
    (llmRows || []).forEach(r => {
      llm[r.card_kind] = {
        content: r.content,
        filters: r.filters || {},
        source_submission_count: r.source_submission_count,
        source_task_count: r.source_task_count,
        generated_at: r.generated_at,
      };
    });
  } else if (callerRole === 'teacher' && user) {
    // Per (teacher, kind, scope) — so a teacher's generated cohort cards
    // persist on reload and across sessions.
    const { data: llmRows } = await supabase
      .from('teacher_insights_cards')
      .select('card_kind, content, source_submission_count, source_task_count, generated_at')
      .eq('teacher_id', user.id)
      .eq('scope_key', scopeKey);
    (llmRows || []).forEach(r => {
      llm[r.card_kind] = {
        content: r.content,
        source_submission_count: r.source_submission_count,
        source_task_count: r.source_task_count,
        generated_at: r.generated_at,
      };
    });
  }

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
      maths_error_categories: mathsErrorCategories,
      skill_matrix: skillMatrix,
      skill_growth: skillGrowth,
      llm,
    },
    counts,
  });
});

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

// Keep only the latest graded draft per (student, task). Without this the A–E
// chart counts EVERY graded draft — a student marked 6/20 on v1 and 15/20 on v2
// contributes both a D and a B — while the LLM decile cards (which dedupe to the
// latest draft) describe a different population. Deduping here aligns the two and
// stops heavy drafters being over-weighted. Anonymous rows (null student_id) are
// kept as-is — there's no student to dedupe within.
function latestGradedPerStudentTask(submissions: any[]): any[] {
  const byPair = new Map<string, any>();
  const kept: any[] = [];
  for (const s of submissions) {
    if (s.graded_at == null || s.total_mark == null) continue;
    if (!s.student_id || !s.task_id) { kept.push(s); continue; }
    const k = s.student_id + '|' + s.task_id;
    const prev = byPair.get(k);
    if (!prev || (s.created_at || '') > (prev.created_at || '')) byPair.set(k, s);
  }
  return [...byPair.values(), ...kept];
}

function computeMarkDistribution(submissions: any[], taskMap: any) {
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let total = 0;
  for (const s of latestGradedPerStudentTask(submissions)) {
    const t = taskMap[s.task_id];
    if (!t || !t.total_marks) continue;
    // quick_task is "not a graded task" by design — exclude even if the
    // teacher chose to give it a number.
    if (t.task_mode === 'quick_task') continue;
    const code = bandFor(Number(s.total_mark), Number(t.total_marks));
    counts[code]++;
    total++;
  }
  return { counts, total, bands: NESA_BANDS };
}

function computeMarkByFaculty(submissions: any[], taskMap: any) {
  const byFaculty: Record<string, { faculty: string; counts: Record<string, number>; total: number }> = {};
  for (const s of latestGradedPerStudentTask(submissions)) {
    const t = taskMap[s.task_id];
    if (!t || !t.total_marks) continue;
    if (t.task_mode === 'quick_task') continue;
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
  callerRole: 'admin' | 'leader' | 'teacher' | null,
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
      maths_error_categories: { total_maths_submissions: 0, total_lines: 0, categories: [] },
      skill_matrix: { writing: null, maths: null },
      skill_growth: { writing: null, maths: null },
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

// ─────────────── Maths error categories ───────────────

/**
 * Aggregates per-line annotation categories across maths submissions in
 * scope. Each line annotation has a `category` (one of the enum values
 * in MATHS_PER_LINE_DIAGNOSTIC_TOOL); we count non-"ok" categories and
 * return the top six. Soft floor in the renderer: <3 submissions shows
 * a "not enough data yet" state; the data is always returned so the
 * card can render its empty state without a separate request.
 */
const MATHS_CATEGORY_LABELS: Record<string, string> = {
  notation_equals_abuse: 'Equals-sign misuse',
  notation_other: 'Notation',
  missing_constant: 'Missing +C / ln|x|',
  algebra_sign: 'Sign error',
  algebra_distribution: 'Distribution error',
  algebra_index_law: 'Index law',
  arithmetic: 'Arithmetic',
  method_choice: 'Method choice',
  justification_missing: 'Justification missing',
  verb_mismatch: 'Verb mismatch',
  precision_wrong: 'Precision',
  premature_rounding: 'Premature rounding',
  unit_missing: 'Units missing',
  context_missing: 'Answer not in context',
  variable_confusion: 'Variables mixed up',
  domain_restriction_missing: 'Domain missing',
  transcription_error: 'Transcription error',
  reference_sheet_misuse: 'Reference Sheet',
  incomplete_answer: 'Answer incomplete',
  statistical_interpretation: 'Statistical interpretation',
  reason_only_issue: 'Reasoning',
  step_skipped: 'Skipped a required step',
  other: 'Other',
};

export function computeMathsErrorCategories(submissions: any[]) {
  const counts: Record<string, number> = {};
  const studentsByCat: Record<string, Set<string>> = {};
  const mathsStudents = new Set<string>();
  let totalLines = 0;
  let totalMathsSubs = 0;

  const tally = (cat: string | null, sid: string) => {
    if (!cat || cat === 'ok') return;
    counts[cat] = (counts[cat] || 0) + 1;
    (studentsByCat[cat] = studentsByCat[cat] || new Set()).add(sid);
  };
  // A skipped mark-bearing step (step_gaps) is an objective, high-signal error
  // bucket of its own — count it alongside the per-line categories.
  const ingest = (annots: any, gaps: any, sid: string) => {
    (Array.isArray(annots) ? annots : []).forEach((a: any) => {
      totalLines += 1;
      tally(a && typeof a.category === 'string' ? a.category : null, sid);
    });
    (Array.isArray(gaps) ? gaps : []).forEach(() => tally('step_skipped', sid));
  };

  submissions.forEach(s => {
    const fb = s && s.feedback;
    if (!fb) return;
    const sid = s.student_id || '';
    if (fb.kind === 'maths') {
      totalMathsSubs += 1;
      if (sid) mathsStudents.add(sid);
      ingest(fb.line_annotations, fb.step_gaps, sid);
    } else if (fb.kind === 'maths_multipart') {
      totalMathsSubs += 1;
      if (sid) mathsStudents.add(sid);
      (Array.isArray(fb.parts) ? fb.parts : []).forEach((p: any) => ingest(p.line_annotations, p.step_gaps, sid));
    }
  });

  // Headline metric is DISTINCT STUDENTS per category ("8 students dropped +C"),
  // not raw line counts — that's what tells a teacher what to reteach.
  const categories = Object.entries(counts)
    .map(([category, count]) => ({
      category,
      count,
      students: (studentsByCat[category] || new Set()).size,
      label: MATHS_CATEGORY_LABELS[category] || category,
    }))
    .sort((a, b) => b.students - a.students || b.count - a.count)
    .slice(0, 6);

  return {
    total_maths_submissions: totalMathsSubs,
    total_maths_students: mathsStudents.size,
    total_lines: totalLines,
    categories,
  };
}
