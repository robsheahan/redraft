import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { getSchoolTeacherIds, getSchoolStudentIds } from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { withHandler } from '../lib/with-handler.js';

/**
 * Admin-only usage dashboard endpoint. Gated by lib/admin.ts (user_id
 * preferred, email fallback). Only returns aggregate counts and recent
 * activity — not personally identifiable content like draft text.
 */

export default withHandler({ methods: ['GET'], auth: 'optional', label: 'admin-stats' }, async (req, res, ctx) => {
  const user = ctx.user;
  if (!user || !isGlobalAdmin(user)) {
    return res.status(404).json({ error: 'Not found' }); // 404 rather than 403 so admin existence isn't advertised
  }

  const supabase = getSupabase();

  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    totalClasses,
    totalTasks,
    totalSubmissions,
    classesLast7d,
    tasksLast7d,
    submissionsLast24h,
    submissionsLast7d,
    apiCalls24h,
    { data: users },
    { data: recentSubmissions },
    { data: recentTasks },
  ] = await Promise.all([
    supabase.from('classes').select('id', { count: 'exact', head: true }),
    supabase.from('tasks').select('id', { count: 'exact', head: true }),
    supabase.from('submissions').select('id', { count: 'exact', head: true }),
    supabase.from('classes').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    supabase.from('tasks').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    supabase.from('submissions').select('id', { count: 'exact', head: true }).gte('created_at', oneDayAgo),
    supabase.from('submissions').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
    supabase.from('api_call_log').select('id', { count: 'exact', head: true }).gte('created_at', oneDayAgo),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('submissions').select('id, task_id, draft_version, created_at, student_id').order('created_at', { ascending: false }).limit(25),
    supabase.from('tasks').select('id, title, course, class_id, created_at, classes(name, teacher_id)').order('created_at', { ascending: false }).limit(10),
  ]);

  // User role breakdown
  let teacherCount = 0;
  let studentCount = 0;
  let unroledCount = 0;
  const userList = users?.users || [];
  for (const u of userList) {
    const role = u.app_metadata?.role ?? u.user_metadata?.role;
    if (role === 'teacher') teacherCount++;
    else if (role === 'student') studentCount++;
    else unroledCount++;
  }

  // Build a user lookup for the recent submissions list
  const userMap: Record<string, { name: string; email: string }> = {};
  userList.forEach(u => {
    userMap[u.id] = {
      name: (u.user_metadata?.display_name as string)
        || (u.user_metadata?.full_name as string)
        || (u.user_metadata?.name as string)
        || u.email || 'unknown',
      email: u.email || '',
    };
  });

  const recentSubmissionsWithEmail = (recentSubmissions || []).map(s => ({
    id: s.id,
    task_id: s.task_id,
    draft_version: s.draft_version,
    created_at: s.created_at,
    student_name: s.student_id ? userMap[s.student_id]?.name || 'unknown' : 'anon',
    student_email: s.student_id ? userMap[s.student_id]?.email || '' : '',
  }));

  const recentTasksAnnotated = (recentTasks || []).map((t: any) => {
    const cls = t.classes || {};
    const teacherId = cls.teacher_id;
    return {
      id: t.id,
      title: t.title || '(untitled)',
      course: t.course,
      class_name: cls.name || null,
      created_at: t.created_at,
      teacher_name: teacherId ? userMap[teacherId]?.name || 'unknown' : 'unknown',
      teacher_email: teacherId ? userMap[teacherId]?.email || '' : '',
    };
  });

  // Full user roster for "who's signed up" view. Sorted by created_at desc.
  const allUsers = userList
    .map(u => ({
      id: u.id,
      email: u.email || '',
      name: userMap[u.id]?.name || u.email || 'unknown',
      role: ((u.app_metadata?.role ?? u.user_metadata?.role) as string) || null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at || null,
      email_domain: (u.email || '').split('@')[1] || '',
    }))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  // Aggregate by email domain so Rob can see uptake by school at a glance.
  const domainCounts: Record<string, { total: number; teachers: number; students: number }> = {};
  for (const u of allUsers) {
    const d = u.email_domain || '(unknown)';
    if (!domainCounts[d]) domainCounts[d] = { total: 0, teachers: 0, students: 0 };
    domainCounts[d].total++;
    if (u.role === 'teacher') domainCounts[d].teachers++;
    else if (u.role === 'student') domainCounts[d].students++;
  }
  const byDomain = Object.entries(domainCounts)
    .map(([domain, c]) => ({ domain, ...c }))
    .sort((a, b) => b.total - a.total);

  // Schools meta view: every school, with member breakdown + inferred staff.
  const { data: schoolRows, error: schoolsError } = await supabase
    .from('schools')
    .select('id, name, primary_domain, secondary_domains, insights_cache_generated_at, insights_cache_task_count, created_at')
    .order('name');
  if (schoolsError) {
    console.error('[admin-stats] schools query failed:', schoolsError.message);
  }

  // Look up which schools have an LTI platform attached. The FK lives on
  // lti_platforms.school_id, not on schools.
  const { data: ltiLinks } = await supabase
    .from('lti_platforms')
    .select('school_id')
    .not('school_id', 'is', null);
  const ltiLinkedSchoolIds = new Set((ltiLinks || []).map(p => p.school_id));

  // Pull all grants in one shot
  const { data: allGrants } = await supabase
    .from('school_members')
    .select('school_id, user_id, role, faculties');
  const grantsBySchool: Record<string, Array<{ role: string; faculties: string[] }>> = {};
  (allGrants || []).forEach(g => {
    if (!g.school_id) return;
    (grantsBySchool[g.school_id] ||= []).push({
      role: g.role,
      faculties: Array.isArray(g.faculties) ? g.faculties : [],
    });
  });

  // Share the already-loaded auth users list with getSchool*Ids so we
  // don't pay the listUsers cost again per school.
  const preloadedUsers = userList as any;
  const schools = await Promise.all((schoolRows || []).map(async (s) => {
    const [teacherIds, studentIds] = await Promise.all([
      getSchoolTeacherIds(supabase, s.id, preloadedUsers),
      getSchoolStudentIds(supabase, s.id, preloadedUsers),
    ]);
    let classCount = 0, taskCount = 0, submissionCount = 0;
    if (teacherIds.length > 0) {
      const { data: cls } = await supabase.from('classes').select('id').in('teacher_id', teacherIds);
      const classIds = (cls || []).map(c => c.id);
      classCount = classIds.length;
      if (classIds.length > 0) {
        const tasksRes = await supabase.from('tasks').select('id', { count: 'exact', head: true }).in('class_id', classIds);
        taskCount = tasksRes.count || 0;
        const { data: tRows } = await supabase.from('tasks').select('id').in('class_id', classIds);
        const taskIds = (tRows || []).map(t => t.id);
        if (taskIds.length > 0) {
          const subsRes = await supabase.from('submissions').select('id', { count: 'exact', head: true }).in('task_id', taskIds);
          submissionCount = subsRes.count || 0;
        }
      }
    }
    const grants = grantsBySchool[s.id] || [];
    return {
      id: s.id,
      name: s.name,
      primary_domain: s.primary_domain || null,
      secondary_domains: s.secondary_domains || [],
      lti_linked: ltiLinkedSchoolIds.has(s.id),
      created_at: s.created_at,
      staff_count: teacherIds.length,
      student_count: studentIds.length,
      admin_count: grants.filter(g => g.role === 'admin').length,
      leader_count: grants.filter(g => g.role === 'leader').length,
      class_count: classCount,
      task_count: taskCount,
      submission_count: submissionCount,
      insights_generated_at: s.insights_cache_generated_at || null,
      insights_task_count: s.insights_cache_task_count || 0,
    };
  }));

  // Insights usage roll-up — how often each LLM card / synthesis is being
  // generated. Reads the rate-limit log which already records every
  // generation, so no extra instrumentation is needed.
  const INSIGHT_ENDPOINTS: Record<string, string> = {
    'insights-card-bottom-decile':    'Bottom-decile mistakes',
    'insights-card-top-decile':       'Top-decile next steps',
    'insights-card-verb-depth':       'Verb-depth handling',
    'insights-card-common-gaps':      'Cohort gaps',
    'insights-card-things-done-well': 'Things done well',
    'insights-synthesis':             'Cross-faculty synthesis',
    'generate-class-feedback':        'Class feedback (per-task)',
  };
  const insightEndpoints = Object.keys(INSIGHT_ENDPOINTS);
  const [allInsightsRes, last24hInsightsRes, last7dInsightsRes] = await Promise.all([
    supabase.from('api_call_log').select('endpoint, user_id').in('endpoint', insightEndpoints),
    supabase.from('api_call_log').select('endpoint').in('endpoint', insightEndpoints).gte('created_at', oneDayAgo),
    supabase.from('api_call_log').select('endpoint').in('endpoint', insightEndpoints).gte('created_at', sevenDaysAgo),
  ]);
  const totals: Record<string, number> = {};
  const schoolsUsing: Record<string, Set<string>> = {};
  (allInsightsRes.data || []).forEach(r => {
    if (!r.endpoint) return;
    totals[r.endpoint] = (totals[r.endpoint] || 0) + 1;
    // user_id for insights endpoints is the school UUID (the rate-limit
    // bucket key). Synthesis + every per-card generator follow the same
    // convention.
    if (r.user_id) {
      (schoolsUsing[r.endpoint] ||= new Set()).add(r.user_id);
    }
  });
  const last24h: Record<string, number> = {};
  (last24hInsightsRes.data || []).forEach(r => { if (r.endpoint) last24h[r.endpoint] = (last24h[r.endpoint] || 0) + 1; });
  const last7d: Record<string, number> = {};
  (last7dInsightsRes.data || []).forEach(r => { if (r.endpoint) last7d[r.endpoint] = (last7d[r.endpoint] || 0) + 1; });

  const insightsUsage = insightEndpoints.map(ep => ({
    endpoint: ep,
    label: INSIGHT_ENDPOINTS[ep],
    total: totals[ep] || 0,
    last_7d: last7d[ep] || 0,
    last_24h: last24h[ep] || 0,
    distinct_schools: (schoolsUsing[ep] || new Set()).size,
  })).sort((a, b) => b.total - a.total);

  return res.status(200).json({
    counts: {
      users: {
        total: userList.length,
        teachers: teacherCount,
        students: studentCount,
        unroled: unroledCount,
      },
      classes: {
        total: totalClasses.count || 0,
        last7d: classesLast7d.count || 0,
      },
      tasks: {
        total: totalTasks.count || 0,
        last7d: tasksLast7d.count || 0,
      },
      submissions: {
        total: totalSubmissions.count || 0,
        last24h: submissionsLast24h.count || 0,
        last7d: submissionsLast7d.count || 0,
      },
      api_calls_24h: apiCalls24h.count || 0,
    },
    schools,
    insights_usage: insightsUsage,
    recent_submissions: recentSubmissionsWithEmail,
    recent_tasks: recentTasksAnnotated,
    users: allUsers,
    by_domain: byDomain,
  });
});
