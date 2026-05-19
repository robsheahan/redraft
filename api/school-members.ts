import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { resolveUserSchool } from '../lib/schools.js';
import { getUserInfoBatch } from '../lib/user-names.js';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'robert.sheahan@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function isGlobalAdmin(email: string | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Manage explicit school leadership memberships.
 *
 *   GET    /api/school-members?school_id=X         → list current members
 *   POST   /api/school-members  body: {school_id, email, role}   → add
 *   PUT    /api/school-members  body: {school_id, user_id, role} → change role
 *   DELETE /api/school-members?school_id=X&user_id=Y             → remove
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

  // Resolve the target school. Body takes precedence for write methods;
  // query string is used for GET/DELETE.
  const schoolId =
    (req.method === 'POST' || req.method === 'PUT')
      ? (req.body?.school_id as string)
      : (req.query.school_id as string);
  if (!schoolId) return res.status(400).json({ error: 'school_id required.' });

  // Authorisation: school admin or global admin.
  const isGlobal = isGlobalAdmin(user.email);
  let isSchoolAdmin = false;
  if (!isGlobal) {
    const ctx = await resolveUserSchool(supabase, user.id);
    isSchoolAdmin = !!(ctx && ctx.school_id === schoolId && ctx.role === 'admin');
  }
  if (!isGlobal && !isSchoolAdmin) {
    return res.status(404).json({ error: 'Not found' });
  }

  // --- GET: list members of this school ---
  if (req.method === 'GET') {
    const { data: rows, error } = await supabase
      .from('school_members')
      .select('user_id, role, created_at')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const userIds = (rows || []).map(r => r.user_id);
    const lookup = await getUserInfoBatch(supabase, userIds);
    const members = (rows || []).map(r => ({
      user_id: r.user_id,
      name: lookup[r.user_id]?.name || '(unknown)',
      email: lookup[r.user_id]?.email || '',
      role: r.role,
      created_at: r.created_at,
    }));
    return res.status(200).json({ members });
  }

  // --- POST: add a member by email ---
  if (req.method === 'POST') {
    const emailRaw = String(req.body?.email || '').trim();
    const role = String(req.body?.role || '').trim();
    if (!emailRaw) return res.status(400).json({ error: 'email required.' });
    if (!['admin', 'leader'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'leader'." });
    }
    const email = emailRaw.toLowerCase();

    // Find the user. Reuse the LTI helper RPC (it just looks up auth.users by
    // email ilike). Works for any email-signed-up user too.
    const { data: hit } = await supabase.rpc('lti_find_user_by_email', { p_email: email });
    const targetUserId = Array.isArray(hit) && hit.length > 0 ? hit[0].id : null;
    if (!targetUserId) {
      return res.status(404).json({ error: 'No ProofReady account found for that email. Ask them to sign up first.' });
    }

    const { error } = await supabase
      .from('school_members')
      .upsert({ school_id: schoolId, user_id: targetUserId, role });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // --- PUT: change a member's role ---
  if (req.method === 'PUT') {
    const targetUserId = String(req.body?.user_id || '').trim();
    const role = String(req.body?.role || '').trim();
    if (!targetUserId) return res.status(400).json({ error: 'user_id required.' });
    if (!['admin', 'leader'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'leader'." });
    }
    const { error } = await supabase
      .from('school_members')
      .update({ role })
      .eq('school_id', schoolId)
      .eq('user_id', targetUserId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // --- DELETE: remove a member ---
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
