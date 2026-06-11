import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';

const ALLOWED_FACULTIES = new Set([
  'English', 'Mathematics', 'Science', 'HSIE', 'PDHPE', 'TAS', 'CAPA', 'Languages', 'Other',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { role, year_level, graduation_year, faculties } = req.body || {};

  // role is required only on first-time setup; if user already has a role we
  // treat this as a profile update and don't insist on it being supplied.
  const existingRole = (user.user_metadata as any)?.role;
  const effectiveRole = role || existingRole;
  if (effectiveRole && !['teacher', 'student'].includes(effectiveRole)) {
    return res.status(400).json({ error: 'Role must be teacher or student' });
  }
  if (!effectiveRole) {
    return res.status(400).json({ error: 'Role is required.' });
  }

  // Build patch
  const meta: Record<string, unknown> = { ...(user.user_metadata || {}), role: effectiveRole };

  if (effectiveRole === 'student') {
    let gradYear: number | undefined;
    if (typeof graduation_year === 'number') {
      gradYear = graduation_year;
    } else if (typeof year_level === 'number') {
      const now = new Date();
      gradYear = now.getFullYear() + (12 - year_level);
    }
    if (gradYear !== undefined) {
      if (!Number.isFinite(gradYear) || gradYear < 2020 || gradYear > 2040) {
        return res.status(400).json({ error: 'Invalid year level.' });
      }
      meta.graduation_year = gradYear;
    }
    // Clear teacher-only fields if they exist from a prior toggle
    delete (meta as any).faculties;
  }

  if (effectiveRole === 'teacher') {
    if (faculties !== undefined) {
      if (!Array.isArray(faculties)) {
        return res.status(400).json({ error: 'Faculties must be an array.' });
      }
      const clean = faculties
        .filter((f: unknown) => typeof f === 'string')
        .map((f: string) => f.trim())
        .filter((f: string) => ALLOWED_FACULTIES.has(f));
      meta.faculties = clean;
    }
    delete (meta as any).graduation_year;
  }

  const supabase = getSupabase();
  // Authoritative role goes in app_metadata (service-role only — the user
  // cannot rewrite it). The user_metadata.role written below is a display
  // mirror the client can read; no server gate ever trusts it.
  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...((user.app_metadata as Record<string, unknown>) || {}), role: effectiveRole },
    user_metadata: meta,
  });
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    role: effectiveRole,
    graduation_year: meta.graduation_year ?? null,
    faculties: meta.faculties ?? null,
  });
}
