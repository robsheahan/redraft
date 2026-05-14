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
  const { data, error } = await supabase
    .from('lti_nonces')
    .select('platform_id, expires_at, consumed_at, state')
    .eq('nonce', nonce)
    .maybeSingle();
  if (error || !data) return null;
  if (data.consumed_at) return null;
  if (data.state !== state) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  const { error: updateError } = await supabase
    .from('lti_nonces').update({ consumed_at: new Date().toISOString() }).eq('nonce', nonce);
  if (updateError) return null;
  return { platformId: data.platform_id };
}
