import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { resolveInsightsAccess, getSchoolTeacherIds, listAllAuthUsers, getInScopeStudentIds, getInScopeClassIds } from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import {
  parseFiltersFromQuery,
  applyFacultyScope,
  userIdsForYearLevel,
  getTimeWindowCutoff,
  scopeKeyForFilters,
  cohortFingerprint,
} from '../lib/insights-filters.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import {
  BOTTOM_DECILE_TOOL,
  TOP_DECILE_TOOL,
  COHORT_PATTERNS_TOOL,
  THINGS_DONE_WELL_TOOL,
  STUDENT_TOP_MISTAKES_TOOL,
  STUDENT_STRETCH_GOALS_TOOL,
  STUDENT_STRENGTHS_TOOL,
  STUDENT_SUMMARY_TOOL,
  CLASS_PROFILE_SUMMARY_TOOL,
} from '../lib/feedback-tools.js';

/**
 * Generate a single Tier-A LLM insight card for a school.
 *
 *   POST /api/insights-card-generate
 *     body: { kind, school_id?, faculty?, course?, class_id?, year_level? }
 *
 * Kinds: bottom_decile | top_decile | common_gaps | things_done_well
 *
 * Each kind:
 *   - filters submissions per the request + caller's faculty scope
 *   - aggregates the relevant feedback signal (improvements / verb checks /
 *     strengths) into a bounded prompt
 *   - calls Claude with a forced-tool-call schema
 *   - upserts the result into school_insights_cards (one row per
 *     school + kind), with the filter context and source counts
 *
 * Rate-limited per school + per card kind so a leader spamming a single
 * card doesn't burn the bucket for other cards.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_SUBMISSIONS_TO_FEED = 60;

// Cohort cards are cached per (owner, kind, scope) with corpus-fingerprint
// freshness. The TTL is only a defensive backstop against a fingerprint blind
// spot — real changes invalidate via the fingerprint.
const CARD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const KIND_CONFIG: Record<string, {
  tool: any;
  endpointName: string;
  buildSystemPrompt: (schoolName: string, sample: number) => string;
  buildUserPrompt: (rows: any[], context: any) => string;
}> = {
  bottom_decile: {
    tool: BOTTOM_DECILE_TOOL,
    endpointName: 'insights-card-bottom-decile',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained educator analysing the bottom decile of a school's student writing.`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions from students in the bottom 10% by mark percentage.`,
      ``,
      `You'll receive each student's AI improvement feedback. Identify the 3 dominant patterns of mistakes — the things appearing across multiple students that a head of teaching & learning should action.`,
      ``,
      `RULES:`,
      `- Concrete, specific patterns. Not "students need to write better".`,
      `- Frame each pattern as something teachable.`,
      `- Do not name individual students. Aggregate only.`,
      `- No mark or band predictions.`,
      `- Use NESA marker vocabulary where it sharpens the point.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildImprovementsPrompt(rows, 'bottom-decile student'),
  },
  top_decile: {
    tool: TOP_DECILE_TOOL,
    endpointName: 'insights-card-top-decile',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained educator analysing the top decile of a school's student writing.`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions from students in the top 10% by mark percentage.`,
      ``,
      `These students are already performing well. You'll receive each student's AI improvement feedback. Identify the 3 highest-impact next steps that would stretch them further — the things that would move "high" responses to "exceptional".`,
      ``,
      `RULES:`,
      `- Frame next steps as STRETCH goals, not remedial fixes.`,
      `- Be specific about what the upgrade looks like in their writing.`,
      `- No mark or band predictions.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildImprovementsPrompt(rows, 'top-decile student'),
  },
  // common_gaps now produces the cohort gaps AND strengths in one consistent
  // call (COHORT_PATTERNS_TOOL); the handler fans the strengths out into the
  // things_done_well cache so the two cards can never contradict each other.
  common_gaps: {
    tool: COHORT_PATTERNS_TOOL,
    endpointName: 'insights-card-common-gaps',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained educator analysing whole-cohort writing performance.`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions across the school.`,
      ``,
      `In a single consistent read, identify the top 3 GAPS (patterns that need whole-staff PD, not just intervention) and the top 3 STRENGTHS students show consistently.`,
      ``,
      `INTERNAL CONSISTENCY (critical):`,
      `- The gaps and strengths must NOT contradict each other. Never list a skill as a strength if its absence appears in the gaps, or vice versa (e.g. do NOT praise "use of concrete, real-world evidence" while also listing "claims made without evidence" as a gap).`,
      `- If a skill is genuinely uneven across the cohort, put it in ONE list only and describe it as inconsistent, rather than claiming it is both a strength and a weakness.`,
      `- No mark or band predictions.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildCohortPatternsPrompt(rows),
  },
  things_done_well: {
    tool: THINGS_DONE_WELL_TOOL,
    endpointName: 'insights-card-things-done-well',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained educator analysing what students across a school are doing well.`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions.`,
      ``,
      `Identify the top 3 strengths showing up consistently in AI feedback. These help leadership celebrate wins and share best practice across faculties.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildStrengthsPrompt(rows),
  },
};

function buildImprovementsPrompt(rows: any[], label: string): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const imp = fb.improvements;
    const summary = imp && Array.isArray(imp.summary) ? imp.summary : (Array.isArray(imp) ? imp : []);
    const detail = imp && Array.isArray(imp.detail) ? imp.detail : [];
    const top = (fb.top_priority && fb.top_priority.summary) || fb.top_priority || '';
    return [
      `--- ${label} #${i + 1} ---`,
      `Faculty: ${r.faculty || 'Other'}  Course: ${r.course || '(unknown)'}  Task: ${r.task_title}`,
      r.mark_pct != null ? `Mark: ${Math.round(r.mark_pct)}%` : '',
      `Top priority: ${top}`,
      `Improvements summary: ${JSON.stringify(summary)}`,
      detail.length ? `Improvements detail: ${JSON.stringify(detail).slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} samples. Synthesise the dominant patterns now.\n\n${lines}`;
}

function buildStrengthsPrompt(rows: any[]): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const w = fb.what_youve_done_well;
    const summary = w && Array.isArray(w.summary) ? w.summary : (Array.isArray(w) ? w : []);
    return [
      `--- submission #${i + 1} ---`,
      `Faculty: ${r.faculty || 'Other'}  Course: ${r.course || '(unknown)'}`,
      `Strengths summary: ${JSON.stringify(summary)}`,
    ].join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} per-submission strength notes. Surface the top 3 cross-cohort strengths.\n\n${lines}`;
}

// Feeds BOTH the improvement and strength signals from each submission so the
// model can produce gaps and strengths that are mutually consistent.
function buildCohortPatternsPrompt(rows: any[]): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const imp = fb.improvements;
    const impSummary = imp && Array.isArray(imp.summary) ? imp.summary : (Array.isArray(imp) ? imp : []);
    const w = fb.what_youve_done_well;
    const strSummary = w && Array.isArray(w.summary) ? w.summary : (Array.isArray(w) ? w : []);
    const top = (fb.top_priority && fb.top_priority.summary) || fb.top_priority || '';
    return [
      `--- submission #${i + 1} ---`,
      `Faculty: ${r.faculty || 'Other'}  Course: ${r.course || '(unknown)'}  Task: ${r.task_title}`,
      top ? `Top priority: ${top}` : '',
      `Improvements: ${JSON.stringify(impSummary)}`,
      `Strengths: ${JSON.stringify(strSummary)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} per-submission feedback notes — each lists both what the student did well and what they need to improve. Identify the top 3 cohort-wide GAPS and the top 3 cohort-wide STRENGTHS, and make sure the two lists do not contradict each other.\n\n${lines}`;
}

// ─────────────── Single-student kinds ───────────────

const STUDENT_LLM_FLOOR = 3;

// True daily ceiling on student-card generation across ALL students and
// callers. The per-student rate limit keys its global cap by student_id, so on
// its own it only bounds spend per-student (a school of N students would get
// N×400/day of headroom). This shared-key cap is the actual circuit breaker on
// the most expensive uncapped authenticated path (P5). Generous enough for
// legitimate pilot use; low enough to stop a runaway.
const STUDENT_CARD_GLOBAL_PER_DAY = 1500;

const STUDENT_KIND_CONFIG: Record<string, {
  tool: any;
  endpointName: string;
  buildSystemPrompt: (studentName: string, sample: number) => string;
  buildUserPrompt: (rows: any[], ctx: { studentName: string }) => string;
}> = {
  student_top_mistakes: {
    tool: STUDENT_TOP_MISTAKES_TOOL,
    endpointName: 'insights-card-student-top-mistakes',
    buildSystemPrompt: (studentName, sample) => [
      `You are a senior NSW NESA-trained educator. The audience is ${studentName}'s classroom teacher, who is preparing personalised feedback.`,
      `Student: ${studentName}`,
      `Sample size: ${sample} of this student's submissions with AI feedback.`,
      ``,
      `Identify the 3 mistakes recurring across this student's writing. Be specific to what's in their feedback corpus.`,
      ``,
      `RULES:`,
      `- Concrete, specific patterns visible in this student's work.`,
      `- Frame each as something teachable.`,
      `- You MAY name the student (it's their own teacher reading this).`,
      `- Do not predict marks or bands. Ever.`,
      `- Use NESA marker vocabulary where it sharpens the point.`,
    ].join('\n'),
    buildUserPrompt: (rows, ctx) => buildStudentImprovementsPrompt(rows, ctx.studentName),
  },
  student_stretch_goals: {
    tool: STUDENT_STRETCH_GOALS_TOOL,
    endpointName: 'insights-card-student-stretch-goals',
    buildSystemPrompt: (studentName, sample) => [
      `You are a senior NSW NESA-trained educator advising a teacher on next-step recommendations for ${studentName}.`,
      `Student: ${studentName}`,
      `Sample size: ${sample} of this student's submissions with AI feedback.`,
      ``,
      `Identify the 3 highest-impact next steps personalised to this student. These are stretch goals — push their work to the next level given their current pattern.`,
      ``,
      `RULES:`,
      `- Be specific to what THIS student's feedback shows — not generic stretch advice.`,
      `- Frame each as a concrete writing move (e.g. "Sustain critical evaluation through paragraph 3, not just the introduction").`,
      `- No mark/band predictions.`,
      `- You may name the student.`,
    ].join('\n'),
    buildUserPrompt: (rows, ctx) => buildStudentImprovementsPrompt(rows, ctx.studentName),
  },
  student_strengths: {
    tool: STUDENT_STRENGTHS_TOOL,
    endpointName: 'insights-card-student-strengths',
    buildSystemPrompt: (studentName, sample) => [
      `You are a senior NSW NESA-trained educator advising a teacher on what ${studentName} is doing well.`,
      `Student: ${studentName}`,
      `Sample size: ${sample} of this student's submissions with AI feedback.`,
      ``,
      `Identify the 3 strengths showing up most consistently in this student's writing. Drawn from strength / "what you've done well" sections of their AI feedback.`,
      ``,
      `RULES:`,
      `- Specific to this student, not generic praise.`,
      `- You may name the student.`,
      `- No mark/band predictions.`,
    ].join('\n'),
    buildUserPrompt: (rows, ctx) => buildStudentStrengthsPrompt(rows, ctx.studentName),
  },
  student_summary: {
    tool: STUDENT_SUMMARY_TOOL,
    endpointName: 'insights-card-student-summary',
    buildSystemPrompt: (studentName, sample) => [
      `You are a senior NSW NESA-trained educator writing a brief progress narrative on ${studentName} for their classroom teacher to use as a starting point for a report comment, parent meeting, or feedback chat.`,
      `Student: ${studentName}`,
      `Sample size: ${sample} of this student's submissions with AI feedback.`,
      ``,
      `Write a tight 4–6 sentence paragraph addressed in third person to the teacher. Open with where the student sits overall (without using mark/band language), then their key strength(s), then their key priority(ies), and close with a concrete next step.`,
      ``,
      `RULES:`,
      `- Address the student by name in third person ("Sam consistently…", "Their writing tends to…").`,
      `- Ground every claim in the feedback corpus provided. No invention.`,
      `- No mark/band/score predictions.`,
      `- Tone: honest, practical, teacher-to-teacher. Not parent-facing yet — the teacher will adapt it.`,
    ].join('\n'),
    buildUserPrompt: (rows, ctx) => buildStudentSummaryPrompt(rows, ctx.studentName),
  },
};

function buildStudentImprovementsPrompt(rows: any[], studentName: string): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const imp = fb.improvements;
    const summary = imp && Array.isArray(imp.summary) ? imp.summary : (Array.isArray(imp) ? imp : []);
    const detail = imp && Array.isArray(imp.detail) ? imp.detail : [];
    const top = (fb.top_priority && fb.top_priority.summary) || fb.top_priority || '';
    return [
      `--- ${studentName}, submission #${i + 1} ---`,
      `Course: ${r.course || '(unknown)'}  Task: ${r.task_title}  Draft: v${r.draft_version || 1}`,
      r.mark_pct != null ? `Mark: ${Math.round(r.mark_pct)}%` : '',
      `Top priority: ${top}`,
      `Improvements summary: ${JSON.stringify(summary)}`,
      detail.length ? `Improvements detail: ${JSON.stringify(detail).slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} of ${studentName}'s submissions. Identify patterns specific to this student.\n\n${lines}`;
}

function buildStudentStrengthsPrompt(rows: any[], studentName: string): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const w = fb.what_youve_done_well;
    const summary = w && Array.isArray(w.summary) ? w.summary : (Array.isArray(w) ? w : []);
    const detail = w && Array.isArray(w.detail) ? w.detail : [];
    return [
      `--- ${studentName}, submission #${i + 1} ---`,
      `Course: ${r.course || '(unknown)'}  Task: ${r.task_title}`,
      `Strengths summary: ${JSON.stringify(summary)}`,
      detail.length ? `Strengths detail: ${JSON.stringify(detail).slice(0, 1000)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} of ${studentName}'s submissions. Surface this student's most consistent strengths.\n\n${lines}`;
}

function buildStudentSummaryPrompt(rows: any[], studentName: string): string {
  // Summary needs the full picture: strengths + improvements + verb check.
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const imp = fb.improvements;
    const impSummary = imp && Array.isArray(imp.summary) ? imp.summary : (Array.isArray(imp) ? imp : []);
    const w = fb.what_youve_done_well;
    const wSummary = w && Array.isArray(w.summary) ? w.summary : (Array.isArray(w) ? w : []);
    const top = (fb.top_priority && fb.top_priority.summary) || fb.top_priority || '';
    const verbCheck = fb.task_verb_check;
    const verbSummary = (verbCheck && (verbCheck.summary || verbCheck)) || '';
    return [
      `--- ${studentName}, submission #${i + 1} ---`,
      `Course: ${r.course || '(unknown)'}  Task: ${r.task_title}  Draft: v${r.draft_version || 1}`,
      r.mark_pct != null ? `Mark: ${Math.round(r.mark_pct)}%` : '',
      `Top priority: ${top}`,
      `Strengths summary: ${JSON.stringify(wSummary)}`,
      `Improvements summary: ${JSON.stringify(impSummary)}`,
      verbSummary ? `Verb-handling note: ${typeof verbSummary === 'string' ? verbSummary.slice(0, 400) : JSON.stringify(verbSummary).slice(0, 400)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} of ${studentName}'s submissions. Write the narrative summary now.\n\n${lines}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const kind = String(req.body?.kind || '').trim();
  const isStudentKind = kind.startsWith('student_');
  const isClassProfileKind = kind === 'class_profile_summary';
  if (isStudentKind && !STUDENT_KIND_CONFIG[kind]) {
    return res.status(400).json({ error: 'kind must be one of: ' + Object.keys(STUDENT_KIND_CONFIG).join(', ') });
  }
  if (!isStudentKind && !isClassProfileKind && !KIND_CONFIG[kind]) {
    const all = [...Object.keys(KIND_CONFIG), ...Object.keys(STUDENT_KIND_CONFIG), 'class_profile_summary'];
    return res.status(400).json({ error: 'kind must be one of: ' + all.join(', ') });
  }

  const supabase = getSupabase();
  const overrideId = req.body?.school_id ? String(req.body.school_id) : null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, schoolName, callerRole, restrictedFaculties } = access;

  // ── Student-kind branch ─────────────────────────────────────────────
  // Single-student LLM cards run a separate flow: scope check, pull only
  // this student's submissions, build prompts with their name, no cache.
  if (isStudentKind) {
    const studentCfg = STUDENT_KIND_CONFIG[kind];
    return handleStudentKind(req, res, {
      supabase,
      user,
      kind,
      cfg: studentCfg,
      callerRole,
      schoolId,
      restrictedFaculties,
    });
  }

  // ── Class-profile-summary branch ────────────────────────────────────
  // Aggregates the longitudinal profiles of currently-enrolled students into
  // a cohort baseline picture. Read from student_profile_synthesis, never
  // touches raw drafts — so a new teacher inheriting students sees patterns
  // without seeing the prior teacher's submissions.
  if (isClassProfileKind) {
    return handleClassProfileSummary(req, res, {
      supabase,
      user,
      callerRole,
      schoolId,
      restrictedFaculties,
    });
  }
  const cfg = KIND_CONFIG[kind];

  const rawFilters = parseFiltersFromQuery(req.body as any);
  const filters = applyFacultyScope(rawFilters, restrictedFaculties);
  if (filters._denied) {
    return res.status(403).json({ error: 'Filter outside your access.' });
  }
  delete (filters as any)._denied;

  // Rate-limiting and the cache read both happen after the in-scope corpus is
  // loaded (below): a teacher-tier cache hit returns for free without
  // consuming the rate-limit budget, and we need the corpus to fingerprint it.
  const rateSubject = schoolId || user.id;

  // Pull submissions in scope. Teacher tier sees only their own classes.
  const allUsers = await listAllAuthUsers(supabase);
  const teacherIds = callerRole === 'teacher'
    ? [user.id]
    : await getSchoolTeacherIds(supabase, schoolId, allUsers as any);
  if (teacherIds.length === 0) {
    return res.status(400).json({ error: 'No teachers in scope yet.' });
  }
  const { data: classes } = await supabase
    .from('classes').select('id, course, teacher_id').in('teacher_id', teacherIds);
  const classMap: Record<string, any> = {};
  (classes || []).forEach(c => {
    classMap[c.id] = { ...c, faculty: c.course ? (getDisciplineForCourse(c.course) || 'Other') : 'Other' };
  });
  const classIds = Object.keys(classMap);
  if (classIds.length === 0) return res.status(400).json({ error: 'No classes in scope yet.' });

  const { data: rawTasks } = await supabase
    .from('tasks').select('id, title, question, course, class_id, total_marks, task_mode').in('class_id', classIds);
  const taskMap: Record<string, any> = {};
  (rawTasks || []).forEach(t => {
    const cls = classMap[t.class_id];
    taskMap[t.id] = {
      ...t,
      faculty: t.course ? (getDisciplineForCourse(t.course) || cls?.faculty || 'Other') : (cls?.faculty || 'Other'),
      task_mode: t.task_mode || 'feedback_task',
    };
  });
  const taskIds = Object.keys(taskMap);
  if (taskIds.length === 0) return res.status(400).json({ error: 'No tasks in scope yet.' });

  const subsCutoff = getTimeWindowCutoff(filters.time_window);
  let subsQuery = supabase
    .from('submissions')
    .select('id, task_id, student_id, draft_version, graded_at, total_mark, feedback, created_at')
    .in('task_id', taskIds);
  if (subsCutoff) subsQuery = subsQuery.gte('created_at', subsCutoff.toISOString());
  const { data: rawSubs } = await subsQuery;

  const allowedStudentIds = filters.year_level != null
    ? userIdsForYearLevel(allUsers as any, filters.year_level)
    : null;

  // Apply page-level filters.
  let submissions = (rawSubs || []).filter(s => {
    const t = taskMap[s.task_id];
    if (!t) return false;
    if (filters.faculty && t.faculty !== filters.faculty) return false;
    if (filters.course && t.course !== filters.course) return false;
    if (filters.class_id && t.class_id !== filters.class_id) return false;
    if (allowedStudentIds && (!s.student_id || !allowedStudentIds.has(s.student_id))) return false;
    if (!s.feedback) return false; // need AI feedback to synthesise from
    return true;
  });

  // Keep only the latest draft per (student, task). Anonymous submissions
  // (null student_id) bypass the dedupe — there's no "student" to dedupe
  // within, so colliding them under "null|<task>" would corrupt the sample.
  const byPair = new Map<string, any>();
  const anonSubs: any[] = [];
  for (const s of submissions) {
    if (!s.student_id || !s.task_id) {
      anonSubs.push(s);
      continue;
    }
    const k = s.student_id + '|' + s.task_id;
    const prev = byPair.get(k);
    if (!prev || (s.created_at || '') > (prev.created_at || '')) byPair.set(k, s);
  }
  submissions = [...byPair.values(), ...anonSubs];

  if (submissions.length === 0) {
    return res.status(400).json({ error: 'No submissions with AI feedback in scope yet. Have students submit drafts to generate feedback first.' });
  }

  // Class-level teacher view needs a 10-submission floor — otherwise the
  // LLM is synthesising from a sample too small to surface patterns.
  if (callerRole === 'teacher' && submissions.length < 10) {
    return res.status(400).json({
      error: 'This card needs at least 10 submissions with AI feedback before it can run. Keep encouraging drafts and try again.',
    });
  }

  // Compute mark % for decile-based kinds. quick_task is "not a graded
  // task" by design, so its mark_pct stays null even if the teacher chose
  // to give it a number — keeps it out of decile sampling.
  const enriched = submissions.map(s => {
    const t = taskMap[s.task_id] || {};
    const isGradedMode = t.task_mode !== 'quick_task';
    const markPct = (isGradedMode && s.graded_at && s.total_mark != null && t.total_marks)
      ? (Number(s.total_mark) / Number(t.total_marks)) * 100
      : null;
    return {
      id: s.id,
      feedback: s.feedback,
      faculty: t.faculty,
      course: t.course,
      task_title: t.title,
      task_question: t.question || '',
      task_mode: t.task_mode,
      mark_pct: markPct,
    };
  });

  // Pick the right subset per kind.
  let rows: any[];
  if (kind === 'bottom_decile' || kind === 'top_decile') {
    const graded = enriched.filter(r => r.mark_pct != null);
    const gradedFloor = callerRole === 'teacher' ? 4 : 5;
    if (graded.length < gradedFloor) {
      return res.status(400).json({ error: `Not enough graded submissions yet. This card needs at least ${gradedFloor} marked submissions in scope.` });
    }
    graded.sort((a, b) => (kind === 'bottom_decile' ? (a.mark_pct! - b.mark_pct!) : (b.mark_pct! - a.mark_pct!)));
    // Teacher tier (single class) uses quartile rather than decile — a
    // 10-student class produces only 1 decile-student, which is useless
    // for pattern-matching. Stretch goals / top mistakes for the top or
    // bottom 25% of the class is the sweet spot.
    const fraction = callerRole === 'teacher' ? 4 : 10;
    const sliceCount = Math.max(3, Math.min(MAX_SUBMISSIONS_TO_FEED, Math.ceil(graded.length / fraction)));
    rows = graded.slice(0, sliceCount);
  } else {
    // Verb depth / common gaps / things done well — feed whole cohort, capped.
    rows = enriched.slice(0, MAX_SUBMISSIONS_TO_FEED);
  }

  const filtersToStore = { ...filters };
  delete (filtersToStore as any)._denied;

  // -- Cache read --
  // Both tiers cache per (owner, kind, scope) with fingerprint freshness.
  //   - teacher  → teacher_insights_cards keyed by their own user id, so two
  //     teachers never share (different class ownership).
  //   - leader/admin → school_insights_cards keyed by (school, kind, scope), so
  //     an English HOD, an HSIE HOD and an executive each keep their own scoped
  //     card instead of overwriting one shared slot, while two leaders viewing
  //     the *same* scope reuse it.
  // A cache hit returns for free and skips the rate-limit.
  const scopeKey = scopeKeyForFilters(filters);
  const fingerprint = cohortFingerprint(submissions);
  const cacheHitResponse = (hit: any) => res.status(200).json({
    kind,
    content: hit.content,
    filters: filtersToStore,
    source_submission_count: hit.source_submission_count,
    source_task_count: hit.source_task_count,
    generated_at: hit.generated_at,
    source: 'cache',
  });
  const isFresh = (hit: any) =>
    hit && hit.fingerprint === fingerprint &&
    (Date.now() - new Date(hit.generated_at).getTime()) < CARD_CACHE_TTL_MS;

  if (callerRole === 'teacher') {
    const { data: hit } = await supabase
      .from('teacher_insights_cards')
      .select('content, fingerprint, source_submission_count, source_task_count, generated_at')
      .eq('teacher_id', user.id)
      .eq('card_kind', kind)
      .eq('scope_key', scopeKey)
      .maybeSingle();
    if (isFresh(hit)) return cacheHitResponse(hit);
  } else if (schoolId) {
    const { data: hit } = await supabase
      .from('school_insights_cards')
      .select('content, fingerprint, source_submission_count, source_task_count, generated_at')
      .eq('school_id', schoolId)
      .eq('card_kind', kind)
      .eq('scope_key', scopeKey)
      .maybeSingle();
    if (isFresh(hit)) return cacheHitResponse(hit);
  }

  // Rate-limit only actual generations (cache hits returned above). Each card
  // kind has its own endpoint name so the bucket is scoped per (subject, kind).
  const rateLimit = await checkAndLogRateLimit(supabase, rateSubject, {
    endpoint: cfg.endpointName,
    perUserPerHour: 5,
    globalPerDay: 200,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // -- Anthropic call --
  let value: any;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const result = await callTool<Record<string, any>>({
      client,
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.2,
      system: cfg.buildSystemPrompt(schoolName, rows.length),
      user: cfg.buildUserPrompt(rows, { schoolName }),
      tool: cfg.tool,
      cacheSystem: true,
      label: `insights:${kind}`,
    });
    value = result.value;
  } catch (err: any) {
    captureError(err, { stage: 'insights-card-generate', kind, school_id: schoolId, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate.' });
  }

  // Validate the model's output against each card's required keys before
  // caching. Tool-use returns are usually well-formed but a max_tokens
  // cutoff can leave required arrays missing. Don't cache garbage.
  const requiredKeys: Record<string, string[]> = {
    bottom_decile:     ['patterns'],
    top_decile:        ['next_steps'],
    common_gaps:       ['gaps', 'strengths'],
    things_done_well:  ['strengths'],
  };
  const missing = (requiredKeys[kind] || []).filter(k => !(k in (value || {})));
  if (missing.length > 0) {
    captureError(new Error('Incomplete tool output: missing ' + missing.join(', ')), { kind, school_id: schoolId });
    return res.status(502).json({ error: 'Generation finished but the response was incomplete. Try again — usually clears on retry.' });
  }

  // -- Cache write --
  const sourceTaskCount = new Set(rows.map(r => r.task_title)).size;
  const generatedAt = new Date().toISOString();
  if (callerRole === 'teacher') {
    // Teacher tier: cache per (teacher, kind, scope) so re-clicks with no new
    // submissions/marks return the cached card instead of regenerating.
    await supabase
      .from('teacher_insights_cards')
      .upsert({
        teacher_id: user.id,
        card_kind: kind,
        scope_key: scopeKey,
        content: value,
        fingerprint,
        source_submission_count: rows.length,
        source_task_count: sourceTaskCount,
        generated_at: generatedAt,
      });
  } else if (schoolId) {
    // Leader/admin tier: cache per (school, kind, scope) so different scopes
    // coexist and same-scope leaders share. fingerprint drives freshness.
    await supabase
      .from('school_insights_cards')
      .upsert({
        school_id: schoolId,
        card_kind: kind,
        scope_key: scopeKey,
        fingerprint,
        content: value,
        filters: filtersToStore,
        source_submission_count: rows.length,
        source_task_count: sourceTaskCount,
        generated_at: generatedAt,
        generated_by: user.id,
      });
  }

  // Fan the cohort STRENGTHS out into the things_done_well cache so that card
  // and the gaps card always come from this one consistent call.
  if (kind === 'common_gaps' && Array.isArray(value.strengths)) {
    const strengthsContent = { strengths: value.strengths };
    if (callerRole === 'teacher') {
      await supabase.from('teacher_insights_cards').upsert({
        teacher_id: user.id,
        card_kind: 'things_done_well',
        scope_key: scopeKey,
        content: strengthsContent,
        fingerprint,
        source_submission_count: rows.length,
        source_task_count: sourceTaskCount,
        generated_at: generatedAt,
      });
    } else if (schoolId) {
      await supabase.from('school_insights_cards').upsert({
        school_id: schoolId,
        card_kind: 'things_done_well',
        scope_key: scopeKey,
        fingerprint,
        content: strengthsContent,
        filters: filtersToStore,
        source_submission_count: rows.length,
        source_task_count: sourceTaskCount,
        generated_at: generatedAt,
        generated_by: user.id,
      });
    }
  }

  return res.status(200).json({
    kind,
    content: value,
    filters: filtersToStore,
    source_submission_count: rows.length,
    source_task_count: sourceTaskCount,
    generated_at: generatedAt,
  });
}

// ─────────────── Student-kind handler ───────────────

async function handleStudentKind(
  req: VercelRequest,
  res: VercelResponse,
  args: {
    supabase: ReturnType<typeof getSupabase>;
    user: { id: string; email?: string | null };
    kind: string;
    cfg: typeof STUDENT_KIND_CONFIG[string];
    callerRole: 'admin' | 'leader' | 'teacher';
    schoolId: string;
    restrictedFaculties: string[] | null;
  },
) {
  const { supabase, user, kind, cfg, callerRole, schoolId, restrictedFaculties } = args;
  const studentId = (req.body?.student_id ? String(req.body.student_id) : '').trim();
  if (!studentId) return res.status(400).json({ error: 'student_id is required for student-* kinds.' });

  // True global circuit breaker across ALL students/callers. userId=null so
  // this is a pure global check (no per-user component) on a shared key — the
  // ceiling the per-student cap below can't provide. Checked first so a request
  // that would breach the global budget is rejected before anything else runs.
  const globalGuard = await checkAndLogRateLimit(supabase, null, {
    endpoint: 'insights-card-student:global',
    perUserPerHour: 0, // unused when userId is null
    globalPerDay: STUDENT_CARD_GLOBAL_PER_DAY,
  });
  if (!globalGuard.ok) {
    if (globalGuard.retryAfterSeconds) res.setHeader('Retry-After', String(globalGuard.retryAfterSeconds));
    return res.status(429).json({ error: globalGuard.reason || 'ProofReady has hit its daily capacity. Please try again tomorrow.' });
  }

  // Rate-limit per (subject, kind, student) — endpointName already names
  // the kind, so include student_id in the rate-limit subject so spamming
  // one student doesn't lock out other students for the same caller.
  const rateSubject = schoolId || user.id;
  const rateLimit = await checkAndLogRateLimit(supabase, rateSubject, {
    endpoint: cfg.endpointName + ':' + studentId.slice(0, 8),
    perUserPerHour: 8,   // 4 cards × 2 regens per hour per student
    globalPerDay: 400,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // Scope check.
  const allowedStudents = new Set(await getInScopeStudentIds(
    supabase, callerRole, user.id, schoolId, restrictedFaculties,
  ));
  if (!allowedStudents.has(studentId)) {
    return res.status(404).json({ error: 'Student not visible to you.' });
  }

  // Caller's in-scope classes containing this student.
  const callerClassIds = await getInScopeClassIds(
    supabase, callerRole, user.id, schoolId, restrictedFaculties,
  );
  const { data: memberships } = await supabase
    .from('class_members').select('class_id').eq('student_id', studentId).in('class_id', callerClassIds);
  const studentClassIds = (memberships || []).map(m => m.class_id);
  if (studentClassIds.length === 0) {
    return res.status(400).json({ error: 'This student has no submissions in your scope yet.' });
  }

  const { data: taskRows } = await supabase
    .from('tasks').select('id, title, course, class_id, total_marks').in('class_id', studentClassIds);
  const taskMap: Record<string, any> = {};
  (taskRows || []).forEach(t => { taskMap[t.id] = t; });
  const taskIds = Object.keys(taskMap);
  if (taskIds.length === 0) {
    return res.status(400).json({ error: 'This student has no submissions in your scope yet.' });
  }

  const { data: rawSubs } = await supabase
    .from('submissions')
    .select('id, task_id, draft_version, graded_at, total_mark, feedback, created_at')
    .eq('student_id', studentId)
    .in('task_id', taskIds);

  // Need feedback to synthesise from. Floor at 3 submissions w/ feedback.
  const withFeedback = (rawSubs || []).filter(s => s.feedback);
  if (withFeedback.length < STUDENT_LLM_FLOOR) {
    return res.status(400).json({
      error: `Not enough data yet. This card needs at least ${STUDENT_LLM_FLOOR} submissions with AI feedback for this student (currently ${withFeedback.length}).`,
    });
  }

  // Keep the latest draft per task — drafts are useful for the velocity SQL
  // card but each task's "final" feedback is the strongest signal for
  // synthesis. (Multiple drafts of one task can otherwise double-weight
  // that task's themes in the prompt.)
  const latestByTask = new Map<string, any>();
  for (const s of withFeedback) {
    const k = s.task_id;
    const prev = latestByTask.get(k);
    if (!prev || (s.created_at || '') > (prev.created_at || '')) latestByTask.set(k, s);
  }
  const subs = [...latestByTask.values()].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  // Enrich for the prompt.
  const enriched = subs.map(s => {
    const t = taskMap[s.task_id] || {};
    const markPct = (s.graded_at && s.total_mark != null && t.total_marks)
      ? (Number(s.total_mark) / Number(t.total_marks)) * 100
      : null;
    return {
      feedback: s.feedback,
      course: t.course,
      task_title: t.title,
      draft_version: s.draft_version,
      mark_pct: markPct,
    };
  });

  // Student name (for prompt + response context). No email fallback: this
  // string is interpolated into LLM prompts, and a student's email address
  // must never reach Anthropic (privacy contract).
  const { data: { user: studentUser } } = await supabase.auth.admin.getUserById(studentId);
  const meta = (studentUser?.user_metadata || {}) as any;
  const studentName = meta.display_name || meta.full_name || meta.name || 'this student';

  // -- Anthropic call --
  let value: any;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const result = await callTool<Record<string, any>>({
      client,
      model: MODEL,
      max_tokens: 2000,
      temperature: 0.2,
      system: cfg.buildSystemPrompt(studentName, enriched.length),
      user: cfg.buildUserPrompt(enriched, { studentName }),
      tool: cfg.tool,
    });
    value = result.value;
  } catch (err: any) {
    captureError(err, { stage: 'insights-card-generate', kind, student_id: studentId, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate.' });
  }

  // Validate required keys.
  const requiredKeys: Record<string, string[]> = {
    student_top_mistakes:  ['mistakes'],
    student_stretch_goals: ['next_steps'],
    student_strengths:     ['strengths'],
    student_summary:       ['summary_paragraph', 'headline_strength', 'headline_priority', 'tone_note'],
  };
  const missing = (requiredKeys[kind] || []).filter(k => !(k in (value || {})));
  if (missing.length > 0) {
    captureError(new Error('Incomplete tool output: missing ' + missing.join(', ')), { kind, student_id: studentId });
    return res.status(502).json({ error: 'Generation finished but the response was incomplete. Try again — usually clears on retry.' });
  }

  return res.status(200).json({
    kind,
    student_id: studentId,
    content: value,
    source_submission_count: enriched.length,
    source_task_count: new Set(enriched.map(r => r.task_title)).size,
    generated_at: new Date().toISOString(),
  });
}

/**
 * class_profile_summary — aggregate the longitudinal profiles of one class's
 * currently-enrolled students. Profile-only; never touches raw drafts.
 *
 * Privacy: the prompt is given anonymised profile lines (no student names, no
 * draft quotes — the profile narratives are LLM-synthesised abstracts that
 * already strip raw content at generation time, per lib/student-profile.ts).
 */
