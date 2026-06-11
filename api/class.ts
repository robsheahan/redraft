import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { createClient } from '@supabase/supabase-js';
import { withHandler } from '../lib/with-handler.js';
import { getUserInfoBatch } from '../lib/user-names.js';

/**
 * Unified classes endpoint.
 *
 *   GET  /api/class                    → list classes for the current user
 *                                        (teacher: owned; student: joined, unarchived)
 *   GET  /api/class?code=ABCDEF        → public join preview (name, course, teacher_name)
 *   GET  /api/class?id=<uuid>          → full class view, role-scoped:
 *                                        teacher owner: all tasks + members
 *                                        student member: published tasks only
 *   POST /api/class                    → create class (teacher)
 *   POST /api/class {action:'join',code}     → student joins
 *   POST /api/class {action:'leave',class_id}→ student leaves
 *   POST /api/class {action:'archive',class_id}   → teacher archives
 *   POST /api/class {action:'unarchive',class_id} → teacher unarchives
 *   PUT  /api/class                    → update class name/course (teacher owner)
 *   DELETE /api/class                  → delete class + cascade (teacher owner)
 */

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function nameFor(supabase: any, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    const m: any = data?.user?.user_metadata || {};
    return m.display_name || m.full_name || m.name || data?.user?.email || null;
  } catch { return null; }
}

// auth:'none' — each sub-handler does its own verifyAuth + ownership checks.
export default withHandler(
  { methods: ['GET', 'POST', 'PUT', 'DELETE'], auth: 'none', label: 'class' },
  async (req, res) => {
    switch (req.method) {
      case 'GET':    return handleGet(req, res);
      case 'POST':   return handlePost(req, res);
      case 'PUT':    return handleUpdate(req, res);
      case 'DELETE': return handleDelete(req, res);
    }
  },
);

