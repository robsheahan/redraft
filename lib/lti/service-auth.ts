import { signClientAssertion } from './jwt.js';
import type { LtiPlatform } from './config.js';

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getServiceAccessToken(platform: LtiPlatform, scopes: string[]): Promise<string> {
  const cacheKey = `${platform.id}|${scopes.sort().join(' ')}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const clientAssertion = await signClientAssertion({
    audience: platform.auth_token_url,
    clientId: platform.client_id,
  });

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion,
    scope: scopes.join(' '),
  });

  const res = await fetch(platform.auth_token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${text}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in * 1000),
  });
  return json.access_token;
}

export const SCOPE_NRPS = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
export const SCOPE_AGS_LINEITEM = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
export const SCOPE_AGS_SCORE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
export const SCOPE_AGS_RESULT = 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly';
