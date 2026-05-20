import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { resolveInsightsAccess, getSchoolTeacherIds } from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import {
  parseFiltersFromQuery,
  applyFacultyScope,
  userIdsForYearLevel,
} from '../lib/insights-filters.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import {
  BOTTOM_DECILE_TOOL,
  TOP_DECILE_TOOL,
  VERB_DEPTH_TOOL,
  COMMON_GAPS_TOOL,
  THINGS_DONE_WELL_TOOL,
} from '../lib/feedback-tools.js';

/**
 * Generate a single Tier-A LLM insight card for a school.
 *
 *   POST /api/insights-card-generate
 *     body: { kind, school_id?, faculty?, course?, class_id?, year_level? }
 *
 * Kinds: bottom_decile | top_decile | verb_depth | common_gaps | things_done_well
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
  verb_depth: {
    tool: VERB_DEPTH_TOOL,
    endpointName: 'insights-card-verb-depth',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained marker analysing how a school's students handle NESA directive verbs (analyse, evaluate, justify, assess, explain, discuss, etc.).`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions across the school.`,
      ``,
      `You'll receive each submission's task verb check (the AI's per-submission verdict on how the student executed the task verb), tagged with faculty and the task's question. Identify the cross-school patterns by verb.`,
      ``,
      `RULES:`,
      `- One entry per verb, only for verbs with clear signal.`,
      `- Tag each verb's severity: 'strength' (executed well), 'mixed' (varies), 'concern' (consistently fall short).`,
      `- List which faculties (KLAs) the pattern appears in.`,
      `- This is the most actionable HSC diagnostic — be sharp and specific.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildVerbDepthPrompt(rows),
  },
  common_gaps: {
    tool: COMMON_GAPS_TOOL,
    endpointName: 'insights-card-common-gaps',
    buildSystemPrompt: (schoolName, sample) => [
      `You are a senior NSW NESA-trained educator analysing whole-cohort writing performance.`,
      `School: ${schoolName}`,
      `Sample size: ${sample} submissions across the school.`,
      ``,
      `Identify the top 5 gaps appearing in AI improvement feedback. Unlike the bottom-decile card, this is the FULL cohort — surfaces patterns that need whole-staff PD, not just intervention.`,
    ].join('\n'),
    buildUserPrompt: (rows) => buildImprovementsPrompt(rows, 'student'),
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

function buildVerbDepthPrompt(rows: any[]): string {
  const lines = rows.map((r, i) => {
    const fb = r.feedback || {};
    const verbCheck = fb.task_verb_check;
    const verbSummary = (verbCheck && (verbCheck.summary || verbCheck)) || '';
    const verbDetail = (verbCheck && verbCheck.detail) || '';
    return [
      `--- submission #${i + 1} ---`,
      `Faculty: ${r.faculty || 'Other'}  Course: ${r.course || '(unknown)'}`,
      `Task question (verb cue lives here): ${(r.task_question || '').slice(0, 300)}`,
      `Verb check summary: ${verbSummary}`,
      verbDetail ? `Verb check detail: ${String(verbDetail).slice(0, 800)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `Below are ${rows.length} per-submission verb checks. Surface the cross-school patterns now.\n\n${lines}`;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const kind = String(req.body?.kind || '').trim();
  if (!KIND_CONFIG[kind]) {
    return res.status(400).json({ error: 'kind must be one of: ' + Object.keys(KIND_CONFIG).join(', ') });
  }
  const cfg = KIND_CONFIG[kind];

  const supabase = getSupabase();
  const overrideId = req.body?.school_id ? String(req.body.school_id) : null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, schoolName, restrictedFaculties } = access;

  const rawFilters = parseFiltersFromQuery(req.body as any);
  const filters = applyFacultyScope(rawFilters, restrictedFaculties);
  if (filters._denied) {
    return res.status(403).json({ error: 'Filter outside your access.' });
  }
  delete (filters as any)._denied;

  // Rate-limit per school — each card kind has its own endpoint name so
  // the bucket is naturally scoped per (school, kind) without needing to
  // smuggle the kind into the user_id (which must be a valid UUID FK).
  const rateLimit = await checkAndLogRateLimit(supabase, schoolId, {
    endpoint: cfg.endpointName,
    perUserPerHour: 5,
    globalPerDay: 200,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  // Pull submissions in scope.
  const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const teacherIds = await getSchoolTeacherIds(supabase, schoolId, allUsers as any);
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
    .from('tasks').select('id, title, question, course, class_id, total_marks').in('class_id', classIds);
  const taskMap: Record<string, any> = {};
  (rawTasks || []).forEach(t => {
    const cls = classMap[t.class_id];
    taskMap[t.id] = {
      ...t,
      faculty: t.course ? (getDisciplineForCourse(t.course) || cls?.faculty || 'Other') : (cls?.faculty || 'Other'),
    };
  });
  const taskIds = Object.keys(taskMap);
  if (taskIds.length === 0) return res.status(400).json({ error: 'No tasks in scope yet.' });

  const { data: rawSubs } = await supabase
    .from('submissions')
    .select('id, task_id, student_id, draft_version, graded_at, total_mark, feedback, created_at')
    .in('task_id', taskIds);

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

  // Keep only the latest draft per (student, task) so we don't double-count.
  const byPair = new Map<string, any>();
  for (const s of submissions) {
    const k = s.student_id + '|' + s.task_id;
    const prev = byPair.get(k);
    if (!prev || (s.created_at || '') > (prev.created_at || '')) byPair.set(k, s);
  }
  submissions = [...byPair.values()];

  if (submissions.length === 0) {
    return res.status(400).json({ error: 'No submissions with AI feedback in scope yet. Have students submit drafts to generate feedback first.' });
  }

  // Compute mark % for decile-based kinds.
  const enriched = submissions.map(s => {
    const t = taskMap[s.task_id] || {};
    const markPct = (s.graded_at && s.total_mark != null && t.total_marks)
      ? (Number(s.total_mark) / Number(t.total_marks)) * 100
      : null;
    return {
      id: s.id,
      feedback: s.feedback,
      faculty: t.faculty,
      course: t.course,
      task_title: t.title,
      task_question: t.question || '',
      mark_pct: markPct,
    };
  });

  // Pick the right subset per kind.
  let rows: any[];
  if (kind === 'bottom_decile' || kind === 'top_decile') {
    const graded = enriched.filter(r => r.mark_pct != null);
    if (graded.length < 5) {
      return res.status(400).json({ error: 'Not enough graded submissions yet. This card needs at least 5 marked submissions in scope.' });
    }
    graded.sort((a, b) => (kind === 'bottom_decile' ? (a.mark_pct! - b.mark_pct!) : (b.mark_pct! - a.mark_pct!)));
    const decileCount = Math.max(3, Math.min(MAX_SUBMISSIONS_TO_FEED, Math.ceil(graded.length / 10)));
    rows = graded.slice(0, decileCount);
  } else {
    // Verb depth / common gaps / things done well — feed whole cohort, capped.
    rows = enriched.slice(0, MAX_SUBMISSIONS_TO_FEED);
  }

  // -- Anthropic call --
  let value: any;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await callTool<Record<string, any>>({
      client,
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.2,
      system: cfg.buildSystemPrompt(schoolName, rows.length),
      user: cfg.buildUserPrompt(rows, { schoolName }),
      tool: cfg.tool,
    });
    value = result.value;
  } catch (err: any) {
    captureError(err, { stage: 'insights-card-generate', kind, school_id: schoolId, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate.' });
  }

  // -- Cache --
  const filtersToStore = { ...filters };
  delete (filtersToStore as any)._denied;
  await supabase
    .from('school_insights_cards')
    .upsert({
      school_id: schoolId,
      card_kind: kind,
      content: value,
      filters: filtersToStore,
      source_submission_count: rows.length,
      source_task_count: new Set(rows.map(r => r.task_title)).size,
      generated_at: new Date().toISOString(),
      generated_by: user.id,
    });

  return res.status(200).json({
    kind,
    content: value,
    filters: filtersToStore,
    source_submission_count: rows.length,
    source_task_count: new Set(rows.map(r => r.task_title)).size,
    generated_at: new Date().toISOString(),
  });
}
