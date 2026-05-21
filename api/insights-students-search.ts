import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import {
  resolveInsightsAccess,
  getInScopeStudentIds,
  listAllAuthUsers,
} from '../lib/schools.js';
import { isGlobalAdmin } from '../lib/admin.js';
import { yearLevelFromGraduationYear } from '../lib/insights-filters.js';

/**
 * Typeahead search for students the caller is authorised to view.
 *
 *   GET /api/insights-students-search?q=<query>
 *
 * Match: substring on display_name / full_name / email (case-insensitive).
 * Scope: union of class_members across the caller's in-scope classes
 *   (teacher → own classes; leader → faculty-scoped; admin → school).
 * Returns up to 10 results, ranked surname-first when possible (since the
 * common search pattern is by surname for parent-meeting / report contexts).
 */

const MAX_RESULTS = 10;

interface SearchResult {
  id: string;
  display_name: string;
  email: string;
  year_level: number | null;
  class_summary: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const q = (req.query.q as string || '').trim().toLowerCase();
  if (q.length < 2) return res.status(200).json({ rows: [] });

  const supabase = getSupabase();
  const overrideId = (req.query.school_id as string) || null;
  const access = await resolveInsightsAccess(supabase, user, {
    overrideSchoolId: overrideId,
    isGlobalAdmin: isGlobalAdmin(user),
  });
  if (!access) return res.status(404).json({ error: 'Not found' });
  const { schoolId, callerRole, restrictedFaculties } = access;

  const inScope = new Set(await getInScopeStudentIds(
    supabase, callerRole, user.id, schoolId, restrictedFaculties,
  ));
  if (inScope.size === 0) return res.status(200).json({ rows: [] });

  // Substring match on the user's metadata. listUsers is paginated so we
  // already pay that cost elsewhere — reuse the cached fetch pattern.
  const allUsers = await listAllAuthUsers(supabase);
  const candidates: Array<{ user: any; surnameStarts: boolean }> = [];
  for (const u of allUsers) {
    if (!inScope.has(u.id)) continue;
    const meta = u.user_metadata || {};
    const display = String(meta.display_name || meta.full_name || meta.name || '').trim();
    const email = String(u.email || '');
    const blob = (display + ' ' + email).toLowerCase();
    if (!blob.includes(q)) continue;
    // Rank surname matches higher: split on whitespace, last token = surname,
    // mark if it starts with the query string.
    const tokens = display.split(/\s+/).filter(Boolean);
    const surname = (tokens[tokens.length - 1] || '').toLowerCase();
    const surnameStarts = surname.startsWith(q);
    candidates.push({ user: u, surnameStarts });
  }
  candidates.sort((a, b) => {
    if (a.surnameStarts !== b.surnameStarts) return a.surnameStarts ? -1 : 1;
    const an = (a.user.user_metadata?.display_name || a.user.email || '').toLowerCase();
    const bn = (b.user.user_metadata?.display_name || b.user.email || '').toLowerCase();
    return an.localeCompare(bn);
  });

  const top = candidates.slice(0, MAX_RESULTS);
  if (top.length === 0) return res.status(200).json({ rows: [] });

  // Enrich with class names — single query for all matched students.
  const ids = top.map(c => c.user.id);
  const { data: memberships } = await supabase
    .from('class_members')
    .select('student_id, class_id, classes(id, name, teacher_id)')
    .in('student_id', ids);

  const classNamesByStudent: Record<string, string[]> = {};
  (memberships || []).forEach((m: any) => {
    if (!m.student_id) return;
    const cls = m.classes;
    if (!cls) return;
    // Caller-scope safety: a student shared between schools could surface a
    // foreign class here. We don't filter on caller's classes because the
    // student is already in-scope, and showing all their class names helps
    // identify the right person in the dropdown.
    (classNamesByStudent[m.student_id] ||= []).push(cls.name || '');
  });

  const rows: SearchResult[] = top.map(({ user: u }) => {
    const meta = u.user_metadata || {};
    const gy = meta.graduation_year;
    const yl = yearLevelFromGraduationYear(typeof gy === 'string' ? parseInt(gy, 10) : gy);
    const classNames = classNamesByStudent[u.id] || [];
    const classSummary = classNames.length === 0
      ? ''
      : classNames.length <= 2
        ? classNames.join(', ')
        : classNames.slice(0, 2).join(', ') + ` +${classNames.length - 2}`;
    return {
      id: u.id,
      display_name: meta.display_name || meta.full_name || meta.name || u.email || 'Unknown',
      email: u.email || '',
      year_level: yl,
      class_summary: classSummary,
    };
  });

  return res.status(200).json({ rows });
}