async function handleClassProfileSummary(
  req: VercelRequest,
  res: VercelResponse,
  args: {
    supabase: ReturnType<typeof getSupabase>;
    user: { id: string; email?: string | null };
    callerRole: 'admin' | 'leader' | 'teacher';
    schoolId: string;
    restrictedFaculties: string[] | null;
  },
) {
  const { supabase, user, callerRole, schoolId, restrictedFaculties } = args;
  const classId = (req.body?.class_id ? String(req.body.class_id) : '').trim();
  if (!classId) return res.status(400).json({ error: 'class_id is required for class_profile_summary.' });

  // Access check — the caller must have this class in scope.
  const callerClassIds = await getInScopeClassIds(supabase, callerRole, user.id, schoolId, restrictedFaculties);
  if (!callerClassIds.includes(classId)) {
    return res.status(403).json({ error: 'You do not have access to this class.' });
  }

  // Rate-limit on the same per-card buckets so a teacher hammering refresh
  // doesn't drain the global LLM budget.
  const rateSubject = schoolId || user.id;
  const rateLimit = await checkAndLogRateLimit(supabase, rateSubject, {
    endpoint: 'insights-card-class-profile',
    perUserPerHour: 6,
    globalPerDay: 300,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // Enrolled students.
  const { data: members } = await supabase
    .from('class_members').select('student_id').eq('class_id', classId);
  const studentIds = (members || []).map(m => m.student_id).filter(Boolean) as string[];
  if (studentIds.length === 0) {
    return res.status(400).json({ error: 'This class has no enrolled students yet.' });
  }

  // Read cached profiles for the cohort. We intentionally do NOT regenerate
  // missing profiles here — that would spawn N LLM calls on page load. Profiles
  // populate as teachers view individual students or as marking/feedback events
  // land. Anyone missing today gets surfaced as needing more data.
  const { data: profileRows } = await supabase
    .from('student_profile_synthesis')
    .select('student_id, narrative, headline_strength, headline_priority, metrics, submission_count_at_generation')
    .in('student_id', studentIds);
  const profileMap = new Map<string, any>();
  (profileRows || []).forEach(p => profileMap.set(p.student_id, p));

  let established = 0;
  let developing = 0;
  let newCount = 0;
  let missing = 0;
  const profileLines: string[] = [];
  for (const sid of studentIds) {
    const p = profileMap.get(sid);
    if (!p) { missing++; continue; }
    const status = (p.metrics?.profile_status as string) || 'new';
    if (status === 'established') established++;
    else if (status === 'developing') developing++;
    else newCount++;

    const themes: string[] = Array.isArray(p.metrics?.improvement_themes) ? p.metrics.improvement_themes : [];
    const strengths: string[] = Array.isArray(p.metrics?.strength_themes) ? p.metrics.strength_themes : [];
    profileLines.push([
      `Profile (anonymised, status=${status}):`,
      `  headline_strength: ${p.headline_strength || ''}`,
      `  headline_priority: ${p.headline_priority || ''}`,
      themes.length ? `  improvement_themes: ${themes.slice(0, 5).join(' | ')}` : '',
      strengths.length ? `  strength_themes: ${strengths.slice(0, 5).join(' | ')}` : '',
      p.narrative ? `  narrative: ${String(p.narrative).slice(0, 400)}` : '',
    ].filter(Boolean).join('\n'));
  }

  // Too few established profiles → skip the LLM call and surface the breakdown.
  // 3 is the floor — below that, "aggregate" is misleading.
  if (profileLines.length < 3) {
    return res.status(200).json({
      kind: 'class_profile_summary',
      class_id: classId,
      content: {
        aggregate_narrative:
          `This class has too few existing profiles for a meaningful baseline yet. ${missing + newCount} of ${studentIds.length} students need more drafts before patterns emerge. The picture will fill in as marking lands this term.`,
        top_strengths: [],
        top_priorities: [],
      },
      cohort_breakdown: {
        total_students: studentIds.length,
        established_count: established,
        developing_count: developing,
        new_count: newCount,
        missing_profiles: missing,
      },
      generated_at: new Date().toISOString(),
    });
  }

  const system = [
    `You are aggregating the longitudinal academic profiles of students currently enrolled in one class.`,
    ``,
    `Your job is to give the class teacher a picture of where this cohort stands as they enter the class — informed by the students' history across ProofReady, not just this class's work.`,
    ``,
    `HARD RULES:`,
    `- Aggregate only. NEVER name an individual student.`,
    `- No mark or band predictions.`,
    `- Frame priorities as patterns the teacher can target in their first few weeks of lessons.`,
    `- Recognise variation honestly: if the cohort is mixed, say so. Don't homogenise.`,
    ``,
    `Cohort breakdown:`,
    `- Total students enrolled: ${studentIds.length}`,
    `- Established profiles (6+ submissions in their history): ${established}`,
    `- Developing (3–5 submissions): ${developing}`,
    `- New to ProofReady (≤2 submissions): ${newCount}`,
    `- Students with no profile cached yet: ${missing}`,
  ].join('\n');

  const userPrompt = `Below are ${profileLines.length} anonymised student profiles drawn from the cohort. Synthesise the class-level baseline.\n\n${profileLines.join('\n\n')}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const result = await callTool<Record<string, any>>({
      client,
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.2,
      system,
      user: userPrompt,
      tool: CLASS_PROFILE_SUMMARY_TOOL,
    });
    const value = result.value;

    const requiredKeys = ['aggregate_narrative', 'top_strengths', 'top_priorities'];
    const missingKeys = requiredKeys.filter(k => !(k in (value || {})));
    if (missingKeys.length > 0) {
      captureError(new Error('Incomplete tool output: missing ' + missingKeys.join(', ')), { kind: 'class_profile_summary', class_id: classId });
      return res.status(502).json({ error: 'Generation finished but the response was incomplete. Try again — usually clears on retry.' });
    }

    return res.status(200).json({
      kind: 'class_profile_summary',
      class_id: classId,
      content: value,
      cohort_breakdown: {
        total_students: studentIds.length,
        established_count: established,
        developing_count: developing,
        new_count: newCount,
        missing_profiles: missing,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    captureError(err, { stage: 'insights-card-class-profile', class_id: classId, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate.' });
  }
}
