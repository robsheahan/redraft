import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findPlatform } from '../../lib/lti/config.js';
import { createNonce } from '../../lib/lti/nonce.js';
import { captureError } from '../../lib/sentry.js';

// Every early 4xx otherwise vanishes into the Canvas iframe with no trace —
// one log line per rejection is the difference between a 5-minute and a
// 5-hour pilot incident.
function reject(res: VercelResponse, status: number, message: string, context?: Record<string, unknown>) {
  console.warn('[lti] login reject', status, message, context ? JSON.stringify(context) : '');
  return res.status(status).send(message);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Error paths echo request params (iss/client_id) back in the body. Without
  // an explicit type, res.send(string) defaults to text/html — which would
  // turn those echoes into reflected HTML on our own origin. Plain text only.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  try {
    const params = req.method === 'POST'
      ? (req.body as Record<string, string>)
      : (req.query as Record<string, string>);

    const iss = params.iss;
    const clientId = params.client_id;
    const loginHint = params.login_hint;
    const targetLinkUri = params.target_link_uri;
    const ltiMessageHint = params.lti_message_hint;
    const deploymentId = params.lti_deployment_id;

    if (!iss || !clientId || !loginHint || !targetLinkUri) {
      return reject(res, 400, 'Missing required OIDC initiation params', {
        has_iss: !!iss, has_client_id: !!clientId, has_login_hint: !!loginHint, has_target_link_uri: !!targetLinkUri,
      });
    }

    // target_link_uri becomes the OAuth redirect_uri. Without this check an
    // attacker-crafted initiation link turns the platform's auth endpoint into
    // an open redirect carrying a signed id_token to a host we don't control.
    if (!isAllowedTargetLinkUri(targetLinkUri, req.headers.host)) {
      return reject(res, 400, 'target_link_uri is not a recognised ProofReady launch URL', { target_link_uri: targetLinkUri });
    }

    const platform = await findPlatform(iss, clientId, deploymentId);
    if (!platform) {
      return reject(res, 403, `Unknown platform: ${iss} / ${clientId}`, { iss, client_id: clientId, deployment_id: deploymentId });
    }

    const { nonce, state } = await createNonce(platform.id);

    const redirect = new URL(platform.auth_login_url);
    redirect.searchParams.set('scope', 'openid');
    redirect.searchParams.set('response_type', 'id_token');
    redirect.searchParams.set('response_mode', 'form_post');
    redirect.searchParams.set('prompt', 'none');
    redirect.searchParams.set('client_id', clientId);
    redirect.searchParams.set('redirect_uri', targetLinkUri);
    redirect.searchParams.set('login_hint', loginHint);
    redirect.searchParams.set('state', state);
    redirect.searchParams.set('nonce', nonce);
    if (ltiMessageHint) redirect.searchParams.set('lti_message_hint', ltiMessageHint);

    res.redirect(302, redirect.toString());
  } catch (err) {
    captureError(err, { endpoint: 'lti/login' });
    res.status(500).send('LTI login error');
  }
}

// Allowlist: https, a ProofReady host (prod, subdomains incl. api., or the
// host serving this request — keeps Vercel previews working), and one of the
// registered LTI message paths (with or without the /api rewrite prefix).
const ALLOWED_LTI_PATHS = new Set(['/lti/launch', '/lti/deep-link', '/api/lti/launch', '/api/lti/deep-link']);
function isAllowedTargetLinkUri(uri: string, requestHost: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const hostOk = url.host === 'proofready.app'
    || url.host.endsWith('.proofready.app')
    || (!!requestHost && url.host === requestHost);
  if (!hostOk) return false;
  return ALLOWED_LTI_PATHS.has(url.pathname);
}
