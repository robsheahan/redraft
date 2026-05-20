/**
 * Filter parsing + application for the leadership insights dashboard.
 *
 * Filters come from the URL query string (or POST body) and apply
 * uniformly across every card endpoint. The four filters supported:
 *
 *   - faculty   — NSW KLA (English / PDHPE / HSIE / ...). Filters tasks
 *                 + classes by their course's derived discipline.
 *   - course    — exact match against task.course (and class.course)
 *   - class_id  — exact match against class.id
 *   - year_level — integer 7..12. Derived from each student's
 *                 graduation_year metadata; applies at the submission
 *                 scope (i.e. filters which submissions are counted).
 *                 Other entities (classes, tasks, teachers) are not
 *                 filtered by year_level — that would force every task
 *                 to commit to one year, which they don't.
 *
 * Faculty-restricted leaders have their faculty filter narrowed to the
 * intersection with their allowed list — they cannot widen scope past
 * what their school admin granted.
 */

export interface InsightsFilters {
  faculty?: string | null;
  course?: string | null;
  class_id?: string | null;
  year_level?: number | null;
}

export function parseFiltersFromQuery(q: Record<string, any> | undefined): InsightsFilters {
  if (!q) return {};
  const out: InsightsFilters = {};
  const f = (q.faculty || '').toString().trim();
  if (f) out.faculty = f;
  const c = (q.course || '').toString().trim();
  if (c) out.course = c;
  const cid = (q.class_id || '').toString().trim();
  if (cid) out.class_id = cid;
  const yl = (q.year_level || '').toString().trim();
  if (yl) {
    const n = parseInt(yl, 10);
    if (Number.isFinite(n) && n >= 4 && n <= 12) out.year_level = n;
  }
  return out;
}

/**
 * Narrow the caller's filters to honour their `school_members.faculties[]`
 * restriction. If a leader is scoped to PDHPE+HSIE and tries to pass
 * `?faculty=English`, the resulting filter is null (no data shown rather
 * than data they shouldn't see).
 */
export function applyFacultyScope(
  filters: InsightsFilters,
  restrictedFaculties: string[] | null,
): InsightsFilters & { _denied?: true } {
  if (!restrictedFaculties || restrictedFaculties.length === 0) return filters;
  if (filters.faculty) {
    if (!restrictedFaculties.includes(filters.faculty)) {
      return { ...filters, _denied: true };
    }
    return filters;
  }
  // No explicit faculty filter — restrict to the leader's set implicitly.
  if (restrictedFaculties.length === 1) {
    return { ...filters, faculty: restrictedFaculties[0] };
  }
  return filters;
}

export function isFilterActive(filters: InsightsFilters): boolean {
  return !!(filters.faculty || filters.course || filters.class_id || filters.year_level);
}

/**
 * Compute a student's current year level from their graduation_year
 * metadata. Returns null if the user has no graduation_year or the
 * computed value is outside the expected range.
 *
 *   year_level = 12 - (graduation_year - current_year)
 *
 * e.g. a student graduating in 2027 with the current year 2026 is in
 * Year 11 (12 - 1 = 11).
 */
export function yearLevelFromGraduationYear(
  graduationYear: number | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!graduationYear || !Number.isFinite(graduationYear)) return null;
  const currentYear = now.getFullYear();
  const level = 12 - (graduationYear - currentYear);
  if (!Number.isFinite(level)) return null;
  if (level < 4 || level > 13) return null;
  return level;
}

/**
 * Build a Set of user_ids that match the requested year_level, given an
 * array of auth.users. Used to filter submissions by student year level.
 */
export function userIdsForYearLevel(
  allUsers: Array<{ id: string; user_metadata?: any }>,
  yearLevel: number,
  now: Date = new Date(),
): Set<string> {
  const out = new Set<string>();
  for (const u of allUsers) {
    const gy = u.user_metadata?.graduation_year;
    const lvl = yearLevelFromGraduationYear(typeof gy === 'string' ? parseInt(gy, 10) : gy, now);
    if (lvl === yearLevel) out.add(u.id);
  }
  return out;
}
