import { getServiceAccessToken, SCOPE_AGS_LINEITEM, SCOPE_AGS_SCORE } from './service-auth.js';
import type { LtiPlatform } from './config.js';
import { getSupabase } from '../auth.js';
import { getPlatformById } from './config.js';

export async function createLineItem(opts: {
  platform: LtiPlatform;
  lineItemsUrl: string;
  resourceLinkId: string;
  label: string;
  scoreMaximum?: number;
}): Promise<string> {
  const token = await getServiceAccessToken(opts.platform, [SCOPE_AGS_LINEITEM]);
  const res = await fetch(opts.lineItemsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.ims.lis.v2.lineitem+json',
      Accept: 'application/vnd.ims.lis.v2.lineitem+json',
    },
    body: JSON.stringify({
      scoreMaximum: opts.scoreMaximum ?? 1,
      label: opts.label,
      resourceLinkId: opts.resourceLinkId,
    }),
  });
  if (!res.ok) throw new Error(`AGS line item create failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { id: string };
  return json.id;
}

export async function postCompletionScore(opts: {
  platform: LtiPlatform;
  lineItemUrl: string;
  canvasUserId: string;
  scoreGiven?: number;
  scoreMaximum?: number;
  comment?: string;
}): Promise<void> {
  const token = await getServiceAccessToken(opts.platform, [SCOPE_AGS_SCORE]);
  const scoresUrl = `${opts.lineItemUrl}/scores`;
  const res = await fetch(scoresUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.ims.lis.v1.score+json',
    },
    body: JSON.stringify({
      userId: opts.canvasUserId,
      scoreGiven: opts.scoreGiven ?? 1,
      scoreMaximum: opts.scoreMaximum ?? 1,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      timestamp: new Date().toISOString(),
      ...(opts.comment ? { comment: opts.comment } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AGS score post failed: ${res.status} ${await res.text()}`);
}

export async function postCompletionIfLinked(opts: {
  taskId: string;
  studentId: string;
  comment?: string;
}): Promise<{ posted: boolean; reason?: string }> {
  const supabase = getSupabase();

  const { data: task } = await supabase
    .from('tasks')
    .select('lti_platform_id, lti_line_item_url, lti_resource_link_id')
    .eq('id', opts.taskId)
    .maybeSingle();
  if (!task?.lti_platform_id || !task.lti_line_item_url) {
    return { posted: false, reason: 'task not linked to Canvas' };
  }

  const { data: mapping } = await supabase
    .from('lti_user_mappings')
    .select('canvas_user_id')
    .eq('platform_id', task.lti_platform_id)
    .eq('user_id', opts.studentId)
    .maybeSingle();
  if (!mapping?.canvas_user_id) {
    return { posted: false, reason: 'no LTI mapping for student' };
  }

  const platform = await getPlatformById(task.lti_platform_id as string);
  if (!platform) return { posted: false, reason: 'platform missing' };

  await postCompletionScore({
    platform,
    lineItemUrl: task.lti_line_item_url as string,
    canvasUserId: mapping.canvas_user_id as string,
    comment: opts.comment,
  });
  return { posted: true };
}
