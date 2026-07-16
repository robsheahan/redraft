import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../../lib/cors.js';
import { verifyAuth, getSupabase } from '../../lib/auth.js';
import { signDeepLinkingResponse } from '../../lib/lti/jwt.js';
import { getPlatformById } from '../../lib/lti/config.js';
import { captureError } from '../../lib/sentry.js';
import { buildDeepLinkContentItem } from '../../lib/lti/deep-link-content.js';

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://proofready.app';

// Intentionally NOT on lib/with-handler: LTI replies are text/plain + 302
// redirects, not the wrapper's JSON error body. Wrapping would break the
// LTI contract.
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
      .from('tasks').select('id, title, class_id, total_marks')
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

    // Canvas creates the assignment at the task's real points value. Tasks
    // without a numeric total use a one-point completion line item.
    const contentItem = buildDeepLinkContentItem(task, acceptLineItem);

    const responseJwt = await signDeepLinkingResponse({
      issuer: platform.client_id,
      audience: platform.issuer,
      deploymentId: platform.deployment_id,
      nonce: token,
      contentItems: [contentItem],
      dataClaim: data,
    });

    // Only the platform id is known now. The resource_link id is minted by
    // Canvas when the teacher confirms the picker — the first launch of the
    // assignment resolves it via custom.proofready_task_id and self-heals
    // lti_resource_link_id + the AGS line-item URLs (see api/lti/launch.ts).
    // The AGS URLs are cleared too: when a task is RE-deep-linked, a grade
    // posted before the new assignment's first launch must be a no-op rather
    // than land in the OLD assignment's gradebook column.
    await supabase.from('tasks')
      .update({
        lti_platform_id: platform.id,
        lti_resource_link_id: null,
        lti_line_item_url: null,
        lti_ags_lineitems_url: null,
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
