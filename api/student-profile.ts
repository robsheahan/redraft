/**
 * GET /api/student-profile?student_id=<uuid>
 *
 * Returns the longitudinal academic profile for one student.
 *
 * Access:
 *   - The caller must be the student themselves, OR
 *   - The caller must be a teacher/leader/admin whose insights scope includes
 *     the student (resolveInsightsAccess + getInScopeStudentIds).
 *
 * Caching:
 *   - Reads student_profile_synthesis. If present, returns it.
 *   - If missing (e.g. invalidated by recent grading or feedback), regenerates
 *     via lib/student-profile.ts and persists.
 *
 * Rate limit:
 *   - 30/hr per user (generous — the cache absorbs most calls; only misses
 *     hit the model). 800/day global.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import {
  resolveInsightsAccess,
  getInScopeStudentIds,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { readCachedProfile, regenerateProfile, countStudentSubmissions, profileNeedsRegen } from '../lib/student-profile.js';
import { captureError } from '../lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const studentId = String(req.query.student_id || '').trim();
  if (!studentId) return res.status(400).json({ error: 'student_id is required' });

  const supabase = getSupabase();

  // Access check: caller is the student themselves, or has scope over them.
  let allowed = user.id === studentId;
  if (!allowed) {
    const overrideId = (req.query.school_id as string) || null;
    const access = await resolveInsightsAccess(supabase, user, {
      overrideSchoolId: overrideId,
      isGlobalAdmin: isGlobalAdmin(user),
    });
    if (!access) return res.status(403).json({ error: 'Not authorised' });
    const inScope = await getInScopeStudentIds(
      supabase,
      access.callerRole,
      user.id,
      access.schoolId,
      access.restrictedFaculties,
    );
    allowed = inScope.includes(studentId);
  }
  if (!allowed) return res.status(403).json({ error: 'Not authorised' });

  // Try cache first. A cached profile is served unless there are new
  // submissions since it was generated, or it's stale (a mark/feedback event
  // landed) and past the short refresh window. This stops bulk-marking from
  // forcing a regeneration on every profile open.
  const cached = await readCachedProfile(supabase, studentId);
  if (cached) {
    const currentCount = await countStudentSubmissions(supabase, studentId);
    if (!profileNeedsRegen(cached, currentCount)) {
      return res.status(200).json({ profile: cached, source: 'cache' });
    }
  }

  // Cache miss or needs refresh → regenerate. Rate-limit only this path.
  const rl = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'student-profile-generate',
    perUserPerHour: 30,
    globalPerDay: 800,
  });
  if (!rl.ok) return res.status(429).json({ error: rl.reason });

  try {
    const fresh = await regenerateProfile(supabase, studentId);
    return res.status(200).json({ profile: fresh, source: 'generated' });
  } catch (err: any) {
    captureError(err, { endpoint: 'student-profile', student_id: studentId });
    return res.status(500).json({ error: err.message || 'Failed to generate profile' });
  }
}
