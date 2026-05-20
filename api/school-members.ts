import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { resolveUserSchool, getSchoolTeacherIds } from '../lib/schools.js';
import { getUserInfoBatch } from '../lib/user-names.js';
import { isGlobalAdmin } from '../lib/admin.js';

const VALID_FACULTIES = new Set([
  'English', 'Mathematics', 'Science', 'HSIE',
  'PDHPE', 'TAS', 'Creative Arts', 'Languages', 'VET',
]);

function normaliseFaculties(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (VALID_FACULTIES.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

/**
 * Manage explicit school leadership memberships.
 *
 *   GET    /api/school-members?school_id=X
 *       → list every registered staff member in the school (via domain /
 *         LTI mapping / explicit grant), each with their current access
 *         level (role + faculties) if any.
 *   POST   /api/school-members  body: {school_id, user_id, role, faculties}
 *   PUT    /api/school-members  body: {school_id, user_id, role, faculties}
 *       → upsert (same shape as POST).
 *   DELETE /api/school-members?school_id=X&user_id=Y
 *       → remove the grant; the user still resolves as a school member
 *         (via domain) but loses insights access.
 *
 * Auth: caller must have role='admin' for the school, OR be a global admin.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method || '')) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = getSupabase();

  const schoolId =
    (req.method === 'POST' || req.method === 'PUT')
      ? (req.body?.school_id as string)
      : (req.query.school_id as string);
  if (!schoolId) return res.status(400).json({ error: 'school_id required.' });

  // Authorisation: school admin or global admin.
  const isGlobal = isGlobalAdmin(user);
  let isSchoolAdmin = false;
  if (!isGlobal) {
    const ctx = await resolveUserSchool(supabase, user.id);
    isSchoolAdmin = !!(ctx && ctx.school_id === schoolId && ctx.role === 'admin');
  }
  if (!isGlobal && !isSchoolAdmin) {
    return res.status(404).json({ error: 'Not found' });
  }

  // --- GET: full school staff list with their grants ---
  if (req.method === 'GET') {
    // Fetch the auth user list once and share with getSchoolTeacherIds so
    // listUsers isn't hit twice in the same request.
    const { data: { users: allUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const schoolUserIds = await getSchoolTeacherIds(supabase, schoolId, allUsers as any);

    const { data: grantRows } = await supabase
      .from('school_members')
      .select('user_id, role, faculties, created_at')
      .eq('school_id', schoolId);
    const grants: Record<string, { role: string; faculties: string[]; created_at: string }> = {};
    (grantRows || []).forEach(r => {
      if (r.user_id) grants[r.user_id] = {
        role: r.role,
        faculties: Array.isArray(r.faculties) ? r.faculties : [],
        created_at: r.created_at,
      };
    });

    // Include any user with an explicit grant even if domain doesn't match
    // (e.g. Rob, who was added manually with a gmail address).
    const ids = new Set<string>([...schoolUserIds, ...Object.keys(grants)]);
    const lookup = await getUserInfoBatch(supabase, [...ids]);

    // Reuse the allUsers list we already loaded above for role metadata.
    const metaByUser: Record<string, { metaRole: string | null }> = {};
    allUsers.forEach(u => { metaByUser[u.id] = { metaRole: (u.user_metadata as any)?.role || null }; });

    const members = [...ids].map(id => {
      const info = lookup[id] || { name: '(unknown)', email: '' };
      const grant = grants[id] || null;
      return {
        user_id: id,
        name: info.name,
        email: info.email,
        meta_role: metaByUser[id]?.metaRole || null,
        role: grant?.role || null,
        faculties: grant?.faculties || [],
        granted_at: grant?.created_at || null,
      };
    });
    // Exclude students from the access list — leadership management is for staff.
    const staff = members.filter(m => m.meta_role !== 'student');
    staff.sort((a, b) => {
      // Active grants first, then alphabetical
      if (!!a.role !== !!b.role) return a.role ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return res.status(200).json({ members: staff, faculties: [...VALID_FACULTIES] });
  }

  // --- POST / PUT: upsert a grant ---
  if (req.method === 'POST' || req.method === 'PUT') {
    const targetUserId = String(req.body?.user_id || '').trim();
    const role = String(req.body?.role || '').trim();
    if (!targetUserId) return res.status(400).json({ error: 'user_id required.' });
    if (!['admin', 'leader'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'leader'." });
    }
    // Admins are always unrestricted; faculties only apply to leaders.
    const faculties = role === 'admin' ? [] : normaliseFaculties(req.body?.faculties);

    const { error } = await supabase
      .from('school_members')
      .upsert({ school_id: schoolId, user_id: targetUserId, role, faculties });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // --- DELETE: remove the grant ---
  if (req.method === 'DELETE') {
    const targetUserId = String(req.query.user_id || '').trim();
    if (!targetUserId) return res.status(400).json({ error: 'user_id required.' });
    const { error } = await supabase
      .from('school_members')
      .delete()
      .eq('school_id', schoolId)
      .eq('user_id', targetUserId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
