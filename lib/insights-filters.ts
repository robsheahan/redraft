import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserInfoBatch } from './user-names.js';

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
export function scopeKeyForFilters(
  filters: InsightsFilters,
  restrictedFaculties?: string[] | null,
): string {
  // The caller's faculty restriction is part of the scope, not just the filters:
  // a leader restricted to [English, Maths] with no explicit faculty filter sees
  // a DIFFERENT corpus than an unrestricted executive, even though their filter
  // objects are identical. Folding the sorted restriction into the key stops the
  // two from sharing (and overwriting) one cached card row.
  const restriction = (restrictedFaculties && restrictedFaculties.length)
    ? [...restrictedFaculties].sort()
    : null;
  return JSON.stringify({
    class_id: filters.class_id ?? null,
    faculty: filters.faculty ?? null,
    course: filters.course ?? null,
    year_level: filters.year_level ?? null,
    time_window: filters.time_window ?? null,
    restriction,
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
  subs: Array<{ id?: string; created_at?: string | null; graded_at?: string | null; total_mark?: number | null; feedback?: any }>,
): string {
  let latestCreated = '';
  let latestGraded = '';
  let gradedCount = 0;
  // Order-independent signature of the (id, mark) pairs. A plain sum of marks is
  // blind to moderation edits that cancel out (A 12→10 while B 8→10 leaves the
  // sum unchanged) — which then serves a stale decile card as "fresh". Folding a
  // per-row hash of id+mark makes any individual mark change move the signature,
  // regardless of whether the totals happen to net to zero.
  let markSig = 0;
  // Signature of the FEEDBACK CONTENT the cards are actually synthesised from, so
  // an in-place feedback/skill regeneration (same id, same mark) still refreshes
  // the card instead of serving stale prose.
  let fbSig = 0;
  for (const s of subs) {
    if (s.created_at && s.created_at > latestCreated) latestCreated = s.created_at;
    if (s.graded_at) {
      gradedCount++;
      if (s.graded_at > latestGraded) latestGraded = s.graded_at;
    }
    if (typeof s.total_mark === 'number') {
      markSig = (markSig + strHash(`${s.id ?? ''}:${s.total_mark}`)) % 0xffffffff;
    }
    if (s.feedback != null) {
      // Bounded — a stable content signature, not the whole blob.
      fbSig = (fbSig + strHash(`${s.id ?? ''}:${JSON.stringify(s.feedback).slice(0, 2000)}`)) % 0xffffffff;
    }
  }
  // The leading version tag invalidates existing cohort-card caches whenever card
  // generation logic changes (prompts, schemas, gap/strength counts) — so the next
  // regenerate actually re-runs the new logic instead of serving a stale card.
  return `v4|${subs.length}|${latestCreated}|${gradedCount}|${markSig}|${latestGraded}|${fbSig}`;
}

// Small deterministic string hash (djb2). Not cryptographic — only needs to make
// a value change detectable when its inputs change, for cache-freshness folding.
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
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

/**
 * Filter a set of user ids down to those at the given year level, resolving
 * graduation_year via getUserInfoBatch (RPC-backed) — so callers pass only
 * the ids actually in play (submission authors, class members) instead of
 * scanning every platform user.
 */
export async function filterIdsByYearLevel(
  supabase: SupabaseClient,
  ids: string[],
  yearLevel: number,
  now: Date = new Date(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const info = await getUserInfoBatch(supabase, ids);
  return ids.filter(id => {
    const gy = info[id]?.graduation_year;
    const lvl = yearLevelFromGraduationYear(gy != null ? parseInt(gy, 10) : null, now);
    return lvl === yearLevel;
  });
}
