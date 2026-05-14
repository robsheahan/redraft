import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findPlatform } from '../../lib/lti/config.js';
import { createNonce } from '../../lib/lti/nonce.js';
import { captureError } from '../../lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
      return res.status(400).send('Missing required OIDC initiation params');
    }

    const platform = await findPlatform(iss, clientId, deploymentId);
    if (!platform) {
      return res.status(403).send(`Unknown platform: ${iss} / ${clientId}`);
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