async function handleGet(req: VercelRequest, res: VercelResponse) {
  // Public: join preview by code
  const codeParam = (req.query.code as string || '').trim().toUpperCase();
  if (codeParam) {
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
    const { data, error } = await anon
      .from('classes')
      .select('id, name, course, teacher_id, archived_at')
      .eq('code', codeParam)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'No class found with that code.' });
    if (data.archived_at) return res.status(404).json({ error: 'That class is archived.' });
    const teacher_name = await nameFor(anon, data.teacher_id);
    return res.status(200).json({ id: data.id, name: data.name, course: data.course, teacher_name });
  }

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const idParam = (req.query.id as string || '').trim();
  const supabase = getSupabase();

  if (!idParam) return listForUser(res, user.id, supabase);

  // Detail mode — role-scoped
  const { data: cls, error: clsErr } = await supabase
    .from('classes').select('*').eq('id', idParam).maybeSingle();
  if (clsErr || !cls) return res.status(404).json({ error: 'Class not found' });

  const isOwner = cls.teacher_id === user.id;
  const { data: membership } = await supabase
    .from('class_members').select('student_id').eq('class_id', idParam).eq('student_id', user.id).maybeSingle();
  const isMember = !!membership;
  if (!isOwner && !isMember) return res.status(403).json({ error: 'You are not a member of this class.' });

  let taskQuery = supabase
    .from('tasks')
    .select('id, title, question, course, task_type, task_mode, completion_only, total_marks, due_date, outcomes, criteria, criteria_text, notes, published_at, created_at')
    .eq('class_id', idParam)
    .order('created_at', { ascending: false });
  if (!isOwner) taskQuery = taskQuery.not('published_at', 'is', null);
  const { data: tasks } = await taskQuery;

  // For students, decorate each task with how many drafts they've submitted
  // plus their current grading state (graded / submitted-for-marking / none).
  let studentSubmissionCounts: Record<string, number> = {};
  let studentStateByTask: Record<string, { graded_at: string | null; total_mark: number | null; submitted_for_marking: boolean }> = {};
  if (!isOwner && (tasks || []).length > 0) {
    const taskIds = (tasks || []).map((t: any) => t.id);
    const { data: subs } = await supabase
      .from('submissions')
      .select('task_id, graded_at, total_mark, submitted_for_marking')
      .eq('student_id', user.id)
      .in('task_id', taskIds);
    (subs || []).forEach((s: any) => {
      if (!s.task_id) return;
      studentSubmissionCounts[s.task_id] = (studentSubmissionCounts[s.task_id] || 0) + 1;
      const existing = studentStateByTask[s.task_id];
      const next = {
        graded_at: s.graded_at || existing?.graded_at || null,
        total_mark: s.graded_at && s.total_mark != null ? s.total_mark : (existing?.total_mark ?? null),
        submitted_for_marking: !!s.submitted_for_marking || !!existing?.submitted_for_marking,
      };
      studentStateByTask[s.task_id] = next;
    });
  }

  // For the teacher view, decorate each task with per-task marking stats so
  // the class-detail page can show "X submitted · Y marked · Z to mark".
  const teacherStatsByTask: Record<string, { submitted: Set<string>; graded: Set<string>; pending: Set<string> }> = {};
  if (isOwner && (tasks || []).length > 0) {
    const taskIds = (tasks || []).map((t: any) => t.id);
    const { data: allSubs } = await supabase
      .from('submissions')
      .select('task_id, student_id, graded_at, submitted_for_marking')
      .in('task_id', taskIds);
    (allSubs || []).forEach((s: any) => {
      if (!s.task_id || !s.student_id) return;
      if (!teacherStatsByTask[s.task_id]) {
        teacherStatsByTask[s.task_id] = { submitted: new Set(), graded: new Set(), pending: new Set() };
      }
      const bucket = teacherStatsByTask[s.task_id];
      bucket.submitted.add(s.student_id);
      if (s.graded_at) bucket.graded.add(s.student_id);
      else if (s.submitted_for_marking) bucket.pending.add(s.student_id);
    });
  }

  const scrubbedTasks = (tasks || []).map((t: any) => {
    if (isOwner) {
      const stats = teacherStatsByTask[t.id];
      const submitted_count = stats ? stats.submitted.size : 0;
      const marked_count    = stats ? stats.graded.size : 0;
      const to_mark_count   = stats ? Math.max(0, submitted_count - marked_count) : 0;
      const ready_count     = stats ? stats.pending.size : 0;
      return { ...t, submitted_count, marked_count, to_mark_count, ready_count };
    }
    const { notes, ...rest } = t;
    const st = studentStateByTask[t.id];
    return {
      ...rest,
      my_submission_count: studentSubmissionCounts[t.id] || 0,
      my_graded_at: st?.graded_at || null,
      my_total_mark: st?.total_mark ?? null,
      my_submitted_for_marking: !!st?.submitted_for_marking,
    };
  });

  let members: Array<{ student_id: string; student_name: string; joined_at: string }> | undefined;
  let teacher_name: string | null = null;
  if (isOwner) {
    const { data: rows } = await supabase
      .from('class_members')
      .select('student_id, joined_at')
      .eq('class_id', idParam)
      .order('joined_at', { ascending: true });
    const studentIds = (rows || []).map(r => r.student_id);
    const ids = [...studentIds];
    if (cls.teacher_id) ids.push(cls.teacher_id);
    const userInfo = await getUserInfoBatch(supabase, ids);
    members = (rows || []).map(r => ({
      student_id: r.student_id,
      student_name: userInfo[r.student_id]?.name || 'Unknown',
      joined_at: r.joined_at,
    }));
    teacher_name = userInfo[cls.teacher_id]?.name || null;
  } else {
    teacher_name = await nameFor(supabase, cls.teacher_id);
  }

  return res.status(200).json({
    class: { ...cls, teacher_name },
    role: isOwner ? 'teacher' : 'student',
    tasks: scrubbedTasks,
    members,
  });
}

