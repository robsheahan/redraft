import type { VercelRequest, VercelResponse } from '@vercel/node';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import { findPlatform } from '../../lib/lti/config.js';
import { consumeNonce } from '../../lib/lti/nonce.js';
import { verifyPlatformIdToken } from '../../lib/lti/jwt.js';
import { provisionUser, generateLoginUrl } from '../../lib/lti/user-provision.js';
import { provisionClass, enrolStudent } from '../../lib/lti/course-provision.js';
import { roleFromLtiRoles } from '../../lib/lti/roles.js';
import { syncRoster } from '../../lib/lti/nrps.js';
import { getSupabase } from '../../lib/auth.js';
import { captureError } from '../../lib/sentry.js';

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://proofready.app';

const CLAIM_MESSAGE_TYPE = 'https://purl.imsglobal.org/spec/lti/claim/message_type';
const CLAIM_DEPLOYMENT_ID = 'https://purl.imsglobal.org/spec/lti/claim/deployment_id';
const CLAIM_ROLES = 'https://purl.imsglobal.org/spec/lti/claim/roles';
const CLAIM_CONTEXT = 'https://purl.imsglobal.org/spec/lti/claim/context';
const CLAIM_RESOURCE_LINK = 'https://purl.imsglobal.org/spec/lti/claim/resource_link';
const CLAIM_CUSTOM = 'https://purl.imsglobal.org/spec/lti/claim/custom';
const CLAIM_NRPS = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const CLAIM_AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
const CLAIM_DL_SETTINGS = 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const body = req.body as Record<string, string>;
    const idToken = body.id_token;
    const state = body.state;

    if (!idToken || !state) {
      return res.status(400).send('Missing id_token or state');
    }

    const unverified = decodeJwt(idToken);
    const issuer = unverified.iss;
    const audience = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
    const deploymentId = unverified[CLAIM_DEPLOYMENT_ID] as string | undefined;
    if (!issuer || !audience || !deploymentId) {
      return res.status(400).send('Malformed id_token claims');
    }

    const platform = await findPlatform(issuer, audience, deploymentId);
    if (!platform) {
      return res.status(403).send('Unknown platform on launch');
    }

    const payload = await verifyPlatformIdToken(idToken, {
      issuer: platform.issuer,
      audience: platform.client_id,
      jwksUrl: platform.jwks_url,
    });

    const nonce = payload.nonce as string | undefined;
    if (!nonce) return res.status(400).send('Missing nonce in id_token');
    const nonceCheck = await consumeNonce(nonce, state);
    if (!nonceCheck || nonceCheck.platformId !== platform.id) {
      return res.status(400).send('Invalid or expired nonce/state');
    }

    const messageType = payload[CLAIM_MESSAGE_TYPE] as string;
    const roles = (payload[CLAIM_ROLES] as string[]) || [];
    const role = roleFromLtiRoles(roles);
    const sub = payload.sub as string;
    const email = (payload.email as string) || ((payload[CLAIM_CUSTOM] as Record<string, string> | undefined)?.canvas_user_email);
    const name = (payload.name as string) || (payload.given_name as string) || email || `Canvas user ${sub}`;

    if (!email) {
      return res.status(400).send(
        'Launch is missing the user email. Ask the Canvas admin to set the developer key privacy level to "public", or add Person.email.primary to the custom params.',
      );
    }

    const userResult = await provisionUser({
      platformId: platform.id,
      canvasUserId: sub,
      email,
      displayName: name,
      role,
    });

    const context = payload[CLAIM_CONTEXT] as { id: string; title?: string } | undefined;
    const resourceLink = payload[CLAIM_RESOURCE_LINK] as { id: string } | undefined;

    if (messageType === 'LtiDeepLinkingRequest') {
      const dlSettings = payload[CLAIM_DL_SETTINGS] as Record<string, unknown> | undefined;
      if (!dlSettings) return res.status(400).send('Missing deep linking settings');
      if (role !== 'teacher') return res.status(403).send('Only teachers can add ProofReady tasks');

      let classId: string | null = null;
      if (context) {
        const provision = await provisionClass({
          platformId: platform.id,
          canvasCourseId: context.id,
          courseTitle: context.title || 'Untitled course',
          teacherId: userResult.userId,
        });
        classId = provision.classId;
      }

      const dlToken = await persistDeepLinkContext({
        platformId: platform.id,
        userId: userResult.userId,
        classId,
        deepLinkingSettings: dlSettings,
      });

      const redirectTo = `${SITE_ORIGIN}/lti-deep-link.html?token=${encodeURIComponent(dlToken)}`;
      const loginUrl = await generateLoginUrl(email, redirectTo);
      return res.redirect(302, loginUrl);
    }

    let classId: string | null = null;
    let isTeacher = role === 'teacher';
    if (context) {
      if (isTeacher) {
        const provision = await provisionClass({
          platformId: platform.id,
          canvasCourseId: context.id,
          courseTitle: context.title || 'Untitled course',
          teacherId: userResult.userId,
        });
        classId = provision.classId;
        const nrps = payload[CLAIM_NRPS] as { context_memberships_url?: string } | undefined;
        if (nrps?.context_memberships_url) {
          syncRoster({
            platform,
            classId: provision.classId,
            membershipsUrl: nrps.context_memberships_url,
          }).catch(err => captureError(err, { stage: 'roster-sync', platform: platform.id }));
        }
      } else {
        const supabase = getSupabase();
        const { data: mapping } = await supabase
          .from('lti_course_mappings').select('class_id')
          .eq('platform_id', platform.id)
          .eq('canvas_course_id', context.id)
          .maybeSingle();
        if (mapping?.class_id) {
          classId = mapping.class_id as string;
          await enrolStudent(classId, userResult.userId);
        }
      }
    }

    const ags = payload[CLAIM_AGS] as { lineitems?: string; lineitem?: string } | undefined;
    const linkedTaskId = await findOrLinkTask({
      platformId: platform.id,
      resourceLinkId: resourceLink?.id,
      classId,
      agsLineItem: ags?.lineitem,
      agsLineItems: ags?.lineitems,
    });

    const target = buildTarget({ isTeacher, classId, taskId: linkedTaskId });
    const loginUrl = await generateLoginUrl(email, `${SITE_ORIGIN}${target}`);
    res.redirect(302, loginUrl);
  } catch (err) {
    captureError(err, { endpoint: 'lti/launch' });
    res.status(500).send('LTI launch error');
  }
}

