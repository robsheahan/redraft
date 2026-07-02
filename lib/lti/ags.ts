import { getServiceAccessToken, SCOPE_AGS_SCORE } from './service-auth.js';
import type { LtiPlatform } from './config.js';
import { getSupabase } from '../auth.js';
import { getPlatformById } from './config.js';

/**
 * Post an AGS score message to the line item's /scores endpoint.
 *
 * Two modes, chosen by whether an explicit score is supplied:
 * - No score (scoreGiven undefined): posts a submission-only update —
 *   `activityProgress: 'Submitted'`, `gradingProgress: 'Pending'`, and NO
 *   scoreGiven/scoreMaximum fields at all. Used by the feedback endpoints on
 *   each draft; must never record a numeric grade in the Canvas gradebook.
 * - Explicit score (scoreGiven + scoreMaximum both numbers): posts the real
 *   grade — `activityProgress: 'Completed'`, `gradingProgress: 'FullyGraded'`
 *   with the supplied values. Used by teacher grading (api/submission-grade.ts).
 *
 * Passing scoreGiven without scoreMaximum is a programming error and throws
 * (the AGS spec requires scoreMaximum whenever scoreGiven is present, and
 * defaulting it could silently mis-scale a grade).
 */
export async function postCompletionScore(opts: {
  platform: LtiPlatform;
  lineItemUrl: string;
  canvasUserId: string;
  scoreGiven?: number;
  scoreMaximum?: number;
  comment?: string;
}): Promise<void> {
  const hasScore = opts.scoreGiven !== undefined && opts.scoreGiven !== null;
  if (hasScore && (opts.scoreMaximum === undefined || opts.scoreMaximum === null)) {
    throw new Error('AGS score post: scoreGiven supplied without scoreMaximum');
  }

  const token = await getServiceAccessToken(opts.platform, [SCOPE_AGS_SCORE]);
  const scoresUrl = buildScoresUrl(opts.lineItemUrl);
  const res = await fetch(scoresUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.ims.lis.v1.score+json',
    },
    body: JSON.stringify({
      userId: opts.canvasUserId,
      ...(hasScore
        ? {
            scoreGiven: opts.scoreGiven,
            scoreMaximum: opts.scoreMaximum,
            activityProgress: 'Completed',
            gradingProgress: 'FullyGraded',
          }
        : {
            activityProgress: 'Submitted',
            gradingProgress: 'Pending',
          }),
      timestamp: new Date().toISOString(),
      ...(opts.comment ? { comment: opts.comment } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AGS score post failed: ${res.status} ${await res.text()}`);
}

/**
 * The AGS scores endpoint is the line item URL with `/scores` appended to the
 * PATH. Canvas line item URLs have no query string, but Moodle's carry one
 * (`.../lineitem?type_id=123`) — naive `${url}/scores` would produce
 * `...?type_id=123/scores`. Insert `/scores` before the query string.
 */
function buildScoresUrl(lineItemUrl: string): string {
  const queryIndex = lineItemUrl.indexOf('?');
  if (queryIndex === -1) return `${lineItemUrl}/scores`;
  const path = lineItemUrl.slice(0, queryIndex);
  const query = lineItemUrl.slice(queryIndex);
  return `${path}/scores${query}`;
}

export async function postCompletionIfLinked(opts: {
  taskId: string;
  studentId: string;
  comment?: string;
  scoreGiven?: number;
  scoreMaximum?: number;
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
    scoreGiven: opts.scoreGiven,
    scoreMaximum: opts.scoreMaximum,
  });
  return { posted: true };
}
