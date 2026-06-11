/**
 * Shared handler wrapper — one place for the cross-cutting concerns every API
 * route repeats: CORS, method check, auth, and a try/catch that reports to
 * Sentry and returns a GENERIC error body.
 *
 * Why it exists (audit quality item 1 + M3):
 * - 16 handlers had no try/catch at all — an unhandled throw surfaced Vercel's
 *   default error page (and sometimes the raw message) to the client.
 * - Most handlers returned `error.message` verbatim on failure (M3) — leaking
 *   internal detail. The wrapper's catch returns a fixed, safe message; a
 *   handler that wants a specific 4xx still returns it explicitly (those are
 *   intentional, user-facing messages, not raw error text).
 * - CORS + method + auth boilerplate was copy-pasted ~30 times.
 *
 * Usage:
 *   export default withHandler({ methods: ['POST'], label: 'set-role' },
 *     async (req, res, { user, supabase }) => {
 *       // ...handler body; `user` is guaranteed non-null for auth:'required'
 *       res.status(200).json({ ok: true });
 *     });
 *
 * A handler still returns its own success and intentional-error responses; the
 * wrapper only owns the boilerplate and the catch-all 500.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { User, SupabaseClient } from '@supabase/supabase-js';
import { applyCors } from './cors.js';
import { getSupabase, verifyAuth } from './auth.js';
import { captureError } from './sentry.js';

export interface HandlerContext {
  /** Non-null when auth is 'required'; possibly null when 'optional'/'none'. */
  user: User | null;
  /** Service-role client (bypasses RLS) — same instance for the request. */
  supabase: SupabaseClient;
}

export interface HandlerOptions {
  /** Allowed HTTP methods, e.g. ['POST'] or ['GET','POST']. */
  methods: string[];
  /**
   * 'required' (default): reject with 401 if not authenticated.
   * 'optional': attach the user if present, allow anonymous.
   * 'none': skip auth entirely (public endpoints like signup).
   */
  auth?: 'required' | 'optional' | 'none';
  /** Short label for Sentry/log context (defaults to the request path). */
  label?: string;
}

type HandlerBody = (
  req: VercelRequest,
  res: VercelResponse,
  ctx: HandlerContext,
) => Promise<unknown> | unknown;

export function withHandler(opts: HandlerOptions, body: HandlerBody) {
  const authMode = opts.auth ?? 'required';

  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (applyCors(req, res)) return;

    if (!opts.methods.includes(req.method ?? '')) {
      res.setHeader('Allow', opts.methods.join(', '));
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    let user: User | null = null;
    if (authMode !== 'none') {
      user = await verifyAuth(req);
      if (!user && authMode === 'required') {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
    }

    try {
      await body(req, res, { user, supabase: getSupabase() });
    } catch (err) {
      captureError(err, { endpoint: opts.label ?? req.url ?? 'unknown' });
      // Generic body only — never leak err.message to the client (M3).
      if (!res.headersSent) {
        res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
      }
    }
  };
}
