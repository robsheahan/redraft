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
import { captureError } from './sentry.js';

export interface RateLimitConfig {
  endpoint: string;
  perUserPerHour: number;
  /**
   * Optional per-user daily cap. Used by the own-task path to stop students
   * gaming the per-task 3-draft cap by spinning up new "own tasks" each
   * time. Counts only calls to this same endpoint (so other endpoints'
   * traffic doesn't eat into this quota).
   */
  perUserPerDay?: number;
  globalPerDay: number;
  /** Optional override message for the per-user-per-day cap. */
  perUserPerDayMessage?: string;
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

  // The three gate counts are independent reads — run them in parallel (one
  // round trip instead of up to three), then evaluate in priority order so
  // messages and fail-open/closed behaviour are unchanged.
  const [userHourRes, userDayRes, globalRes] = await Promise.all([
    userId
      ? supabase
        .from('api_call_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('endpoint', config.endpoint)
        .gte('created_at', oneHourAgo)
      : Promise.resolve(null),
    userId && config.perUserPerDay !== undefined
      ? supabase
        .from('api_call_log')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('endpoint', config.endpoint)
        .gte('created_at', oneDayAgo)
      : Promise.resolve(null),
    supabase
      .from('api_call_log')
      .select('id', { count: 'exact', head: true })
      .eq('endpoint', config.endpoint)
      .gte('created_at', oneDayAgo)
      .then(r => r, (e: any) => ({ count: null, error: e } as any)),
  ]);

  // 1. Per-user hourly check (fail-closed)
  if (userHourRes) {
    const { count, error } = userHourRes;
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

  // 1b. Per-user daily check (fail-closed). Only when caller asked for it
  //     — most endpoints rely on the per-hour cap alone.
  if (userDayRes) {
    const { count: dayCount, error: dayError } = userDayRes;
    if (dayError) {
      console.error('[rate-limit] per-user-per-day check failed, rejecting request:', dayError.message);
      return {
        ok: false,
        reason: "We couldn't verify your usage quota right now. Please try again in a minute.",
      };
    }

    if ((dayCount ?? 0) >= config.perUserPerDay!) {
      return {
        ok: false,
        reason: config.perUserPerDayMessage
          || `You've reached your daily limit of ${config.perUserPerDay} requests. Please try again tomorrow.`,
        retryAfterSeconds: 60 * 60 * 12,
      };
    }
  }

  // 2. Global daily check (fail-open)
  try {
    const { count, error } = globalRes as { count: number | null; error: any };

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
  //    on a transient DB error). But it must be VISIBLE: supabase-js returns
  //    errors rather than throwing, so inspect the result — persistent insert
  //    failures silently disable the whole limiter otherwise.
  try {
    const { error: logErr } = await supabase.from('api_call_log').insert({
      user_id: userId,
      endpoint: config.endpoint,
    });
    if (logErr) {
      console.error('[rate-limit] failed to log call — limiter is not recording usage:', logErr.message);
      captureError(logErr, { stage: 'rate-limit-log-insert', endpoint: config.endpoint });
    }
  } catch (e: any) {
    console.error('[rate-limit] failed to log call — limiter is not recording usage:', e?.message || e);
    captureError(e, { stage: 'rate-limit-log-insert', endpoint: config.endpoint });
  }

  return { ok: true };
}
