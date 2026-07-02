import { getServiceAccessToken, SCOPE_NRPS } from './service-auth.js';
import { provisionUser, LtiAccountLinkRequiredError } from './user-provision.js';
import { enrolStudent } from './course-provision.js';
import type { LtiPlatform } from './config.js';
import { roleFromLtiRoles } from './roles.js';
import { captureError } from '../sentry.js';

type NrpsMember = {
  status: 'Active' | 'Inactive';
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  user_id: string;
  roles: string[];
};

export async function syncRoster(opts: {
  platform: LtiPlatform;
  classId: string;
  membershipsUrl: string;
}): Promise<{ enrolled: number; skippedNoEmail: number; skippedErrors: number }> {
  const token = await getServiceAccessToken(opts.platform, [SCOPE_NRPS]);

  let next: string | null = opts.membershipsUrl;
  let enrolled = 0;
  let skippedNoEmail = 0;
  let skippedErrors = 0;

  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
      },
    });
    if (!res.ok) throw new Error(`NRPS fetch failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { members?: NrpsMember[] };
    const members = body.members ?? [];

    for (const m of members) {
      if (m.status !== 'Active') continue;
      if (!m.email) { skippedNoEmail++; continue; }
      const role = roleFromLtiRoles(m.roles);
      if (role !== 'student') continue;

      const displayName = m.name || [m.given_name, m.family_name].filter(Boolean).join(' ') || m.email;
      // One problematic member (e.g. an email already owned by a pre-existing
      // self-signup account → LtiAccountLinkRequiredError) must not abort the
      // whole sync — skip them and keep provisioning the rest of the roster.
      try {
        const provision = await provisionUser({
          platformId: opts.platform.id,
          canvasUserId: m.user_id,
          email: m.email,
          displayName,
          role: 'student',
        });
        await enrolStudent(opts.classId, provision.userId);
        enrolled++;
      } catch (err) {
        skippedErrors++;
        if (err instanceof LtiAccountLinkRequiredError) {
          // Expected case: the student must link their existing account via
          // their own launch. Not a defect — warn, don't page.
          console.warn('[lti] roster sync: member skipped, account link required', {
            platform: opts.platform.id,
            canvas_user_id: m.user_id,
            class_id: opts.classId,
          });
        } else {
          captureError(err, {
            stage: 'roster-sync-member',
            platform: opts.platform.id,
            canvas_user_id: m.user_id,
            class_id: opts.classId,
          });
        }
      }
    }

    const link = res.headers.get('Link');
    next = parseNextLink(link);
  }

  const summary = { enrolled, skippedNoEmail, skippedErrors, classId: opts.classId, platform: opts.platform.id };
  console.log('[lti] roster sync summary', JSON.stringify(summary));
  if (skippedErrors > 0) {
    // Surface partial rosters in Sentry — otherwise the teacher just sees a
    // partially-populated class with no server-side trace of who was skipped.
    captureError(new Error(`roster sync completed with ${skippedErrors} skipped member(s)`), {
      stage: 'roster-sync-summary',
      ...summary,
    });
  }

  return { enrolled, skippedNoEmail, skippedErrors };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const p of parts) {
    const match = p.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}
