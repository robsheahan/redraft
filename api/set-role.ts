import { withHandler } from '../lib/with-handler.js';

const ALLOWED_FACULTIES = new Set([
  'English', 'Mathematics', 'Science', 'HSIE', 'PDHPE', 'TAS', 'CAPA', 'Languages', 'Other',
]);

export default withHandler(
  { methods: ['POST'], label: 'set-role' },
  async (req, res, { user, supabase }) => {
    const { role, year_level, graduation_year, faculties } = req.body || {};

    // role is required only on first-time setup; if user already has a role we
    // treat this as a profile update and don't insist on it being supplied.
    const existingRole = (user!.app_metadata as any)?.role ?? (user!.user_metadata as any)?.role;
    const effectiveRole = role || existingRole;
    if (effectiveRole && !['teacher', 'student'].includes(effectiveRole)) {
      return res.status(400).json({ error: 'Role must be teacher or student' });
    }
    if (!effectiveRole) {
      return res.status(400).json({ error: 'Role is required.' });
    }

    // Build patch
    const meta: Record<string, unknown> = { ...(user!.user_metadata || {}), role: effectiveRole };

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

    // Authoritative role goes in app_metadata (service-role only — the user
    // cannot rewrite it). The user_metadata.role written below is a display
    // mirror the client can read; no server gate ever trusts it.
    const { error } = await supabase.auth.admin.updateUserById(user!.id, {
      app_metadata: { ...((user!.app_metadata as Record<string, unknown>) || {}), role: effectiveRole },
      user_metadata: meta,
    });
    if (error) throw error; // generic 500 via withHandler — don't leak the message

    res.status(200).json({
      role: effectiveRole,
      graduation_year: meta.graduation_year ?? null,
      faculties: meta.faculties ?? null,
    });
  },
);
