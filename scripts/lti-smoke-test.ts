import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const envFile = join(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value.trim();
  }
}

const SITE = process.env.LTI_SMOKE_BASE || 'https://api.proofready.app';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  console.error('Either create a .env.local (e.g. `vercel env pull .env.local`)');
  console.error('or set them inline: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run lti-smoke-test');
  process.exit(1);
}

const { provisionUser, LtiAccountLinkRequiredError } = await import('../lib/lti/user-provision.js');
const { createLinkRequest, readLinkRequest, consumeLinkRequest } = await import('../lib/lti/link.js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Result = { name: string; pass: boolean; details?: string };
const results: Result[] = [];

function check(name: string, pass: boolean, details?: string) {
  results.push({ name, pass, details });
  const sym = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${sym} ${name}${details ? `  \x1b[90m(${details})\x1b[0m` : ''}`);
}

async function main() {
  console.log(`LTI smoke test — base: ${SITE}\n`);

  // 1. JWKS endpoint
  try {
    const res = await fetch(`${SITE}/lti/jwks`);
    const json = await res.json() as { keys?: Array<{ kty?: string; kid?: string }> };
    const key = json.keys?.[0];
    const ok = res.status === 200 && key?.kty === 'RSA' && !!key?.kid;
    check('JWKS endpoint returns valid keys', ok, `kid=${key?.kid?.slice(0, 8) ?? 'missing'}…`);
  } catch (err: any) {
    check('JWKS endpoint returns valid keys', false, err.message);
  }

  // 2. PCS platform row exists
  const { data: platform } = await sb.from('lti_platforms')
    .select('*').eq('client_id', '277420000000000006').maybeSingle();
  check('PCS platform row exists', !!platform,
    platform ? `${platform.school_name} @ ${platform.hostname}` : 'no row');
  if (!platform) return summarise();

  // 3. OIDC initiation: POST /lti/login → 302 to Canvas with state+nonce
  let capturedNonce: string | undefined;
  try {
    const form = new URLSearchParams({
      iss: platform.issuer,
      client_id: platform.client_id,
      login_hint: 'smoke-test-canvas-user',
      target_link_uri: `${SITE}/lti/launch`,
      lti_deployment_id: platform.deployment_id,
    });
    const res = await fetch(`${SITE}/lti/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    const location = res.headers.get('location') || '';
    const url = location ? new URL(location) : null;
    capturedNonce = url?.searchParams.get('nonce') || undefined;
    const state = url?.searchParams.get('state');
    const clientId = url?.searchParams.get('client_id');
    const scope = url?.searchParams.get('scope');
    const ok = res.status === 302
      && url?.host === 'sso.canvaslms.com'
      && clientId === platform.client_id
      && scope === 'openid'
      && !!capturedNonce
      && !!state;
    check('OIDC initiation redirects to Canvas with nonce+state', ok,
      ok ? `→ ${url?.host}, nonce=${capturedNonce?.slice(0, 8)}…` : `status=${res.status}, location=${location.slice(0, 60)}…`);
  } catch (err: any) {
    check('OIDC initiation redirects to Canvas with nonce+state', false, err.message);
  }

  // 4. Nonce persisted with matching platform
  if (capturedNonce) {
    const { data: nonceRow } = await sb.from('lti_nonces')
      .select('platform_id, consumed_at, expires_at').eq('nonce', capturedNonce).maybeSingle();
    const persisted = !!nonceRow;
    const matchesPlatform = nonceRow?.platform_id === platform.id;
    const fresh = nonceRow && new Date(nonceRow.expires_at as string).getTime() > Date.now();
    check('Nonce persisted with matching platform + future expiry',
      !!persisted && !!matchesPlatform && !!fresh,
      persisted ? `platform_match=${matchesPlatform}, expires=${nonceRow?.expires_at}` : 'no row');
    // Clean up the test nonce
    if (nonceRow) await sb.from('lti_nonces').delete().eq('nonce', capturedNonce);
  }

  // 5–8. Existing emails must never auto-link from a Canvas assertion. Verify
  // the current consent flow: provisioning refuses, a short-lived request is
  // readable once, and consuming it is atomic/single-use.
  const testEmail = `smoketest-${Date.now()}@proofready.test`;
  const fakeCanvasId = `smoke-canvas-${Date.now()}`;
  let createdUserId: string | undefined;
  try {
    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email: testEmail,
      email_confirm: true,
      user_metadata: { display_name: 'Smoke Test', role: 'student' },
    });
    if (createErr || !created?.user) throw new Error(createErr?.message || 'createUser returned no user');
    createdUserId = created.user.id;

    let refused = false;
    try {
      await provisionUser({
        platformId: platform.id,
        canvasUserId: fakeCanvasId,
        email: testEmail,
        displayName: 'Smoke Test',
        role: 'student',
      });
    } catch (err) {
      refused = err instanceof LtiAccountLinkRequiredError;
    }
    check('provisionUser refuses automatic linking for an existing email', refused);

    const { data: mappingRow } = await sb.from('lti_user_mappings').select('user_id')
      .eq('platform_id', platform.id).eq('canvas_user_id', fakeCanvasId).maybeSingle();
    check('No identity mapping is created without user consent', !mappingRow);

    const linkToken = await createLinkRequest({
      platformId: platform.id,
      canvasUserId: fakeCanvasId,
      email: testEmail,
      displayName: 'Smoke Test',
      role: 'student',
    });
    const pending = await readLinkRequest(linkToken);
    check('Consent-based link request is readable while pending',
      pending?.email === testEmail && pending?.canvas_user_id === fakeCanvasId);
    const consumed = await consumeLinkRequest(linkToken);
    const replayed = await consumeLinkRequest(linkToken);
    check('Consent link request is atomic and single-use',
      consumed?.email === testEmail && replayed === null);
  } catch (err: any) {
    check('Consent-based account-link smoke test', false, err.message);
  } finally {
    await sb.from('lti_link_requests').delete()
      .eq('platform_id', platform.id).eq('canvas_user_id', fakeCanvasId);
    if (createdUserId) {
      await sb.from('lti_user_mappings').delete()
        .eq('platform_id', platform.id).eq('canvas_user_id', fakeCanvasId);
      await sb.auth.admin.deleteUser(createdUserId);
    }
  }

  summarise();
}

function summarise() {
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  console.log();
  if (fail === 0) {
    console.log(`\x1b[32m${pass} passed, 0 failed.\x1b[0m All checks green.`);
  } else {
    console.log(`\x1b[31m${pass} passed, ${fail} failed.\x1b[0m`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