async function listForUser(res: VercelResponse, userId: string, supabase: any) {
  const { data: owned, error: ownedErr } = await supabase
    .from('classes').select('*').eq('teacher_id', userId).order('created_at', { ascending: false });
  if (ownedErr) throw ownedErr;

  const { data: memberships } = await supabase
    .from('class_members').select('class_id, joined_at').eq('student_id', userId);
  const memberIds = (memberships || []).map((m: any) => m.class_id);

  let joined: any[] = [];
  if (memberIds.length > 0) {
    const { data: rows } = await supabase
      .from('classes').select('*').in('id', memberIds);
    joined = rows || [];
  }

  const allClassIds = [ ...((owned || []) as any[]).map(c => c.id), ...joined.map(c => c.id) ];
  const taskCountMap: Record<string, { total: number; published: number }> = {};
  const memberCountMap: Record<string, number> = {};
  let allTasksByClass: Record<string, any[]> = {};
  if (allClassIds.length > 0) {
    const { data: allTasks } = await supabase
      .from('tasks')
      .select('id, class_id, title, question, task_type, task_mode, completion_only, total_marks, due_date, published_at, created_at')
      .in('class_id', allClassIds)
      .order('created_at', { ascending: false });
    (allTasks || []).forEach((t: any) => {
      const agg = taskCountMap[t.class_id] || { total: 0, published: 0 };
      agg.total++;
      if (t.published_at) agg.published++;
      taskCountMap[t.class_id] = agg;
      if (!allTasksByClass[t.class_id]) allTasksByClass[t.class_id] = [];
      allTasksByClass[t.class_id].push(t);
    });
    const { data: allMembers } = await supabase
      .from('class_members').select('class_id').in('class_id', allClassIds);
    (allMembers || []).forEach((m: any) => {
      memberCountMap[m.class_id] = (memberCountMap[m.class_id] || 0) + 1;
    });
  }

  // Student's own submission counts + grading state by task_id, for inline indicators on the dashboard
  let myCounts: Record<string, number> = {};
  let myStateByTask: Record<string, { graded_at: string | null; total_mark: number | null; submitted_for_marking: boolean }> = {};
  const studentTaskIds: string[] = [];
  Object.values(allTasksByClass).forEach(ts => ts.forEach((t: any) => { if (t.published_at) studentTaskIds.push(t.id); }));
  if (studentTaskIds.length > 0) {
    const { data: subs } = await supabase
      .from('submissions')
      .select('task_id, graded_at, total_mark, submitted_for_marking')
      .eq('student_id', userId).in('task_id', studentTaskIds);
    (subs || []).forEach((s: any) => {
      if (!s.task_id) return;
      myCounts[s.task_id] = (myCounts[s.task_id] || 0) + 1;
      const existing = myStateByTask[s.task_id];
      myStateByTask[s.task_id] = {
        graded_at: s.graded_at || existing?.graded_at || null,
        total_mark: s.graded_at && s.total_mark != null ? s.total_mark : (existing?.total_mark ?? null),
        submitted_for_marking: !!s.submitted_for_marking || !!existing?.submitted_for_marking,
      };
    });
  }

  const decorate = (c: any) => {
    // Latest published task date for the class — used by the dashboards
    // to sort classes with the most recently active class first.
    const tasks = allTasksByClass[c.id] || [];
    let lastTaskPublishedAt: string | null = null;
    for (const t of tasks) {
      if (t.published_at && (!lastTaskPublishedAt || t.published_at > lastTaskPublishedAt)) {
        lastTaskPublishedAt = t.published_at;
      }
    }
    return {
      ...c,
      task_count_total: taskCountMap[c.id]?.total || 0,
      task_count_published: taskCountMap[c.id]?.published || 0,
      member_count: memberCountMap[c.id] || 0,
      last_task_published_at: lastTaskPublishedAt,
    };
  };

  const joinedVisible = joined.filter(c => !c.archived_at);
  const teacherIds = [...new Set(joinedVisible.map((c: any) => c.teacher_id).filter(Boolean))] as string[];
  const teacherInfo = teacherIds.length ? await getUserInfoBatch(supabase, teacherIds) : {};
  const joinedOut: any[] = joinedVisible.map((c: any) => {
    const tasks = (allTasksByClass[c.id] || [])
      .filter((t: any) => t.published_at)
      .map((t: any) => {
        const st = myStateByTask[t.id];
        return {
          ...t,
          my_submission_count: myCounts[t.id] || 0,
          my_graded_at: st?.graded_at || null,
          my_total_mark: st?.total_mark ?? null,
          my_submitted_for_marking: !!st?.submitted_for_marking,
        };
      });
    return {
      ...decorate(c),
      teacher_name: teacherInfo[c.teacher_id]?.name || null,
      tasks,
    };
  });

  return res.status(200).json({
    owned: (owned || []).map(decorate),
    joined: joinedOut,
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const supabase = getSupabase();

  const action = (req.body?.action as string || '').trim();
  if (action === 'join')      return studentJoin(req, res, user.id, supabase);
  if (action === 'leave')     return studentLeave(req, res, user.id, supabase);
  if (action === 'archive')   return teacherArchive(req, res, user.id, supabase, new Date().toISOString());
  if (action === 'unarchive') return teacherArchive(req, res, user.id, supabase, null);

  // Default: create a class
  const { name, course } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Class name is required.' });
  }

  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    const { data: existing } = await supabase.from('classes').select('code').eq('code', code).maybeSingle();
    if (!existing) break;
    code = generateCode();
  }

  const { data, error } = await supabase.from('classes').insert({
    code,
    teacher_id: user.id,
    name: String(name).trim(),
    course: course ? String(course).trim() : null,
  }).select('*').single();
  if (error) throw error;
  return res.status(200).json({ class: data });
}

