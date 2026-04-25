/**
 * Rate limiting and spend protection for expensive endpoints (Claude-backed).
 *
 * Uses a Supabase-backed call log so limits hold across serverless cold starts.
 * Trades a couple of extra DB queries per call for correctness. At pilot scale
 * (tens of schools, hundreds of students) this is fine; if it becomes a
 * bottleneck later, swap the backing store for Upstash Redis.
 *
 * Two gates:
 *   1. Per-user hourly limit — stops a runaway tab / script from draining budget
 *   2. Global daily limit  — hard circuit breaker if many users misbehave at once
 *
 * Failures are fail-closed for per-user (if we can't check, we reject) and
 * fail-open for the global check (the DB being down shouldn't block the pilot
 * during an outage — per-user still protects us from runaway individuals).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RateLimitConfig {
  endpoint: string;
  perUserPerHour: number;
  globalPerDay: number;
}

export interface RateLimitResult {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

export async function checkAndLogRateLimit(
  supabase: SupabaseClient,
  userId: string | null,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // 1. Per-user hourly check (fail-closed)
  if (userId) {
    const { count, error } = await supabase
      .from('api_call_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('endpoint', config.endpoint)
      .gte('created_at', oneHourAgo);

    if (error) {
      console.error('[rate-limit] per-user check failed, rejecting request:', error.message);
      return {
        ok: false,
        reason: "We couldn't verify your usage quota right now. Please try again in a minute.",
      };
    }

    if ((count ?? 0) >= config.perUserPerHour) {
      return {
        ok: false,
        reason: `You've hit the hourly limit of ${config.perUserPerHour} feedback requests. Please wait before submitting again.`,
        retryAfterSeconds: 60 * 60,
      };
    }
  }

  // 2. Global daily check (fail-open)
  try {
    const { count, error } = await supabase
      .from('api_call_log')
      .select('id', { count: 'exact', head: true })
      .eq('endpoint', config.endpoint)
      .gte('created_at', oneDayAgo);

    if (error) {
      console.warn('[rate-limit] global check failed, continuing:', error.message);
    } else {
      const used = count ?? 0;
      if (used >= config.globalPerDay) {
        return {
          ok: false,
          reason: 'ProofReady has hit its daily capacity. Please try again tomorrow — we are working to increase capacity.',
          retryAfterSeconds: 60 * 60 * 12,
        };
      }
      // Early-warning log so operational monitoring can pick it up before
      // we actually hit the cap. 80% threshold matches the admin dashboard.
      const pct = used / config.globalPerDay;
      if (pct >= 0.8) {
        console.warn('[rate-limit] DAILY CAP NEARING for endpoint', config.endpoint, '— used', used, 'of', config.globalPerDay, '(' + Math.round(pct * 100) + '%)');
      }
    }
  } catch (e: any) {
    console.warn('[rate-limit] global check threw, continuing:', e?.message || e);
  }

  // 3. Log this call so future checks see it. Best-effort — if this insert
  //    fails, we still serve the request (the alternative is denying service
  //    on a transient DB error).
  try {
    await supabase.from('api_call_log').insert({
      user_id: userId,
      endpoint: config.endpoint,
    });
  } catch (e: any) {
    console.warn('[rate-limit] failed to log call, continuing:', e?.message || e);
  }

  return { ok: true };
}
