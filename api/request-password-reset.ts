import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';
import { createClient } from '@supabase/supabase-js';

/**
 * Send a password reset email via Supabase.
 *
 * We intentionally ALWAYS return 200 regardless of whether the email exists,
 * so an attacker can't use this endpoint to enumerate which addresses have
 * ProofReady accounts.
 *
 * Requires SUPABASE_SITE_URL to be set (used to build the redirect link in
 * the reset email). Defaults to the incoming request's origin if not set.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const origin = (req.headers.origin as string)
    || process.env.SUPABASE_SITE_URL
    || 'https://proofready.app';
  const redirectTo = `${origin.replace(/\/$/, '')}/reset.html`;

  // Use the anon key + standard password-reset flow. This is the public,
  // rate-limited flow Supabase intends for this use case.
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY!,
  );

  try {
    await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  } catch (e: any) {
    console.warn('[request-password-reset] Supabase call failed:', e?.message || e);
    // Swallow — we want identical responses for success and failure.
  }

  return res.status(200).json({
    ok: true,
    message: 'If an account exists for that address, a reset link has been sent.',
  });
}
