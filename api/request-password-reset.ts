import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { withHandler } from '../lib/with-handler.js';

/**
 * Send a password-reset email.
 *
 * Preferred path: generate a recovery link with the service role and deliver it
 * via Resend (the same provider the rest of the app uses) — reliable, branded,
 * and not subject to Supabase's heavily rate-limited default email service.
 *
 * Fallback (no RESEND_API_KEY): Supabase's built-in resetPasswordForEmail.
 *
 * We ALWAYS return 200 regardless of whether the address has an account, so the
 * endpoint can't be used to enumerate which emails are registered.
 *
 * IMPORTANT (dashboard config, not code): the redirect target `/reset.html`
 * must be listed in Supabase → Auth → URL Configuration → Redirect URLs, or
 * Supabase drops it and the recovery link falls back to the Site URL (which
 * doesn't handle the recovery token).
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = 'help@proofready.app';

// The rate-limit log keys on a uuid `user_id`, but this endpoint is
// unauthenticated and rate-limits per email address. Derive a stable uuid-shaped
// key from the email so the per-address limit works without a real user id.
// (api_call_log.user_id is a plain uuid with no FK, so a synthetic value is fine.)
function emailRateKey(email: string): string {
  const h = createHash('sha256').update('pwreset:' + email).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export default withHandler({ methods: ['POST'], auth: 'none', label: 'request-password-reset' }, async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const normalisedEmail = email.trim().toLowerCase();

  // Rate-limit per address (stops reset-email bombing of one inbox) plus a
  // global daily cap. Returned identically for existent/non-existent emails,
  // so it doesn't leak account existence.
  const rate = await checkAndLogRateLimit(getSupabase(), emailRateKey(normalisedEmail), {
    endpoint: 'request-password-reset',
    perUserPerHour: 3,
    globalPerDay: 200,
  });
  if (!rate.ok) {
    if (rate.retryAfterSeconds) res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    return res.status(429).json({ error: rate.reason || 'Too many reset requests. Please try again later.' });
  }

  const origin = (req.headers.origin as string)
    || process.env.SUPABASE_SITE_URL
    || 'https://proofready.app';
  const redirectTo = `${origin.replace(/\/$/, '')}/reset.html`;
  const resendKey = process.env.RESEND_API_KEY;

  try {
    if (resendKey) {
      // Generate the recovery link server-side, then deliver via Resend.
      const admin = getSupabase();
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: normalisedEmail,
        options: { redirectTo },
      });
      // An error here is expected for addresses with no account — swallow it
      // (anti-enumeration). Only send when we actually got a link.
      const link = data?.properties?.action_link;
      if (!error && link) {
        await sendResetEmail(resendKey, normalisedEmail, link);
      } else if (error) {
        console.warn('[request-password-reset] generateLink:', error.message);
      }
    } else {
      // Fallback: Supabase's built-in reset email.
      const anon = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY!,
      );
      await anon.auth.resetPasswordForEmail(normalisedEmail, { redirectTo });
    }
  } catch (e: any) {
    console.warn('[request-password-reset] send failed:', e?.message || e);
    // Swallow — we want identical responses for success and failure.
  }

  return res.status(200).json({
    ok: true,
    message: 'If an account exists for that address, a reset link has been sent.',
  });
});

async function sendResetEmail(apiKey: string, to: string, link: string): Promise<void> {
  const text =
`Someone (hopefully you) asked to reset the password for your ProofReady account.

Reset your password using this link:
${link}

If you didn't request this, you can safely ignore this email — your password won't change. This link expires in 1 hour.

— ProofReady`;

  const html =
`<div style="font-family:'Inter',Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.6;max-width:520px;margin:0 auto">
  <p>Someone (hopefully you) asked to reset the password for your ProofReady account.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="display:inline-block;background:#ed7615;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:8px">Reset your password</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Or paste this link into your browser:<br>
    <a href="${link}" style="color:#ed7615;word-break:break-all">${link}</a>
  </p>
  <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
  <p style="font-size:12.5px;color:#9ca3af">If you didn't request this, you can safely ignore this email — your password won't change. This link expires in 1 hour.</p>
</div>`;

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `ProofReady <${FROM_ADDRESS}>`,
      to: [to],
      subject: 'Reset your ProofReady password',
      text,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend ${response.status}: ${body}`);
  }
}