async function studentJoin(req: VercelRequest, res: VercelResponse, userId: string, supabase: any) {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Class code is required.' });
  const { data: cls } = await supabase
    .from('classes').select('id, archived_at').eq('code', code).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'No class found with that code.' });
  if (cls.archived_at) return res.status(400).json({ error: 'That class is archived and not accepting new students.' });

  const { error } = await supabase.from('class_members').upsert(
    { class_id: cls.id, student_id: userId },
    { onConflict: 'class_id,student_id' },
  );
  if (error) throw error;
  return res.status(200).json({ class_id: cls.id });
}

async function studentLeave(req: VercelRequest, res: VercelResponse, userId: string, supabase: any) {
  const classId = String(req.body?.class_id || '').trim();
  if (!classId) return res.status(400).json({ error: 'class_id is required.' });
  const { error } = await supabase.from('class_members')
    .delete().eq('class_id', classId).eq('student_id', userId);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function teacherArchive(req: VercelRequest, res: VercelResponse, userId: string, supabase: any, archivedAt: string | null) {
  const classId = String(req.body?.class_id || req.body?.id || '').trim();
  if (!classId) return res.status(400).json({ error: 'class_id is required.' });
  const { data: cls } = await supabase
    .from('classes').select('id, teacher_id').eq('id', classId).maybeSingle();
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  if (cls.teacher_id !== userId) return res.status(403).json({ error: 'You can only modify your own classes.' });
  const { error } = await supabase.from('classes').update({ archived_at: archivedAt }).eq('id', classId);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function handleUpdate(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { id, name, course } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Class id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('classes').select('teacher_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Class not found.' });
  if (existing.teacher_id !== user.id) return res.status(403).json({ error: 'You can only update your own classes.' });

  const patch: any = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim();
  if (typeof course === 'string') patch.course = course.trim() || null;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  const { error } = await supabase.from('classes').update(patch).eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Class id is required.' });

  const supabase = getSupabase();
  const { data: existing } = await supabase
    .from('classes').select('teacher_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Class not found.' });
  if (existing.teacher_id !== user.id) return res.status(403).json({ error: 'You can only delete your own classes.' });

  const { data: taskIds } = await supabase.from('tasks').select('id').eq('class_id', id);
  const ids = (taskIds || []).map((t: any) => t.id);
  if (ids.length > 0) {
    await supabase.from('submissions').delete().in('task_id', ids);
    await supabase.from('tasks').delete().in('id', ids);
  }
  await supabase.from('class_members').delete().eq('class_id', id);
  const { error } = await supabase.from('classes').delete().eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}
