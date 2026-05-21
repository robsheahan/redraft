import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Helpers for resolving school identity for the leadership insights
 * dashboard. A user belongs to a school via any of three paths, checked
 * in priority order:
 *   1. Explicit row in `school_members` (admin/leader grant)
 *   2. LTI launch → `lti_user_mappings.platform_id` → `lti_platforms.school_id`
 *   3. Email-domain match against `schools.primary_domain` (or secondary_domains)
 *
 * Regular teachers/students are only resolved via (2) and (3); they don't
 * need a row in `school_members` to be considered members of the school
 * for synthesis-data purposes.
 */

export type SchoolRole = 'admin' | 'leader';

export interface SchoolContext {
  school_id: string;
  school_name: string;
  role: SchoolRole | null; // null = inferred member only (e.g. teacher/student)
}

/**
 * Resolve the school context for a given user. Returns null if no school
 * can be inferred.
 */
export async function resolveUserSchool(
  supabase: SupabaseClient,
  userId: string,
): Promise<SchoolContext | null> {
  // 1. Explicit membership (admin/leader)
  const { data: member } = await supabase
    .from('school_members')
    .select('school_id, role, schools(name)')
    .eq('user_id', userId)
    .order('role', { ascending: true }) // admin sorts before leader
    .limit(1)
    .maybeSingle();
  if (member && member.school_id) {
    const schoolName = (member as any).schools?.name || '';
    return {
      school_id: member.school_id,
      school_name: schoolName,
      role: member.role as SchoolRole,
    };
  }

  // 2. LTI mapping
  const { data: ltiMap } = await supabase
    .from('lti_user_mappings')
    .select('platform_id, lti_platforms(school_id, schools(name))')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  const ltiSchoolId = (ltiMap as any)?.lti_platforms?.school_id;
  if (ltiSchoolId) {
    return {
      school_id: ltiSchoolId,
      school_name: (ltiMap as any)?.lti_platforms?.schools?.name || '',
      role: null,
    };
  }

  // 3. Email-domain match
  const { data: { user } } = await supabase.auth.admin.getUserById(userId);
  const email = user?.email || '';
  const domain = email.split('@')[1]?.toLowerCase().trim() || '';
  if (!domain) return null;

  const { data: schoolByDomain } = await supabase
    .from('schools')
    .select('id, name, secondary_domains')
    .or(`primary_domain.eq.${domain},secondary_domains.cs.{${domain}}`)
    .limit(1)
    .maybeSingle();
  if (schoolByDomain) {
    return {
      school_id: schoolByDomain.id,
      school_name: schoolByDomain.name,
      role: null,
    };
  }

  return null;
}

/**
 * Return the auth.users.id of every teacher (or unroled staff) belonging
 * to a school. Union of:
 *   - school_members rows (explicit grants)
 *   - LTI user mappings on platforms linked to that school
 *   - auth.users whose email domain matches the school's primary/secondary
 *
 * Users with user_metadata.role === 'student' are excluded — leadership
 * scoping is about staff. Unroled users are kept (likely staff who haven't
 * picked a role yet).
 */
interface MinimalAuthUser {
  id: string;
  email: string | null | undefined;
  user_metadata: Record<string, any> | null | undefined;
}

/**
 * List every auth user, paginating through Supabase's 1000-per-page cap.
 * Multi-school instances will exceed 1000 quickly — silently truncating
 * means teachers / students disappear from school counts.
 */
export async function listAllAuthUsers(
  supabase: SupabaseClient,
): Promise<MinimalAuthUser[]> {
  const out: MinimalAuthUser[] = [];
  const perPage = 1000;
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.warn('[schools] listUsers page', page, 'failed:', error.message);
      break;
    }
    const users = (data?.users || []) as MinimalAuthUser[];
    if (users.length === 0) break;
    out.push(...users);
    if (users.length < perPage) break;
    page++;
    if (page > 50) break; // safety: 50,000 users
  }
  return out;
}

/**
 * Internal: resolve every user belonging to a school via explicit grants
 * (school_members), LTI mappings, or email-domain match. Returns a map of
 * user_id → role (from user_metadata.role, or null if unroled). Callers
 * apply their own role filtering — getSchoolTeacherIds excludes students,
 * getSchoolStudentIds keeps only them.
 */
