import { randomUUID } from 'node:crypto';
import { getSupabase } from '../auth.js';

export async function createNonce(platformId: string): Promise<{ nonce: string; state: string }> {
  const nonce = randomUUID();
  const state = randomUUID();
  const supabase = getSupabase();
  const { error } = await supabase.from('lti_nonces').insert({
    nonce, state, platform_id: platformId,
  });
  if (error) throw new Error(`nonce insert failed: ${error.message}`);
  return { nonce, state };
}

export async function consumeNonce(nonce: string, state: string): Promise<{ platformId: string } | null> {
  const supabase = getSupabase();
  // Atomic consume: the UPDATE only matches an unconsumed, unexpired row, so
  // of two concurrent replays exactly one gets the row back (compare-and-set —
  // the old read-then-write version was racy).
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('lti_nonces')
    .update({ consumed_at: now })
    .eq('nonce', nonce)
    .eq('state', state)
    .is('consumed_at', null)
    .gt('expires_at', now)
    .select('platform_id')
    .maybeSingle();
  if (error || !data) return null;

  // Opportunistic purge: rows expired more than a day ago serve no replay-
  // protection purpose. Best-effort — a failure must not block the launch.
  await supabase.from('lti_nonces').delete().lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  return { platformId: data.platform_id };
}
