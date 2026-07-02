/**
 * Paginated Supabase reads.
 *
 * PostgREST caps a single response at ~1000 rows (`db-max-rows`). Insights
 * queries that select every in-scope submission / class_member silently got an
 * arbitrary 1000-row subset at scale (300 students × 4 drafts > 1000) — wrong
 * stats, and a nondeterministic subset (no ORDER BY) that made the cohort
 * fingerprint flap between requests. `fetchAllRows` loops `.range()` until a
 * short page, so the caller gets the whole set.
 *
 * The query MUST carry a stable `.order()` (by a unique-ish column, e.g. `id` or
 * `created_at,id`) — range pagination over an unordered result can repeat or skip
 * rows. Pass a factory that applies `.range(from, to)` to a freshly-built query.
 */

const PAGE_SIZE = 1000;

export async function fetchAllRows<T = any>(
  makeRangedQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  // Bound the loop defensively — 200 pages × 1000 = 200k rows is far beyond any
  // real in-scope corpus, so hitting it means a missing ORDER BY, not real data.
  for (let page = 0; page < 200; page++) {
    const to = from + pageSize - 1;
    const { data, error } = await makeRangedQuery(from, to);
    if (error) throw error;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