async function persistDeepLinkContext(opts: {
  platformId: string;
  userId: string;
  classId: string | null;
  deepLinkingSettings: Record<string, unknown>;
}): Promise<string> {
  const supabase = getSupabase();
  const token = randomUUID();
  const { error } = await supabase.from('lti_dl_sessions').insert({
    token,
    platform_id: opts.platformId,
    user_id: opts.userId,
    class_id: opts.classId,
    deep_linking_settings: opts.deepLinkingSettings,
  });
  if (error) throw new Error(`deep link session insert failed: ${error.message}`);
  return token;
}

async function findOrLinkTask(opts: {
  platformId: string;
  resourceLinkId?: string;
  classId: string | null;
  agsLineItem?: string;
  agsLineItems?: string;
}): Promise<string | null> {
  if (!opts.resourceLinkId) return null;
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('tasks')
    .select('id')
    .eq('lti_platform_id', opts.platformId)
    .eq('lti_resource_link_id', opts.resourceLinkId)
    .maybeSingle();
  if (existing?.id) {
    if (opts.agsLineItem) {
      await supabase.from('tasks')
        .update({ lti_line_item_url: opts.agsLineItem, lti_ags_lineitems_url: opts.agsLineItems })
        .eq('id', existing.id);
    }
    return existing.id as string;
  }
  return null;
}

function buildTarget(opts: {
  isTeacher: boolean;
  classId: string | null;
  taskId: string | null;
}): string {
  if (opts.taskId) {
    return opts.isTeacher
      ? `/task-detail.html?task_id=${opts.taskId}`
      : `/submit.html?task_id=${opts.taskId}`;
  }
  if (opts.classId) {
    return opts.isTeacher
      ? `/class-detail.html?class_id=${opts.classId}`
      : `/class-view.html?class_id=${opts.classId}`;
  }
  return opts.isTeacher ? '/teacher.html' : '/student.html';
}
