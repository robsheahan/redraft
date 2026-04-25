/**
 * Batched user-name lookup.
 *
 * Several API endpoints need to attach display names + emails to user IDs
 * (task-submissions, task-csv, class member lists, etc.). The naive pattern
 * is to loop the IDs and call supabase.auth.admin.getUserById per ID, which
 * is N serial round-trips and times out on classes >30 students.
 *
 * Instead, listUsers returns up to 1000 in one call. We page through if
 * needed and build a single map. Cached in-process for a short time so a
 * single function invocation that hits this twice doesn't repeat the work.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

interface UserInfo {
  name: string;
  email: string;
}

interface CacheEntry {
  expires: number;
  map: Record<string, UserInfo>;
}

const CACHE_TTL_MS = 30 * 1000; // 30 seconds — enough to cover a single request
let cached: CacheEntry | null = null;

function pickName(meta: any, email: string | undefined): string {
  return meta?.display_name || meta?.full_name || meta?.name || email || 'Unknown';
}

/**
 * Get display info for a set of user IDs. Returns a record keyed by user_id.
 * Unknown IDs are simply absent from the result — caller should fall back.
 */
export async function getUserInfoBatch(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Record<string, UserInfo>> {
  if (userIds.length === 0) return {};

  const now = Date.now();
  if (cached && cached.expires > now) {
    // If everything is in the cache, return immediately.
    const allHit = userIds.every(id => id in cached!.map);
    if (allHit) return filterTo(cached.map, userIds);
  }

  // Fetch all users in one (or a few) listUsers pages. Supabase's admin API
  // caps at 1000 per page; for early pilot we won't exceed that.
  const map: Record<string, UserInfo> = {};
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.warn('[user-names] listUsers failed on page', page, error.message);
      break;
    }
    const users = data?.users || [];
    if (users.length === 0) break;
    for (const u of users) {
      map[u.id] = { name: pickName(u.user_metadata, u.email), email: u.email || '' };
    }
    if (users.length < 1000) break;
    page++;
  }

  cached = { expires: now + CACHE_TTL_MS, map };
  return filterTo(map, userIds);
}

function filterTo(source: Record<string, UserInfo>, ids: string[]): Record<string, UserInfo> {
  const out: Record<string, UserInfo> = {};
  for (const id of ids) if (id in source) out[id] = source[id];
  return out;
}
