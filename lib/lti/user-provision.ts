import { getSupabase } from '../auth.js';
import type { ProofReadyRole } from './roles.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ProvisionResult = {
  userId: string;
  email: string;
  isNew: boolean;
};

/**
 * Thrown when a launch's email already belongs to a ProofReady account that is
 * NOT mapped to this (platform, canvas_user_id). We refuse to auto-link — a
 * platform-asserted email is not proof of identity (audit L1) — and the launch
 * handler turns this into a clean message rather than a 500.
 */
export class LtiAccountLinkRequiredError extends Error {
  constructor(public readonly email: string) {
    super(`An existing ProofReady account already uses ${email}`);
    this.name = 'LtiAccountLinkRequiredError';
  }
}

// Supabase/GoTrue signals a duplicate email a few ways depending on version.
function isEmailExistsError(err: { message?: string; code?: string; status?: number } | null): boolean {
  if (!err) return false;
  if (err.code === 'email_exists') return true;
  return /already.*registered|already.*been registered|email.*exists/i.test(err.message || '');
}

// A concurrent launch of the SAME (platform, canvas_user_id) may still be
// inserting its mapping when we lose the createUser race. Re-read a few times
// before concluding the email belongs to a genuinely different account.
async function waitForMapping(
  supabase: SupabaseClient,
  platformId: string,
  canvasUserId: string,
): Promise<{ user_id: string; email: string | null } | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data } = await supabase
      .from('lti_user_mappings')
      .select('user_id, email')
      .eq('platform_id', platformId)
      .eq('canvas_user_id', canvasUserId)
      .maybeSingle();
    if (data?.user_id) return data as { user_id: string; email: string | null };
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function provisionUser(opts: {
  platformId: string;
  canvasUserId: string;
  email: string;
  displayName: string;
  role: ProofReadyRole;
}): Promise<ProvisionResult> {
  const supabase = getSupabase();

  const { data: mapping } = await supabase
    .from('lti_user_mappings')
    .select('user_id, email')
    .eq('platform_id', opts.platformId)
    .eq('canvas_user_id', opts.canvasUserId)
    .maybeSingle();

  if (mapping?.user_id) {
    await supabase.from('lti_user_mappings')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('platform_id', opts.platformId)
      .eq('canvas_user_id', opts.canvasUserId);
    return { userId: mapping.user_id, email: mapping.email ?? opts.email, isNew: false };
  }

  // Identity is keyed strictly on (platform, canvas_user_id) — never on a
  // platform-asserted email (audit L1/Q2B). With no mapping, provision a fresh
  // account; we do NOT look the email up and attach to a pre-existing account.
  let userId: string;
  let isNew = false;

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: opts.email,
    email_confirm: true,
    app_metadata: { role: opts.role },
    user_metadata: { display_name: opts.displayName, role: opts.role, lti_provisioned: true },
  });

  if (created?.user) {
    userId = created.user.id;
    isNew = true;
  } else if (isEmailExistsError(createErr)) {
    // Email already registered. Either (a) a concurrent launch of THIS same
    // (platform, canvas_user_id) just created it — converge on the mapping it's
    // inserting; or (b) the email belongs to a different, pre-existing account
    // (self-signup / another platform) — refuse to auto-link (L1) and surface a
    // clean "link required" error.
    const raced = await waitForMapping(supabase, opts.platformId, opts.canvasUserId);
    if (raced?.user_id) {
      return { userId: raced.user_id, email: raced.email ?? opts.email, isNew: false };
    }
    throw new LtiAccountLinkRequiredError(opts.email);
  } else {
    throw new Error(`createUser failed: ${createErr?.message}`);
  }

  const { error: mapErr } = await supabase.from('lti_user_mappings').insert({
    platform_id: opts.platformId,
    canvas_user_id: opts.canvasUserId,
    user_id: userId,
    email: opts.email,
  });
  if (mapErr) {
    // Canvas can fire the same launch twice (double-click, prefetch, retry),
    // so two requests race past the lookup above and both try to insert. The
    // unique constraint on (platform_id, canvas_user_id) lets the first win;
    // the loser gets 23505. That's not a failure — the mapping exists now, so
    // re-read it and converge on the winning row instead of failing the launch.
    if ((mapErr as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('lti_user_mappings')
        .select('user_id, email')
        .eq('platform_id', opts.platformId)
        .eq('canvas_user_id', opts.canvasUserId)
        .maybeSingle();
      if (raced?.user_id) {
        return { userId: raced.user_id, email: raced.email ?? opts.email, isNew: false };
      }
    }
    throw new Error(`mapping insert failed: ${mapErr.message}`);
  }

  return { userId, email: opts.email, isNew };
}

export async function generateLoginUrl(email: string, redirectTo: string): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });
  if (error || !data.properties?.action_link) {
    throw new Error(`generateLink failed: ${error?.message ?? 'no action_link'}`);
  }
  return data.properties.action_link;
}
