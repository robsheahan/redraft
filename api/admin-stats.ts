import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Admin-only usage dashboard endpoint.
 *
 * Gated by a hardcoded email allowlist via the ADMIN_EMAILS env var
 * (comma-separated). Only returns aggregate counts and recent activity —
 * not personally identifiable content like draft text.
 */

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'robert.sheahan@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function isAdmin(email: string | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user || !isAdmin(user.email)) {
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
    const role = u.user_metadata?.role;
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

  const recentSubmissionsAnnotated = (recentSubmissions || []).map(s => ({
    id: s.id,
    task_id: s.task_id,
    draft_version: s.draft_version,
    created_at: s.created_at,
    student_name: s.student_id ? userMap[s.student_id]?.name || 'unknown' : 'anon',
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
    };
  });

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
    recent_submissions: recentSubmissionsAnnotated,
    recent_tasks: recentTasksAnnotated,
  });
}
