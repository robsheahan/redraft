import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { SCHOOL_INSIGHTS_TOOL } from '../lib/feedback-tools.js';
import { resolveUserSchool, getSchoolTeacherIds, canViewInsights } from '../lib/schools.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { isGlobalAdmin } from '../lib/admin.js';

const MODEL = 'claude-sonnet-4-6';

/**
 * Leadership insights synthesis.
 *
 *   GET  → returns the cached synthesis + meta for the caller's school
 *   POST → regenerates the synthesis (rate-limited per school, not per user)
 *
 * Auth: caller must be an explicit school_member (admin or leader). Global
 * admins (lib/admin.ts) bypass via ?school_id= for development access.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();

  // Resolve the caller's school. Global admins can pass ?school_id=... to
  // view any school (useful for development).
  let schoolId: string | null = null;
  let schoolName = '';
  let callerRole: 'admin' | 'leader' | null = null;

  const overrideId = (req.method === 'GET' ? (req.query.school_id as string) : (req.body?.school_id as string)) || null;
  if (overrideId && isGlobalAdmin(user)) {
    const { data: s } = await supabase.from('schools').select('id, name').eq('id', overrideId).maybeSingle();
    if (!s) return res.status(404).json({ error: 'School not found.' });
    schoolId = s.id;
    schoolName = s.name;
    // Global admins viewing via override get full admin powers in the UI.
    callerRole = 'admin';
  } else {
    const ctx = await resolveUserSchool(supabase, user.id);
    if (!ctx) {
      if (isGlobalAdmin(user)) {
        return res.status(400).json({ error: 'No school resolved. Pass ?school_id=... to scope the view.' });
      }
      return res.status(404).json({ error: 'Not found' });
    }
    const allowed = ctx.role !== null || await canViewInsights(supabase, user.id, ctx.school_id) || isGlobalAdmin(user);
    if (!allowed) return res.status(404).json({ error: 'Not found' });
    schoolId = ctx.school_id;
    schoolName = ctx.school_name;
    callerRole = ctx.role;
  }

  // -------- GET: return cached --------
  if (req.method === 'GET') {
    // Cheap probe: skip the stats roll-up. Used by other pages (teacher
    // nav etc.) to decide whether to surface the Insights link.
    if (req.query.probe === '1') {
      return res.status(200).json({
        has_access: true,
        school: { id: schoolId, name: schoolName },
        caller_role: callerRole,
      });
    }

    const { data: school } = await supabase
      .from('schools')
      .select('id, name, insights_cache, insights_cache_task_count, insights_cache_generated_at')
      .eq('id', schoolId)
      .maybeSingle();
    if (!school) return res.status(404).json({ error: 'School not found.' });

    // Determine the viewer's faculty scope. Admins (school admin OR global
    // admin) are unrestricted. Leaders with a non-empty faculties array see
    // only those faculties' cards from by_faculty, with school-wide
    // aggregates suppressed so they can't be misread.
    const { data: grant } = await supabase
      .from('school_members')
      .select('role, faculties')
      .eq('school_id', schoolId)
      .eq('user_id', user.id)
      .maybeSingle();
    const isAdminViewer = isGlobalAdmin(user) || (grant && grant.role === 'admin');
    const restrictedFaculties = (!isAdminViewer
      && grant
      && grant.role === 'leader'
      && Array.isArray(grant.faculties)
      && grant.faculties.length > 0)
        ? (grant.faculties as string[])
        : null;

    let insights = school.insights_cache || null;
    let restrictedView = false;
    if (insights && restrictedFaculties) {
      const filteredFaculty = (insights.by_faculty || []).filter((f: any) => restrictedFaculties.includes(f.faculty));
      insights = {
        by_faculty: filteredFaculty,
        restricted_view: true,
        viewer_faculties: restrictedFaculties,
      };
      restrictedView = true;
    }

    const stats = await collectScopeStats(supabase, schoolId);
    return res.status(200).json({
      school: { id: school.id, name: school.name },
      caller_role: callerRole,
      caller_faculties: restrictedFaculties,
      restricted_view: restrictedView,
      stats,
      insights,
      task_count: school.insights_cache_task_count || 0,
      generated_at: school.insights_cache_generated_at || null,
    });
  }

  // -------- POST: regenerate --------

  // Rate-limit per school (not per user) so multiple leaders sharing the
  // dashboard don't burn through individual caps. We log under a synthetic
  // user_id = the school id to scope the bucket.
  const rateLimit = await checkAndLogRateLimit(supabase, schoolId, {
    endpoint: 'insights-synthesis',
    perUserPerHour: 3,   // 3 regenerations per hour per school
    globalPerDay: 100,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded. Please try again later.' });
  }

  const teacherIds = await getSchoolTeacherIds(supabase, schoolId);
  if (teacherIds.length === 0) {
    return res.status(400).json({ error: 'No teachers identified for this school yet. Once teachers create classes and tasks, an insights synthesis becomes possible.' });
  }

  // Fetch every task with cached class_feedback, owned by a teacher in this
  // school. We rely on the per-task class_feedback summaries instead of
  // re-feeding raw submissions — keeps cost bounded and respects each
  // teacher's existing synthesis.
  const { data: classes } = await supabase
    .from('classes')
    .select('id, teacher_id')
    .in('teacher_id', teacherIds);
  const classIds = (classes || []).map(c => c.id);
  if (classIds.length === 0) {
    return res.status(400).json({ error: 'No classes found for this school yet.' });
  }

  const { data: tasks, error: tasksError } = await supabase
    .from('tasks')
    .select('id, title, course, class_id, class_feedback, class_feedback_count, class_feedback_generated_at')
    .in('class_id', classIds)
    .not('class_feedback', 'is', null);
  if (tasksError) return res.status(500).json({ error: tasksError.message });

  const usableTasks = (tasks || []).filter(t => t.class_feedback && typeof t.class_feedback === 'object');
  if (usableTasks.length === 0) {
    return res.status(400).json({
      error: 'No class-level feedback to roll up yet. Ask teachers to generate class feedback on a task first.',
    });
  }

  // Tag each task with its faculty for the model.
  const taggedTasks = usableTasks.map(t => ({
    title: t.title || '(untitled)',
    course: t.course || '',
    faculty: t.course ? (getDisciplineForCourse(t.course) || 'Other') : 'Other',
    feedback: t.class_feedback as any,
  }));

  const systemPrompt = buildSystemPrompt(schoolName, taggedTasks.length);
  const userPrompt = buildUserPrompt(schoolName, taggedTasks);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await callTool<Record<string, any>>({
      client,
      model: MODEL,
      max_tokens: 3000,
      temperature: 0.2,
      system: systemPrompt,
      user: userPrompt,
      tool: SCHOOL_INSIGHTS_TOOL,
    });
    const insights = result.value;
    const generatedAt = new Date().toISOString();

    await supabase
      .from('schools')
      .update({
        insights_cache: insights,
        insights_cache_task_count: taggedTasks.length,
        insights_cache_generated_at: generatedAt,
      })
      .eq('id', schoolId);

    const stats = await collectScopeStats(supabase, schoolId);
    return res.status(200).json({
      school: { id: schoolId, name: schoolName },
      caller_role: callerRole,
      stats,
      insights,
      task_count: taggedTasks.length,
      generated_at: generatedAt,
    });
  } catch (err: any) {
    captureError(err, { stage: 'insights-synthesis', school_id: schoolId, user_id: user.id });
    return res.status(500).json({ error: err?.message || 'Failed to generate insights.' });
  }
}

async function collectScopeStats(supabase: ReturnType<typeof getSupabase>, schoolId: string) {
  const teacherIds = await getSchoolTeacherIds(supabase, schoolId);
  const teacherCount = teacherIds.length;

  let classCount = 0;
  let taskCount = 0;
  let taskWithFeedbackCount = 0;
  let submissionCount = 0;

  if (teacherIds.length > 0) {
    const { data: classes } = await supabase
      .from('classes').select('id').in('teacher_id', teacherIds);
    const classIds = (classes || []).map(c => c.id);
    classCount = classIds.length;

    if (classIds.length > 0) {
      const tasksRes = await supabase
        .from('tasks').select('id', { count: 'exact', head: true }).in('class_id', classIds);
      const tasksFbRes = await supabase
        .from('tasks').select('id', { count: 'exact', head: true })
        .in('class_id', classIds).not('class_feedback', 'is', null);
      taskCount = tasksRes.count || 0;
      taskWithFeedbackCount = tasksFbRes.count || 0;

      // Submissions: tasks → submissions, just a count
      const { data: taskRows } = await supabase
        .from('tasks').select('id').in('class_id', classIds);
      const taskIds = (taskRows || []).map(t => t.id);
      if (taskIds.length > 0) {
        const subsRes = await supabase
          .from('submissions').select('id', { count: 'exact', head: true }).in('task_id', taskIds);
        submissionCount = subsRes.count || 0;
      }
    }
  }

  return {
    teachers: teacherCount,
    classes: classCount,
    tasks_total: taskCount,
    tasks_with_feedback: taskWithFeedbackCount,
    submissions: submissionCount,
  };
}

function buildSystemPrompt(schoolName: string, taskCount: number): string {
  return [
    `You are an experienced NSW NESA-trained educator producing a leadership-level synthesis of student writing performance across an entire school. The audience is school leadership: Head of Teaching & Learning, Deputy Principal (curriculum), or Director of Studies.`,
    ``,
    `School: ${schoolName}`,
    `Tasks rolled up: ${taskCount}`,
    ``,
    `You will receive a series of per-task class-level feedback summaries — each already an aggregation across a class. Your job is to roll these up further, into a SCHOOL-level overview. Look for patterns that span tasks, classes, and faculties. Surface the cross-cutting issues a head of teaching & learning could address with whole-staff PD, cross-KLA moderation, or targeted intervention.`,
    ``,
    `VOICE AND TONE:`,
    `- Write directly to school leadership. Professional, concise, practical.`,
    `- Use "students across the school", "across faculties", "in the senior cohort". Avoid singling out classes or teachers.`,
    `- Be honest about gaps. Empty praise is not useful to leadership.`,
    `- Do not predict marks, bands, or HSC scores. This is qualitative.`,
    ``,
    `STRICT RULES:`,
    `- Never name an individual student.`,
    `- Never name an individual teacher.`,
    `- Never identify a specific class by code or join code.`,
    `- Aggregate patterns only. The granularity is the FACULTY level, not the class level.`,
    `- "Faculty" means the NSW KLA grouping (English, Mathematics, Science, HSIE, PDHPE, TAS, Creative Arts, Languages, VET, Other).`,
    `- If only one or two tasks exist for a faculty, note the small sample size in the by_faculty entry rather than over-generalising.`,
    ``,
    `INTERNAL CONSISTENCY (critical):`,
    `- school_strengths and school_weaknesses must NOT contradict each other. Never list a skill as a strength if its absence appears in the gaps, or vice versa — e.g. do NOT praise "use of concrete, real-world evidence to support claims" while also listing "claims made without evidence or examples" as a gap.`,
    `- If a skill is genuinely uneven across the cohort, name it in ONE list only and describe it as inconsistent (e.g. "evidence use is emerging but not yet consistent"), rather than asserting it is both a strength and a weakness.`,
    `- Before finalising, re-read school_strengths against school_weaknesses and remove or reframe any point that conflicts with the other list.`,
  ].join('\n');
}

function buildUserPrompt(schoolName: string, tasks: Array<{ title: string; course: string; faculty: string; feedback: any }>): string {
  const block = tasks.map((t, i) => {
    const fb = t.feedback || {};
    return [
      `--- Task ${i + 1} ---`,
      `Faculty: ${t.faculty}`,
      `Course: ${t.course || '(unknown)'}`,
      `Title: ${t.title}`,
      `Snapshot: ${fb.overall_snapshot || ''}`,
      `Strengths: ${JSON.stringify(fb.class_strengths || [])}`,
      `Weaknesses: ${JSON.stringify(fb.class_weaknesses || [])}`,
      `Verb adherence: ${fb.task_verb_adherence || ''}`,
      `Top priorities: ${JSON.stringify(fb.top_priorities || [])}`,
    ].join('\n');
  }).join('\n\n');

  return [
    `Synthesise the following ${tasks.length} task-level class-feedback rollups into a single school-level overview for ${schoolName}.`,
    ``,
    `When you fill in the by_faculty array, group tasks by their Faculty tag (a NESA KLA). Only include a faculty if at least one task contributes to it.`,
    ``,
    block,
    ``,
    `Now produce the school-level synthesis. Look for cross-faculty patterns first; if a finding only appears in one faculty, flag it as such in the by_faculty entry rather than the school-level lists.`,
  ].join('\n');
}
