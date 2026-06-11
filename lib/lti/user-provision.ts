import { getSupabase } from '../auth.js';
import type { ProofReadyRole } from './roles.js';

export type ProvisionResult = {
  userId: string;
  email: string;
  isNew: boolean;
};

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

  let userId: string;
  let isNew = false;

  const { data: existingRows } = await supabase
    .rpc('lti_find_user_by_email', { p_email: opts.email });
  const existing = (existingRows as Array<{ id: string; raw_user_meta_data: Record<string, unknown> | null }> | null)?.[0];

  if (existing) {
    userId = existing.id;
    const meta = existing.raw_user_meta_data || {};
    if (!meta.role) {
      // Authoritative role in app_metadata; user_metadata.role kept as a
      // display mirror (no server gate trusts it).
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { role: opts.role },
        user_metadata: {
          ...meta,
          role: opts.role,
          display_name: (meta.display_name as string) || opts.displayName,
        },
      });
    }
  } else {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: opts.email,
      email_confirm: true,
      app_metadata: { role: opts.role },
      user_metadata: { display_name: opts.displayName, role: opts.role, lti_provisioned: true },
    });
    if (createErr || !created.user) throw new Error(`createUser failed: ${createErr?.message}`);
    userId = created.user.id;
    isNew = true;
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
