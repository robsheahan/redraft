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
 * Return the auth.users.id of every teacher that belongs to a given
 * school, by union of:
 *   - school_members rows
 *   - LTI user mappings on platforms linked to that school
 *   - auth.users whose email domain matches the school's primary/secondary
 *
 * Used by the insights synthesis to scope which tasks to roll up.
 */
export async function getSchoolTeacherIds(
  supabase: SupabaseClient,
  schoolId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  // Explicit members
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

  // Email-domain users
  const { data: school } = await supabase
    .from('schools')
    .select('primary_domain, secondary_domains')
    .eq('id', schoolId)
    .maybeSingle();
  const domains = [school?.primary_domain, ...(school?.secondary_domains || [])]
    .filter((d): d is string => !!d)
    .map(d => d.toLowerCase());
  if (domains.length > 0) {
    // listUsers is paginated; we only need ids so 1000-per-page is fine
    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    allUsers.forEach(u => {
      const domain = (u.email || '').split('@')[1]?.toLowerCase().trim();
      if (domain && domains.includes(domain)) ids.add(u.id);
    });
  }

  return Array.from(ids);
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
