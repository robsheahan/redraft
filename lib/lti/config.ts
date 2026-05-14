import { getSupabase } from '../auth.js';

export type LtiPlatform = {
  id: string;
  school_name: string;
  issuer: string;
  client_id: string;
  deployment_id: string;
  hostname: string;
  jwks_url: string;
  auth_login_url: string;
  auth_token_url: string;
};

export async function findPlatform(
  issuer: string,
  clientId: string,
  deploymentId?: string,
): Promise<LtiPlatform | null> {
  const supabase = getSupabase();
  let query = supabase
    .from('lti_platforms')
    .select('*')
    .eq('issuer', issuer)
    .eq('client_id', clientId);
  if (deploymentId) query = query.eq('deployment_id', deploymentId);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`platform lookup failed: ${error.message}`);
  return data as LtiPlatform | null;
}

export async function getPlatformById(id: string): Promise<LtiPlatform | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('lti_platforms').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`platform lookup failed: ${error.message}`);
  return data as LtiPlatform | null;
}
