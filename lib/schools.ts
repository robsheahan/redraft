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
    const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    allUsers = (data?.users || []) as MinimalAuthUser[];
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
 * Whether the user can access the insights dashboard for a school.
 * Currently: any explicit school_member (admin or leader). Global admins
 * (from ADMIN_EMAILS) are handled by the API layer, not here.
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
