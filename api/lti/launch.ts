import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import { findPlatform } from '../../lib/lti/config.js';
import { consumeNonce } from '../../lib/lti/nonce.js';
import { verifyPlatformIdToken } from '../../lib/lti/jwt.js';
import { provisionUser, generateLoginUrl, LtiAccountLinkRequiredError } from '../../lib/lti/user-provision.js';
import { createLinkRequest } from '../../lib/lti/link.js';
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

// Every early 4xx otherwise vanishes into the Canvas iframe with no trace —
// one log line per rejection turns a 5-hour pilot incident into a 5-minute one.
function reject(res: VercelResponse, status: number, message: string, context?: Record<string, unknown>) {
  console.warn('[lti] launch reject', status, message, context ? JSON.stringify(context) : '');
  return res.status(status).send(message);
}

// Intentionally NOT on lib/with-handler: LTI replies are text/plain + 302
// redirects, not the wrapper's JSON error body, and this already has its own
// try/catch + reject logging. Wrapping it would break the LTI contract.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Error paths echo token claims (e.g. the raw email) back in the body.
  // res.send(string) defaults to text/html, which would render those echoes
  // as live HTML on our own origin. Plain text only.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  try {
    const body = req.body as Record<string, string>;
    const idToken = body.id_token;
    const state = body.state;

    if (!idToken || !state) {
      return reject(res, 400, 'Missing id_token or state', { has_id_token: !!idToken, has_state: !!state });
    }

    const unverified = decodeJwt(idToken);
    const issuer = unverified.iss;
    const audience = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
    const deploymentId = unverified[CLAIM_DEPLOYMENT_ID] as string | undefined;
    if (!issuer || !audience || !deploymentId) {
      return reject(res, 400, 'Malformed id_token claims', { iss: issuer, aud: audience, deployment_id: deploymentId });
    }

    const platform = await findPlatform(issuer, audience, deploymentId);
    if (!platform) {
      return reject(res, 403, 'Unknown platform on launch', { iss: issuer, aud: audience, deployment_id: deploymentId });
    }

    const payload = await verifyPlatformIdToken(idToken, {
      issuer: platform.issuer,
      audience: platform.client_id,
      jwksUrl: platform.jwks_url,
    });

    const nonce = payload.nonce as string | undefined;
    if (!nonce) return reject(res, 400, 'Missing nonce in id_token', { platform: platform.id });
    const nonceCheck = await consumeNonce(nonce, state);
    if (!nonceCheck || nonceCheck.platformId !== platform.id) {
      return reject(res, 400, 'Invalid or expired nonce/state', { platform: platform.id });
    }

    const messageType = payload[CLAIM_MESSAGE_TYPE] as string;
    const roles = (payload[CLAIM_ROLES] as string[]) || [];
    const role = roleFromLtiRoles(roles);
    const sub = payload.sub as string;
    const rawEmail = (payload.email as string) || ((payload[CLAIM_CUSTOM] as Record<string, string> | undefined)?.canvas_user_email);
    const email = rawEmail?.trim().toLowerCase();
    const name = (payload.name as string) || (payload.given_name as string) || email || `Canvas user ${sub}`;

    if (!email) {
      return reject(res, 400,
        'Launch is missing the user email. Ask the Canvas admin to set the developer key privacy level to "public", or add Person.email.primary to the custom params.',
        { platform: platform.id, sub },
      );
    }

    // Canvas can send a value in the email claim that isn't a deliverable address
    // (an SIS login id, an internal-only domain with no TLD, etc.). It passes the
    // presence check above but Supabase's createUser rejects it with "Unable to
    // validate email address: invalid format" — turning what should be a handled
    // config issue into a 500. Catch it here and return the same clean 400.
    if (!isValidEmail(email)) {
      return reject(res, 400,
        `Canvas sent "${rawEmail}" as this user's email, which isn't a valid address, so ProofReady can't create their account. Ask the Canvas admin to correct this user's email in Canvas.`,
        { platform: platform.id, sub },
      );
    }

    let userResult;
    try {
      userResult = await provisionUser({
        platformId: platform.id,
        canvasUserId: sub,
        email,
        displayName: name,
        role,
      });
    } catch (e) {
      // The email already belongs to a different account and we won't auto-link
      // (L1). Offer the consent-based link flow instead of a dead end: record a
      // short-lived link request and send the user to the link page, where —
      // signed into that existing account — they can confirm the link.
      if (e instanceof LtiAccountLinkRequiredError) {
        const token = await createLinkRequest({ platformId: platform.id, canvasUserId: sub, email, displayName: name, role });
        console.warn('[lti] launch → account-link required, redirecting to link page', { platform: platform.id, sub });
        return res.redirect(302, `${SITE_ORIGIN}/lti-link.html?token=${encodeURIComponent(token)}`);
      }
      throw e;
    }

    const context = payload[CLAIM_CONTEXT] as { id: string; title?: string } | undefined;
    const resourceLink = payload[CLAIM_RESOURCE_LINK] as { id: string } | undefined;
    const ags = payload[CLAIM_AGS] as { lineitems?: string; lineitem?: string } | undefined;

    if (messageType === 'LtiDeepLinkingRequest') {
      const dlSettings = payload[CLAIM_DL_SETTINGS] as Record<string, unknown> | undefined;
      if (!dlSettings) return reject(res, 400, 'Missing deep linking settings', { platform: platform.id });
      if (role !== 'teacher') return reject(res, 403, 'Only teachers can add ProofReady tasks', { platform: platform.id, roles });

      let classId: string | null = null;
      if (context) {
        const provision = await provisionClass({
          platformId: platform.id,
          canvasCourseId: context.id,
          courseTitle: context.title || 'Untitled course',
          teacherId: userResult.userId,
        });
        classId = provision.classId;
        await rememberCourseLineItems(platform.id, context.id, ags?.lineitems);
        // First-launcher-wins: the course's ProofReady class belongs to whoever
        // launched first. A colleague deep-linking into it would otherwise hit
        // a bare 403 — send them to a page that explains instead.
        if (!provision.isNew && await classOwnedByOther(classId, userResult.userId)) {
          const loginUrl = await generateLoginUrl(email, `${SITE_ORIGIN}/lti-class-owned.html`);
          return res.redirect(302, loginUrl);
        }
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
    let studentAwaitingTeacherSetup = false;
    if (context) {
      if (isTeacher) {
        const provision = await provisionClass({
          platformId: platform.id,
          canvasCourseId: context.id,
          courseTitle: context.title || 'Untitled course',
          teacherId: userResult.userId,
        });
        classId = provision.classId;
        await rememberCourseLineItems(platform.id, context.id, ags?.lineitems);
        // First-launcher-wins: a second teacher launching the same course isn't
        // the class owner and would 403 on class-detail. Land them on a page
        // that explains (co-teaching isn't supported yet) instead of an error.
        if (!provision.isNew && await classOwnedByOther(classId, userResult.userId)) {
          const loginUrl = await generateLoginUrl(email, `${SITE_ORIGIN}/lti-class-owned.html`);
          return res.redirect(302, loginUrl);
        }
        const nrps = payload[CLAIM_NRPS] as { context_memberships_url?: string } | undefined;
        if (nrps?.context_memberships_url) {
          // waitUntil keeps the function alive past the redirect — a plain
          // fire-and-forget promise is frozen/killed once the response is
          // sent on Vercel, silently dropping large roster syncs.
          waitUntil(
            syncRoster({
              platform,
              classId: provision.classId,
              membershipsUrl: nrps.context_memberships_url,
            }).catch(err => captureError(err, { stage: 'roster-sync', platform: platform.id })),
          );
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
        } else {
          studentAwaitingTeacherSetup = true;
        }
      }
    }

    const custom = payload[CLAIM_CUSTOM] as Record<string, string> | undefined;
    const linkedTask = await findOrLinkTask({
      platformId: platform.id,
      resourceLinkId: resourceLink?.id,
      customTaskId: custom?.proofready_task_id,
      classId,
      agsLineItem: ags?.lineitem,
      agsLineItems: ags?.lineitems,
    });

    const target = buildTarget({ isTeacher, classId, task: linkedTask, studentAwaitingTeacherSetup });
    const loginUrl = await generateLoginUrl(email, `${SITE_ORIGIN}${target}`);
    res.redirect(302, loginUrl);
  } catch (err) {
    // A pre-existing account already uses this email and isn't mapped to this
    // Canvas identity. We won't auto-link across that trust boundary (L1) — give
    // the user a clear path instead of a 500.
    if (err instanceof LtiAccountLinkRequiredError) {
      console.warn('[lti] launch reject 409 account-link-required');
      return res.status(409).send(
        'A ProofReady account already uses this email address. Please sign in directly at https://proofready.app with that account. (Linking your Canvas login to an existing account is coming soon — contact support if you need it now.)',
      );
    }
    captureError(err, { endpoint: 'lti/launch' });
    res.status(500).send('LTI launch error');
  }
}

