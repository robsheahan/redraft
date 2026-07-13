/**
 * Batched user-name lookup.
 *
 * Several API endpoints need to attach display names + emails (and sometimes
 * role / graduation year) to user IDs (task-submissions, task-csv, class
 * member lists, insights, etc.).
 *
 * Primary path: the `get_user_info(uuid[])` SQL function (see
 * scripts/user-info-rpc-migration.sql) — one indexed query for exactly the
 * ids we need. Fallback (until the migration has run): page through
 * supabase.auth.admin.listUsers, whose cost grows with TOTAL platform users
 * and made every page slower with every signup.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface UserInfo {
  name: string;
  email: string;
  role: string | null;
  graduation_year: string | null;
}

interface CacheEntry {
  expires: number;
  map: Record<string, UserInfo | null>; // null = looked up, doesn't exist
}

const CACHE_TTL_MS = 30 * 1000; // 30 seconds — enough to cover a single request
let cached: CacheEntry | null = null;
let rpcAvailable: boolean | null = null; // null = unknown, probe on first call

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
  if (!cached || cached.expires <= now) cached = { expires: now + CACHE_TTL_MS, map: {} };

  const missing = [...new Set(userIds)].filter(id => !(id in cached!.map));
  if (missing.length > 0) {
    const viaRpc = rpcAvailable === false ? null : await fetchViaRpc(supabase, missing);
    if (viaRpc) {
      Object.assign(cached.map, viaRpc);
      // Negative-cache ids the RPC didn't return (deleted users) so we don't
      // re-query them on every call within the TTL.
      missing.forEach(id => { if (!(id in cached!.map)) cached!.map[id] = null; });
    } else {
      // Fallback: one listUsers sweep builds the whole map (old behaviour).
      Object.assign(cached.map, await fetchViaListUsers(supabase));
      missing.forEach(id => { if (!(id in cached!.map)) cached!.map[id] = null; });
    }
  }

  return filterTo(cached.map, userIds);
}

async function fetchViaRpc(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Record<string, UserInfo> | null> {
  const { data, error } = await supabase.rpc('get_user_info', { ids });
  if (error) {
    if (rpcAvailable !== false) {
      console.warn('[user-names] get_user_info RPC unavailable, falling back to listUsers:', error.message);
    }
    // Pin the fallback only when the function genuinely doesn't exist
    // (migration not run yet) — a transient error should retry the RPC on
    // the next call rather than downgrade this lambda for its lifetime.
    const code = (error as any).code;
    if (code === 'PGRST202' || code === '42883') rpcAvailable = false;
    return null;
  }
  rpcAvailable = true;
  const map: Record<string, UserInfo> = {};
  (data || []).forEach((r: any) => {
    map[r.id] = {
      name: r.display_name || r.email || 'Unknown',
      email: r.email || '',
      role: r.role || null,
      graduation_year: r.graduation_year || null,
    };
  });
  return map;
}

async function fetchViaListUsers(supabase: SupabaseClient): Promise<Record<string, UserInfo>> {
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
      const meta = u.user_metadata as any;
      map[u.id] = {
        name: pickName(meta, u.email),
        email: u.email || '',
        role: ((u as any).app_metadata?.role ?? meta?.role) || null,
        graduation_year: meta?.graduation_year != null ? String(meta.graduation_year) : null,
      };
    }
    if (users.length < 1000) break;
    page++;
    if (page > 50) break; // safety: 50,000 users
  }
  return map;
}

/**
 * Users whose email domain matches one of the given (lowercased) domains,
 * with their role — used by the email-domain school-membership path.
 * Returns null when the RPC isn't available (caller falls back to listUsers).
 */
export async function getUsersByEmailDomain(
  supabase: SupabaseClient,
  domains: string[],
): Promise<Array<{ id: string; email: string; role: string | null }> | null> {
  if (domains.length === 0) return [];
  const { data, error } = await supabase.rpc('get_users_by_email_domain', { domains });
  if (error) {
    console.warn('[user-names] get_users_by_email_domain RPC unavailable:', error.message);
    return null;
  }
  return (data || []).map((r: any) => ({ id: r.id, email: r.email || '', role: r.role || null }));
}

function filterTo(
  source: Record<string, UserInfo | null>,
  ids: string[],
): Record<string, UserInfo> {
  const out: Record<string, UserInfo> = {};
  for (const id of ids) {
    const info = source[id];
    if (info) out[id] = info;
  }
  return out;
}
