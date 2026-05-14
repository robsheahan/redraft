import { getServiceAccessToken, SCOPE_NRPS } from './service-auth.js';
import { provisionUser } from './user-provision.js';
import { enrolStudent } from './course-provision.js';
import type { LtiPlatform } from './config.js';
import { roleFromLtiRoles } from './roles.js';

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
}): Promise<{ enrolled: number; skippedNoEmail: number }> {
  const token = await getServiceAccessToken(opts.platform, [SCOPE_NRPS]);

  let next: string | null = opts.membershipsUrl;
  let enrolled = 0;
  let skippedNoEmail = 0;

  while (next) {
    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
      },
    });
    if (!res.ok) throw new Error(`NRPS fetch failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { members: NrpsMember[] };

    for (const m of body.members) {
      if (m.status !== 'Active') continue;
      if (!m.email) { skippedNoEmail++; continue; }
      const role = roleFromLtiRoles(m.roles);
      if (role !== 'student') continue;

      const displayName = m.name || [m.given_name, m.family_name].filter(Boolean).join(' ') || m.email;
      const provision = await provisionUser({
        platformId: opts.platform.id,
        canvasUserId: m.user_id,
        email: m.email,
        displayName,
        role: 'student',
      });
      await enrolStudent(opts.classId, provision.userId);
      enrolled++;
    }

    const link = res.headers.get('Link');
    next = parseNextLink(link);
  }

  return { enrolled, skippedNoEmail };
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