async function rememberCourseLineItems(platformId: string, canvasCourseId: string, url?: string): Promise<void> {
  if (!url) return;
  const supabase = getSupabase();
  const { error } = await supabase.from('lti_course_mappings')
    .update({ lti_lineitems_url: url })
    .eq('platform_id', platformId)
    .eq('canvas_course_id', canvasCourseId);
  if (error) captureError(error, { stage: 'lti-course-lineitems-save', platform: platformId });
}

// Mirrors the cases Supabase/GoTrue rejects: requires a single @, no whitespace,
// and a dotted domain (so an internal-only "user@school" or "sis-login-id" fails
// here rather than blowing up in createUser).
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// True when the class exists and belongs to a different teacher. Fails open
// (false) on a read error so a transient DB hiccup can't lock the owner out.
async function classOwnedByOther(classId: string, userId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase.from('classes').select('teacher_id').eq('id', classId).maybeSingle();
  return !!data?.teacher_id && data.teacher_id !== userId;
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

interface LinkedTask {
  id: string;
  subject_type?: string | null;
}

async function findOrLinkTask(opts: {
  platformId: string;
  resourceLinkId?: string;
  customTaskId?: string;
  classId: string | null;
  agsLineItem?: string;
  agsLineItems?: string;
}): Promise<LinkedTask | null> {
  if (!opts.resourceLinkId) return null;
  const supabase = getSupabase();

  // AGS-created Canvas assignments are known to ProofReady by their line-item
  // URL before Canvas mints/returns the resource-link id on first launch.
  if (opts.agsLineItem) {
    const { data: byLineItem } = await supabase
      .from('tasks')
      .select('id, subject_type')
      .eq('lti_platform_id', opts.platformId)
      .eq('lti_line_item_url', opts.agsLineItem)
      .maybeSingle();
    if (byLineItem?.id) {
      await supabase.from('tasks').update({
        lti_resource_link_id: opts.resourceLinkId,
        lti_ags_lineitems_url: opts.agsLineItems ?? null,
      }).eq('id', byLineItem.id);
      return byLineItem as LinkedTask;
    }
  }

  const { data: existing } = await supabase
    .from('tasks')
    .select('id, subject_type')
    .eq('lti_platform_id', opts.platformId)
    .eq('lti_resource_link_id', opts.resourceLinkId)
    .maybeSingle();
  if (existing?.id) {
    if (opts.agsLineItem) {
      await supabase.from('tasks')
        .update({ lti_line_item_url: opts.agsLineItem, lti_ags_lineitems_url: opts.agsLineItems })
        .eq('id', existing.id);
    }
    return existing as LinkedTask;
  }

  // First launch of a deep-linked assignment. At deep-link time we don't know
  // the resource_link id Canvas will mint for the assignment — the join key we
  // control is the custom claim (custom.proofready_task_id), which Canvas echoes
  // back on every launch of that content item. Resolve via the custom claim once,
  // verify the task really belongs to this platform + course, then self-heal the
  // task with the actual resource_link id + AGS line-item URLs so subsequent
  // launches take the fast path above and grade passback has its endpoint.
  if (opts.customTaskId && opts.classId) {
    const { data: task } = await supabase
      .from('tasks')
      .select('id, class_id, lti_platform_id, subject_type')
      .eq('id', opts.customTaskId)
      .maybeSingle();
    if (
      task?.id &&
      task.lti_platform_id === opts.platformId &&
      task.class_id === opts.classId
    ) {
      const { error } = await supabase.from('tasks')
        .update({
          lti_resource_link_id: opts.resourceLinkId,
          lti_line_item_url: opts.agsLineItem ?? null,
          lti_ags_lineitems_url: opts.agsLineItems ?? null,
        })
        .eq('id', task.id);
      if (error) {
        captureError(new Error(`lti task self-heal failed: ${error.message}`), { task: task.id });
      } else {
        console.log('[lti] linked deep-linked task to resource link', { task: task.id });
      }
      return task as LinkedTask;
    }
    console.warn('[lti] custom proofready_task_id did not verify against platform/class', {
      task: opts.customTaskId, platform: opts.platformId, class: opts.classId,
    });
  }
  return null;
}

function buildTarget(opts: {
  isTeacher: boolean;
  classId: string | null;
  task: LinkedTask | null;
  studentAwaitingTeacherSetup?: boolean;
}): string {
  if (opts.task) {
    const studentPage = opts.task.subject_type === 'maths' ? 'submit-maths.html' : 'submit.html';
    return opts.isTeacher
      ? `/task-detail.html?id=${opts.task.id}`
      : `/${studentPage}?task=${opts.task.id}`;
  }
  if (opts.classId) {
    return opts.isTeacher
      ? `/class-detail.html?id=${opts.classId}`
      : `/class-view.html?id=${opts.classId}`;
  }
  if (opts.studentAwaitingTeacherSetup) return '/lti-not-ready.html';
  return opts.isTeacher ? '/teacher.html' : '/student.html';
}
