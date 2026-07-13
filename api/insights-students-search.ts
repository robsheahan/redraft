import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import {
  resolveInsightsAccess,
  getInScopeStudentIds,
} from '../lib/schools.js';
import { getUserInfoBatch } from '../lib/user-names.js';
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

export default withHandler({ methods: ['GET'], label: 'insights-students-search' }, async (req, res, ctx) => {
  const user = ctx.user!;

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

  // Substring match over the in-scope students only (RPC-backed batched
  // lookup) — previously this listed every platform user and filtered.
  const info = await getUserInfoBatch(supabase, [...inScope]);
  const candidates: Array<{ user: { id: string; name: string; email: string; graduation_year: string | null }; surnameStarts: boolean }> = [];
  for (const [id, u] of Object.entries(info)) {
    const display = String(u.name || '').trim();
    const email = String(u.email || '');
    const blob = (display + ' ' + email).toLowerCase();
    if (!blob.includes(q)) continue;
    // Rank surname matches higher: split on whitespace, last token = surname,
    // mark if it starts with the query string.
    const tokens = display.split(/\s+/).filter(Boolean);
    const surname = (tokens[tokens.length - 1] || '').toLowerCase();
    const surnameStarts = surname.startsWith(q);
    candidates.push({ user: { id, name: display, email, graduation_year: u.graduation_year }, surnameStarts });
  }
  candidates.sort((a, b) => {
    if (a.surnameStarts !== b.surnameStarts) return a.surnameStarts ? -1 : 1;
    return (a.user.name || a.user.email).toLowerCase().localeCompare((b.user.name || b.user.email).toLowerCase());
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
    const gy = u.graduation_year;
    const yl = yearLevelFromGraduationYear(gy != null ? parseInt(gy, 10) : null);
    const classNames = classNamesByStudent[u.id] || [];
    const classSummary = classNames.length === 0
      ? ''
      : classNames.length <= 2
        ? classNames.join(', ')
        : classNames.slice(0, 2).join(', ') + ` +${classNames.length - 2}`;
    return {
      id: u.id,
      display_name: u.name || u.email || 'Unknown',
      email: u.email || '',
      year_level: yl,
      class_summary: classSummary,
    };
  });

  return res.status(200).json({ rows });
});
