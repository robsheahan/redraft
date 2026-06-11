import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../../lib/cors.js';
import { verifyAuth, getSupabase } from '../../lib/auth.js';
import { readLinkRequest, consumeLinkRequest } from '../../lib/lti/link.js';
import { captureError } from '../../lib/sentry.js';

/**
 * Account-link endpoint for the Q2B opt-in flow. The lti-link.html page (reached
 * from a launch whose email collides with an existing account) calls this:
 *   GET  ?token=…  → does the request still stand, and does it match the
 *                    signed-in account's email?
 *   POST { token } → confirm: create the (platform, canvas_user_id) → account
 *                    mapping, but only if the signed-in user's email matches the
 *                    launch email. Future launches then resolve via the mapping.
 *
 * Bespoke (like the other api/lti/* handlers): manual auth + JSON.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method === 'GET') return getInfo(req, res);
  if (req.method === 'POST') return confirmLink(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

const EXPIRED = 'This link request has expired or was already used. Relaunch from Canvas to try again.';

async function getInfo(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const token = (req.query.token as string || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });

  const pending = await readLinkRequest(token);
  if (!pending) return res.status(410).json({ error: EXPIRED });

  const emailMatches = (user.email || '').trim().toLowerCase() === pending.email.trim().toLowerCase();
  return res.status(200).json({
    canvas_email: pending.email,
    your_email: user.email || null,
    email_matches: emailMatches,
  });
}

async function confirmLink(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });

  // Check the email match BEFORE consuming, so a mismatch doesn't burn the
  // single-use request.
  const pending = await readLinkRequest(token);
  if (!pending) return res.status(410).json({ error: EXPIRED });

  // SECURITY: only link the Canvas identity to the account whose email matches
  // what Canvas asserted — and which the user just authenticated to. Consent
  // (signed in) plus the email match is what authorises the link; a platform-
  // asserted email alone never does (L1).
  if ((user.email || '').trim().toLowerCase() !== pending.email.trim().toLowerCase()) {
    return res.status(403).json({
      error: `This Canvas launch is for ${pending.email}. Sign in to that ProofReady account to link it.`,
    });
  }

  const reqRow = await consumeLinkRequest(token);
  if (!reqRow) return res.status(410).json({ error: EXPIRED });

  const supabase = getSupabase();
  // Create the platform→account mapping. 23505 = already linked → converge (ok).
  const { error } = await supabase.from('lti_user_mappings').insert({
    platform_id: reqRow.platform_id,
    canvas_user_id: reqRow.canvas_user_id,
    user_id: user.id,
    email: reqRow.email,
  });
  if (error && (error as { code?: string }).code !== '23505') {
    captureError(error, { stage: 'lti-link-mapping', user_id: user.id });
    return res.status(500).json({ error: 'Could not link your account. Please try again.' });
  }

  // Seed the authoritative role from the launch if the account has none yet
  // (a self-signup that never finished choose-role). Best-effort; never blocks.
  if (!(user.app_metadata as Record<string, unknown> | null)?.role && reqRow.role) {
    try {
      await supabase.auth.admin.updateUserById(user.id, {
        app_metadata: { ...((user.app_metadata as Record<string, unknown>) || {}), role: reqRow.role },
      });
    } catch { /* non-fatal */ }
  }

  return res.status(200).json({ ok: true });
}