async function getSchoolUserRoles(
  supabase: SupabaseClient,
  schoolId: string,
  preloadedUsers?: MinimalAuthUser[],
): Promise<Record<string, string | null>> {
  const ids = new Set<string>();

  // Explicit members (typically only staff are graded here, but we include
  // any explicit row — callers can filter by role).
  const { data: members } = await supabase
    .from('school_members')
    .select('user_id')
    .eq('school_id', schoolId);
  members?.forEach(m => m.user_id && ids.add(m.user_id));

  // LTI-mapped users
  const { data: ltiPlatforms } = await supabase
    .from('lti_platforms')
    .select('id')
    .eq('school_id', schoolId);
  const platformIds = (ltiPlatforms || []).map(p => p.id);
  if (platformIds.length > 0) {
    const { data: ltiUsers } = await supabase
      .from('lti_user_mappings')
      .select('user_id')
      .in('platform_id', platformIds);
    ltiUsers?.forEach(u => u.user_id && ids.add(u.user_id));
  }

  // Email-domain match (also used to populate the role lookup)
  const { data: school } = await supabase
    .from('schools')
    .select('primary_domain, secondary_domains')
    .eq('id', schoolId)
    .maybeSingle();
  const domains = [school?.primary_domain, ...(school?.secondary_domains || [])]
    .filter((d): d is string => !!d)
    .map(d => d.toLowerCase());

  let allUsers = preloadedUsers;
  if (!allUsers) {
    allUsers = await listAllAuthUsers(supabase);
  }

  const roleByUserId: Record<string, string | null> = {};
  allUsers.forEach(u => {
    roleByUserId[u.id] = u.user_metadata?.role || null;
    if (domains.length > 0) {
      const domain = (u.email || '').split('@')[1]?.toLowerCase().trim();
      if (domain && domains.includes(domain)) ids.add(u.id);
    }
  });

  const out: Record<string, string | null> = {};
  ids.forEach(id => { out[id] = roleByUserId[id] ?? null; });
  return out;
}

export async function getSchoolTeacherIds(
  supabase: SupabaseClient,
  schoolId: string,
  preloadedUsers?: MinimalAuthUser[],
): Promise<string[]> {
  const roles = await getSchoolUserRoles(supabase, schoolId, preloadedUsers);
  return Object.entries(roles)
    .filter(([_, r]) => r !== 'student')
    .map(([id]) => id);
}

export async function getSchoolStudentIds(
  supabase: SupabaseClient,
  schoolId: string,
  preloadedUsers?: MinimalAuthUser[],
): Promise<string[]> {
  const roles = await getSchoolUserRoles(supabase, schoolId, preloadedUsers);
  return Object.entries(roles)
    .filter(([_, r]) => r === 'student')
    .map(([id]) => id);
}

/**
 * Standard auth + school-resolution shared by every insights endpoint.
 * Returns the caller's effective role + (optional) school context.
 *
 * Three tiers:
 *   - 'admin'   — explicit school_members admin row, or a global admin
 *     viewing any school via ?school_id=…
 *   - 'leader'  — explicit school_members leader row (optionally faculty-
 *     scoped via the faculties[] column)
 *   - 'teacher' — default for any authenticated user with no school grant.
 *     Sees only their own classes; school context is best-effort (resolved
 *     via LTI / email-domain if available, otherwise empty).
 *
 * Returns null only for anonymous callers (no user). Everyone else gets at
 * least 'teacher' access — scope is enforced downstream by callers, not
 * here.
 */
export interface InsightsAccess {
  schoolId: string;
  schoolName: string;
  callerRole: 'admin' | 'leader' | 'teacher';
  restrictedFaculties: string[] | null;
}

