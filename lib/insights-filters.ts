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

export type TimeWindow = '12_months' | 'this_year' | 'all_time';
export const DEFAULT_TIME_WINDOW: TimeWindow = '12_months';

export interface InsightsFilters {
  faculty?: string | null;
  course?: string | null;
  class_id?: string | null;
  year_level?: number | null;
  /**
   * Rolling time window applied to the submissions sample. Defaults to
   * 12 months — set explicitly to 'all_time' on every caller that should
   * see unbounded history (e.g. longitudinal class baseline + student
   * profile endpoints). Cohort cards honour this filter.
   */
  time_window?: TimeWindow;
}

export function parseFiltersFromQuery(q: Record<string, any> | undefined): InsightsFilters {
  const out: InsightsFilters = { time_window: DEFAULT_TIME_WINDOW };
  if (!q) return out;
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
  const tw = (q.time_window || '').toString().trim();
  if (tw === 'this_year' || tw === 'all_time' || tw === '12_months') {
    out.time_window = tw;
  }
  return out;
}

/**
 * Resolve the time-window filter to an ISO timestamp cutoff. Submissions
 * with `created_at >= cutoff` are in scope. Returns null for 'all_time'
 * (caller skips the filter altogether).
 */
export function getTimeWindowCutoff(
  window: TimeWindow | undefined,
  now: Date = new Date(),
): Date | null {
  if (!window || window === 'all_time') return null;
  if (window === 'this_year') {
    return new Date(now.getFullYear(), 0, 1, 0, 0, 0);
  }
  // Default: 12-month rolling.
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 12);
  return cutoff;
}

/** Human label for the active window — used in UI scope strings. */
export function formatTimeWindow(window: TimeWindow | undefined): string {
  if (window === 'all_time') return 'All time';
  if (window === 'this_year') return 'This year';
  return 'Last 12 months';
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
  // time_window is excluded — it always has a default, so its presence isn't
  // a signal that the user has actively narrowed the scope.
  return !!(filters.faculty || filters.course || filters.class_id || filters.year_level);
}

/**
 * Stable string of the filters that change a cohort card's content. Used as a
 * cache key so different scopes (e.g. an English HOD's faculty view vs an
 * executive's whole-school view) keep their own cached cards instead of
 * overwriting one shared slot. Same scope → same key → shared/reused card.
 */
export function scopeKeyForFilters(filters: InsightsFilters): string {
  return JSON.stringify({
    class_id: filters.class_id ?? null,
    faculty: filters.faculty ?? null,
    course: filters.course ?? null,
    year_level: filters.year_level ?? null,
    time_window: filters.time_window ?? null,
  });
}

/**
 * Signature of the in-scope submission corpus. Changes whenever a new draft
 * lands (count / latest_created) or a mark is added or edited (graded_count /
 * mark_sum / latest_graded), so a cached card is served only when the live
 * corpus still matches the one it was generated from.
 *
 * Must be computed over the same submission set in every caller (the deduped,
 * scope-filtered cohort) so the fingerprints are comparable.
 */
export function cohortFingerprint(
  subs: Array<{ created_at?: string | null; graded_at?: string | null; total_mark?: number | null }>,
): string {
  let latestCreated = '';
  let latestGraded = '';
  let gradedCount = 0;
  let markSum = 0;
  for (const s of subs) {
    if (s.created_at && s.created_at > latestCreated) latestCreated = s.created_at;
    if (s.graded_at) {
      gradedCount++;
      if (s.graded_at > latestGraded) latestGraded = s.graded_at;
    }
    if (typeof s.total_mark === 'number') markSum += s.total_mark;
  }
  return `${subs.length}|${latestCreated}|${gradedCount}|${markSum}|${latestGraded}`;
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
