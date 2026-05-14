import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../../lib/cors.js';
import { verifyAuth, getSupabase } from '../../lib/auth.js';
import { signDeepLinkingResponse } from '../../lib/lti/jwt.js';
import { getPlatformById } from '../../lib/lti/config.js';
import { captureError } from '../../lib/sentry.js';

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://proofready.app';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (applyCors(req, res)) return;
  if (req.method === 'GET') return getSessionInfo(req, res);
  if (req.method === 'POST') return submitDeepLink(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function getSessionInfo(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const token = (req.query.token as string || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });

  const supabase = getSupabase();
  const { data: session } = await supabase
    .from('lti_dl_sessions')
    .select('platform_id, class_id, expires_at, user_id')
    .eq('token', token)
    .maybeSingle();

  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (session.user_id !== user.id) return res.status(403).json({ error: 'Session does not belong to this user' });
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'Session expired' });
  }

  let tasks: { id: string; title: string }[] = [];
  if (session.class_id) {
    const { data } = await supabase
      .from('tasks').select('id, title')
      .eq('class_id', session.class_id)
      .order('created_at', { ascending: false });
    tasks = (data || []) as { id: string; title: string }[];
  }
  return res.status(200).json({
    classId: session.class_id,
    tasks,
  });
}

async function submitDeepLink(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { token, taskId } = req.body as { token?: string; taskId?: string };
  if (!token || !taskId) return res.status(400).json({ error: 'token and taskId required' });

  try {
    const supabase = getSupabase();
    const { data: session } = await supabase
      .from('lti_dl_sessions')
      .select('platform_id, user_id, deep_linking_settings, class_id, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== user.id) return res.status(403).json({ error: 'Session does not belong to this user' });
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Session expired' });
    }

    const { data: task } = await supabase
      .from('tasks').select('id, title, class_id')
      .eq('id', taskId).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.class_id !== session.class_id) {
      return res.status(400).json({ error: 'Task is not in the launched class' });
    }

    const platform = await getPlatformById(session.platform_id);
    if (!platform) return res.status(500).json({ error: 'Platform missing' });

    const settings = session.deep_linking_settings as Record<string, unknown>;
    const returnUrl = settings.deep_link_return_url as string;
    const data = settings.data as string | undefined;
    const acceptLineItem = (settings.accept_lineitem === true);

    const resourceLinkId = task.id;
    const contentItem: Record<string, unknown> = {
      type: 'ltiResourceLink',
      url: 'https://api.proofready.app/lti/launch',
      title: task.title,
      custom: { proofready_task_id: task.id },
    };
    if (acceptLineItem) {
      contentItem.lineItem = {
        scoreMaximum: 1,
        label: task.title,
        resourceId: resourceLinkId,
      };
    }

    const responseJwt = await signDeepLinkingResponse({
      issuer: platform.client_id,
      audience: platform.issuer,
      deploymentId: platform.deployment_id,
      nonce: token,
      contentItems: [contentItem],
      dataClaim: data,
    });

    await supabase.from('tasks')
      .update({
        lti_platform_id: platform.id,
        lti_resource_link_id: resourceLinkId,
      })
      .eq('id', task.id);

    await supabase.from('lti_dl_sessions').delete().eq('token', token);

    return res.status(200).json({
      autopost: {
        url: returnUrl,
        fields: { JWT: responseJwt },
      },
    });
  } catch (err) {
    captureError(err, { endpoint: 'lti/deep-link' });
    return res.status(500).json({ error: 'deep link submission failed' });
  }
}