export async function resolveInsightsAccess(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null } | null,
  opts: { overrideSchoolId?: string | null; isGlobalAdmin: boolean },
): Promise<InsightsAccess | null> {
  if (!user) return null;

  let schoolId = '';
  let schoolName = '';
  let callerRole: 'admin' | 'leader' | 'teacher' = 'teacher';

  if (opts.overrideSchoolId && opts.isGlobalAdmin) {
    const { data: s } = await supabase
      .from('schools')
      .select('id, name')
      .eq('id', opts.overrideSchoolId)
      .maybeSingle();
    if (!s) return null;
    schoolId = s.id;
    schoolName = s.name;
    callerRole = 'admin';
  } else {
    const ctx = await resolveUserSchool(supabase, user.id);
    if (ctx) {
      schoolId = ctx.school_id;
      schoolName = ctx.school_name;
      // ctx.role is 'admin' | 'leader' | null. Null = inferred member only
      // (LTI/domain) → falls through to default 'teacher'. Global admins
      // viewing their own school still see it as 'admin'.
      if (ctx.role) callerRole = ctx.role;
      else if (opts.isGlobalAdmin) callerRole = 'admin';
    } else if (opts.isGlobalAdmin) {
      // Global admin with no school context — still an admin.
      callerRole = 'admin';
    }
  }

  // Faculty scope only applies to leaders. Admins, global admins, and
  // teachers (own-class scope) are unaffected.
  let restrictedFaculties: string[] | null = null;
  if (callerRole === 'leader' && !opts.isGlobalAdmin) {
    const { data: grant } = await supabase
      .from('school_members')
      .select('faculties')
      .eq('school_id', schoolId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (grant && Array.isArray(grant.faculties) && grant.faculties.length > 0) {
      restrictedFaculties = grant.faculties as string[];
    }
  }

  return { schoolId, schoolName, callerRole, restrictedFaculties };
}

/**
 * Class IDs owned by a given user (teacher_id match). Used to scope the
 * teacher-tier insights view to that teacher's own classes, and to verify
 * ownership when a ?class_id= filter is supplied.
 */
export async function getOwnedClassIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('classes')
    .select('id')
    .eq('teacher_id', userId);
  return (data || []).map(r => r.id);
}

/**
 * Class IDs visible to the caller — the basis for student-scope queries.
 * Teacher → their own classes. Leader/admin → every class at their school
 * (optionally filtered to the leader's restricted faculties). Returns an
 * empty array rather than null when no classes resolve.
 */
export async function getInScopeClassIds(
  supabase: SupabaseClient,
  callerRole: 'admin' | 'leader' | 'teacher',
  userId: string,
  schoolId: string,
  restrictedFaculties: string[] | null,
): Promise<string[]> {
  if (callerRole === 'teacher') return getOwnedClassIds(supabase, userId);

  if (!schoolId) return [];
  const teacherIds = await getSchoolTeacherIds(supabase, schoolId);
  if (teacherIds.length === 0) return [];
  const { data } = await supabase
    .from('classes')
    .select('id, course')
    .in('teacher_id', teacherIds);
  const rows = data || [];
  if (!restrictedFaculties || restrictedFaculties.length === 0) {
    return rows.map(r => r.id);
  }
  const allow = new Set(restrictedFaculties);
  // Course → faculty lookup happens in the caller (we don't import the
  // courses data here to keep this module pure). Pass the course through;
  // the caller filters. Simpler: import here.
  const { getDisciplineForCourse } = await import('../data/nesa-courses.js');
  return rows
    .filter(r => {
      const f = r.course ? (getDisciplineForCourse(r.course) || 'Other') : 'Other';
      return allow.has(f);
    })
    .map(r => r.id);
}

/**
 * Student IDs visible to the caller — distinct student_ids enrolled in any
 * class returned by getInScopeClassIds. Used by the student search +
 * single-student cards endpoint to verify access.
 */
export async function getInScopeStudentIds(
  supabase: SupabaseClient,
  callerRole: 'admin' | 'leader' | 'teacher',
  userId: string,
  schoolId: string,
  restrictedFaculties: string[] | null,
): Promise<string[]> {
  const classIds = await getInScopeClassIds(supabase, callerRole, userId, schoolId, restrictedFaculties);
  if (classIds.length === 0) return [];
  const { data } = await supabase
    .from('class_members')
    .select('student_id')
    .in('class_id', classIds);
  const out = new Set<string>();
  (data || []).forEach(r => { if (r.student_id) out.add(r.student_id); });
  return [...out];
}

/**
 * Whether the user has an explicit school_members grant (admin or leader).
 * NOT a general "can see insights" check — teachers without a grant can
 * still see class-level insights via resolveInsightsAccess. Used only by
 * endpoints that are intentionally gated to leader/admin (e.g. the
 * school-wide synthesis in insights-synthesis.ts).
 */
export async function canViewInsights(
  supabase: SupabaseClient,
  userId: string,
  schoolId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('school_members')
    .select('role')
    .eq('school_id', schoolId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}
