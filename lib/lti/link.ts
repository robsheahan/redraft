import { randomUUID } from 'node:crypto';
import { getSupabase } from '../auth.js';

/**
 * Account-link requests for the Q2B opt-in flow.
 *
 * When an LTI launch's email already belongs to a different account, we don't
 * auto-link (a platform-asserted email isn't proof of identity). Instead we
 * record a short-lived request and send the user to a page where, signed into
 * the existing account, they consent to linking their Canvas identity.
 */

export interface LinkRequest {
  token: string;
  platform_id: string;
  canvas_user_id: string;
  email: string;
  display_name: string | null;
  role: string | null;
}

export async function createLinkRequest(opts: {
  platformId: string;
  canvasUserId: string;
  email: string;
  displayName?: string | null;
  role?: string | null;
}): Promise<string> {
  const supabase = getSupabase();
  const token = randomUUID();
  const { error } = await supabase.from('lti_link_requests').insert({
    token,
    platform_id: opts.platformId,
    canvas_user_id: opts.canvasUserId,
    email: opts.email,
    display_name: opts.displayName ?? null,
    role: opts.role ?? null,
  });
  if (error) throw new Error(`link request insert failed: ${error.message}`);
  return token;
}

/** Read a pending (unconsumed, unexpired) request — for the page to display. */
export async function readLinkRequest(token: string): Promise<LinkRequest | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('lti_link_requests')
    .select('token, platform_id, canvas_user_id, email, display_name, role, expires_at, consumed_at')
    .eq('token', token)
    .maybeSingle();
  if (!data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  return {
    token: data.token,
    platform_id: data.platform_id,
    canvas_user_id: data.canvas_user_id,
    email: data.email,
    display_name: data.display_name,
    role: data.role,
  };
}

/**
 * Atomically consume a request (single-use, unexpired). Mirrors consumeNonce:
 * the UPDATE only matches an unconsumed, unexpired row, so a double-submit can't
 * consume it twice. Returns the request, or null if already consumed/expired.
 */
export async function consumeLinkRequest(token: string): Promise<LinkRequest | null> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('lti_link_requests')
    .update({ consumed_at: now })
    .eq('token', token)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('token, platform_id, canvas_user_id, email, display_name, role')
    .maybeSingle();
  return (data as LinkRequest | null) ?? null;
}
