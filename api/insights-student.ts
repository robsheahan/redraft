import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import {
  resolveInsightsAccess,
  getInScopeClassIds,
  getInScopeStudentIds,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { yearLevelFromGraduationYear } from '../lib/insights-filters.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';

/**
 * Single-student insights endpoint.
 *
 *   GET /api/insights-student?student_id=<uuid>
 *
 * Returns:
 *   - student header (name, email, year level, classes they're in)
 *   - mark_distribution (A–E + per-task list)
 *   - improvement_velocity (their priority shifts across drafts)
 *   - llm: cached content shape for the 4 LLM card kinds + eligibility flag
 *
 * Scope: the requested student must be in the caller's set of in-scope
 * students (teacher's own classes / leader's faculty scope / admin school).
 *
 * Submissions are aggregated across every class the caller can see that
 * contains this student — so a teacher with the same student in two of
 * their classes gets a combined view.
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

const LLM_FLOOR = 3; // min submissions-with-feedback before LLM cards run

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const studentId = (req.query.student_id as string || '').trim();
  if (!studentId) return res.status(400).json({ error: 'student_id is required' });

  const supabase = getSupabase();
  const overrideId = (req.query.school_id as string) || null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, callerRole, restrictedFaculties } = access;

  // Scope check: the student must be reachable through the caller's classes.
  const allowedStudents = new Set(await getInScopeStudentIds(
    supabase, callerRole, user.id, schoolId, restrictedFaculties,
  ));
  if (!allowedStudents.has(studentId)) {
    return res.status(404).json({ error: 'Student not visible to you.' });
  }

  // Find every in-scope class this student is enrolled in. The caller may
  // have multiple classes containing them (teacher with two of their own
  // classes; leader with multiple PDHPE classes).
  const callerClassIds = await getInScopeClassIds(
    supabase, callerRole, user.id, schoolId, restrictedFaculties,
  );
  const { data: memberships } = await supabase
    .from('class_members')
    .select('class_id')
    .eq('student_id', studentId)
    .in('class_id', callerClassIds);
  const studentClassIds = (memberships || []).map(m => m.class_id);
  if (studentClassIds.length === 0) {
    return res.status(404).json({ error: 'No in-scope classes for this student.' });
  }

  // Class + task maps for context tagging.
  const { data: classRows } = await supabase
    .from('classes')
    .select('id, name, course, teacher_id')
    .in('id', studentClassIds);
  const classMap: Record<string, any> = {};
  (classRows || []).forEach(c => {
    classMap[c.id] = {
      ...c,
      faculty: c.course ? (getDisciplineForCourse(c.course) || 'Other') : 'Other',
    };
  });

  const { data: taskRows } = await supabase
    .from('tasks')
    .select('id, title, course, class_id, total_marks')
    .in('class_id', studentClassIds);
  const taskMap: Record<string, any> = {};
  (taskRows || []).forEach(t => {
    const cls = classMap[t.class_id];
    taskMap[t.id] = {
      ...t,
      faculty: t.course
        ? (getDisciplineForCourse(t.course) || cls?.faculty || 'Other')
        : (cls?.faculty || 'Other'),
      class_name: cls?.name || '',
    };
  });
  const taskIds = Object.keys(taskMap);

  // Student's submissions (all drafts, across every in-scope task).
  const { data: submissions } = taskIds.length > 0
    ? await supabase
      .from('submissions')
      .select('id, task_id, draft_version, graded_at, total_mark, criterion_marks, feedback, created_at')
      .eq('student_id', studentId)
      .in('task_id', taskIds)
    : { data: [] as any[] };

  const subs = submissions || [];
  const submissionsWithFeedback = subs.filter(s => s.feedback);

  // ── Student header info ───────────────────────────────────────────
  const { data: { user: studentUser } } = await supabase.auth.admin.getUserById(studentId);
  const studentMeta = (studentUser?.user_metadata || {}) as any;
  const studentName = studentMeta.display_name || studentMeta.full_name || studentMeta.name || studentUser?.email || 'Unknown';
  const gy = studentMeta.graduation_year;
  const yearLevel = yearLevelFromGraduationYear(typeof gy === 'string' ? parseInt(gy, 10) : gy);

  // ── Mark distribution (per-student) ───────────────────────────────
  const markDistribution = computeStudentMarkDistribution(subs, taskMap);

  // ── Improvement velocity (per-student, across their own tasks) ────
  const improvementVelocity = computeStudentVelocity(subs);

  // ── LLM eligibility ───────────────────────────────────────────────
  const llmEligible = submissionsWithFeedback.length >= LLM_FLOOR;

  return res.status(200).json({
    caller_role: callerRole,
    school: { id: schoolId },
    student: {
      id: studentId,
      display_name: studentName,
      email: studentUser?.email || '',
      year_level: yearLevel,
      classes: studentClassIds.map(id => ({
        id,
        name: classMap[id]?.name || '',
        course: classMap[id]?.course || '',
        faculty: classMap[id]?.faculty || 'Other',
      })),
      total_submissions: subs.length,
      submissions_with_feedback: submissionsWithFeedback.length,
      last_activity: subs.reduce((a, s) => (s.created_at && (!a || s.created_at > a) ? s.created_at : a), '' as string) || null,
    },
    cards: {
      mark_distribution: markDistribution,
      improvement_velocity: improvementVelocity,
      llm_eligible: llmEligible,
      llm_floor: LLM_FLOOR,
      // LLM card content is loaded via /api/insights-card-generate with
      // kind=student_*; no cache for v1, so this endpoint just signals
      // eligibility and leaves the cards in "not generated yet" state.
      llm: {},
    },
  });
}

// ─────────────── Compute helpers (student-scoped) ───────────────

function computeStudentMarkDistribution(subs: any[], taskMap: any) {
  const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let total = 0;
  const perTask: Array<{
    task_id: string;
    task_title: string;
    awarded: number;
    out_of: number;
    pct: number;
    band: string;
    course: string;
    class_name: string;
  }> = [];
  for (const s of subs) {
    if (s.graded_at == null || s.total_mark == null) continue;
    const t = taskMap[s.task_id];
    if (!t || !t.total_marks) continue;
    const awarded = Number(s.total_mark);
    const outOf = Number(t.total_marks);
    if (!Number.isFinite(awarded) || !Number.isFinite(outOf) || outOf <= 0) continue;
    const code = bandFor(awarded, outOf);
    counts[code]++;
    total++;
    perTask.push({
      task_id: t.id,
      task_title: t.title || '(untitled)',
      awarded,
      out_of: outOf,
      pct: (awarded / outOf) * 100,
      band: code,
      course: t.course || '',
      class_name: t.class_name || '',
    });
  }
  perTask.sort((a, b) => b.pct - a.pct);
  return { counts, total, bands: NESA_BANDS, per_task: perTask };
}

function extractImprovementTitles(feedback: any): string[] | null {
  if (!feedback || typeof feedback !== 'object') return null;
  const imp = feedback.improvements;
  if (!imp || typeof imp !== 'object') return null;
  const arr = Array.isArray(imp.summary) ? imp.summary : (Array.isArray(imp) ? imp : null);
  if (!arr) return null;
  return arr.map((item: any): string => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.title || item.heading || item.label || item.priority || '';
    return '';
  }).filter((t: string) => t.trim().length > 0);
}

function normaliseTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function computeStudentVelocity(subs: any[]) {
  // Group the student's submissions by task; need ≥2 drafts on the same
  // task to compare. Aggregate across every task they've multi-drafted.
  const byTask: Record<string, any[]> = {};
  for (const s of subs) {
    if (!s.task_id) continue;
    (byTask[s.task_id] ||= []).push(s);
  }
  let sampleTasks = 0;
  let tasksWithAddressed = 0;
  let v1Sum = 0;
  let vNSum = 0;
  let decreased = 0;
  let increased = 0;
  let unchanged = 0;
  const persistentCounts: Record<string, number> = {};
  const regressionCounts: Record<string, number> = {};

  for (const taskSubs of Object.values(byTask)) {
    if (taskSubs.length < 2) continue;
    taskSubs.sort((a, b) => (a.draft_version || 0) - (b.draft_version || 0));
    const first = taskSubs[0];
    const last = taskSubs[taskSubs.length - 1];
    const v1Titles = extractImprovementTitles(first?.feedback);
    const vNTitles = extractImprovementTitles(last?.feedback);
    if (v1Titles == null || vNTitles == null) continue;
    sampleTasks++;
    v1Sum += v1Titles.length;
    vNSum += vNTitles.length;
    if (vNTitles.length < v1Titles.length) decreased++;
    else if (vNTitles.length > v1Titles.length) increased++;
    else unchanged++;

    const v1Set = new Set(v1Titles.map(normaliseTitle));
    const vNSet = new Set(vNTitles.map(normaliseTitle));
    let addressedOne = false;
    for (const t of v1Set) {
      if (!vNSet.has(t)) addressedOne = true;
      else persistentCounts[t] = (persistentCounts[t] || 0) + 1;
    }
    for (const t of vNSet) {
      if (!v1Set.has(t)) regressionCounts[t] = (regressionCounts[t] || 0) + 1;
    }
    if (addressedOne) tasksWithAddressed++;
  }

  const topPersistent = Object.entries(persistentCounts)
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const topRegressions = Object.entries(regressionCounts)
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    sample_size: sampleTasks,
    avg_v1: sampleTasks > 0 ? v1Sum / sampleTasks : 0,
    avg_vN: sampleTasks > 0 ? vNSum / sampleTasks : 0,
    avg_delta_pct: v1Sum > 0 ? ((v1Sum - vNSum) / v1Sum) * 100 : 0,
    decreased,
    increased,
    unchanged,
    addressed_rate: sampleTasks > 0 ? (tasksWithAddressed / sampleTasks) * 100 : 0,
    students_with_any_addressed: tasksWithAddressed, // tasks, not students
    top_persistent: topPersistent,
    top_regressions: topRegressions,
  };
}

