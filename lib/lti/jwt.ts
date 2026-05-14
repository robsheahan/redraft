import { importPKCS8, exportJWK, SignJWT, jwtVerify, createRemoteJWKSet, type JWTPayload, type KeyLike } from 'jose';
import { randomUUID } from 'node:crypto';

let cachedPrivateKey: KeyLike | null = null;
let cachedPublicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string } | null = null;

function pem(): string {
  const raw = process.env.LTI_PRIVATE_KEY;
  if (!raw) throw new Error('LTI_PRIVATE_KEY env var is not set');
  let s = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (!s.includes('\n')) {
    const begin = '-----BEGIN PRIVATE KEY-----';
    const end = '-----END PRIVATE KEY-----';
    const bi = s.indexOf(begin);
    const ei = s.indexOf(end);
    if (bi !== -1 && ei !== -1) {
      const body = s.slice(bi + begin.length, ei).replace(/\s/g, '');
      const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
      s = `${begin}\n${wrapped}\n${end}\n`;
    }
  }
  return s;
}

function kid(): string {
  const k = process.env.LTI_KEY_ID;
  if (!k) throw new Error('LTI_KEY_ID env var is not set');
  return k;
}

async function getPrivateKey(): Promise<KeyLike> {
  if (!cachedPrivateKey) cachedPrivateKey = await importPKCS8(pem(), 'RS256');
  return cachedPrivateKey;
}

export async function getPublicJwks() {
  if (!cachedPublicJwk) {
    const priv = await getPrivateKey();
    const jwk = await exportJWK(priv);
    cachedPublicJwk = {
      kty: jwk.kty!,
      n: jwk.n!,
      e: jwk.e!,
      kid: kid(),
      alg: 'RS256',
      use: 'sig',
    };
  }
  return { keys: [cachedPublicJwk] };
}

const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getRemoteJwks(url: string) {
  let jwks = remoteJwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 });
    remoteJwksCache.set(url, jwks);
  }
  return jwks;
}

export async function verifyPlatformIdToken(
  idToken: string,
  expected: { issuer: string; audience: string; jwksUrl: string },
): Promise<JWTPayload> {
  const jwks = getRemoteJwks(expected.jwksUrl);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: expected.issuer,
    audience: expected.audience,
  });
  return payload;
}

export async function signClientAssertion(opts: {
  audience: string;
  clientId: string;
}): Promise<string> {
  const priv = await getPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: kid(), typ: 'JWT' })
    .setIssuer(opts.clientId)
    .setSubject(opts.clientId)
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .setJti(randomUUID())
    .sign(priv);
}

export async function signDeepLinkingResponse(opts: {
  issuer: string;
  audience: string;
  deploymentId: string;
  nonce: string;
  contentItems: unknown[];
  dataClaim?: string;
}): Promise<string> {
  const priv = await getPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiDeepLinkingResponse',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': opts.deploymentId,
    'https://purl.imsglobal.org/spec/lti-dl/claim/content_items': opts.contentItems,
    ...(opts.dataClaim ? { 'https://purl.imsglobal.org/spec/lti-dl/claim/data': opts.dataClaim } : {}),
    nonce: opts.nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: kid(), typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .setJti(randomUUID());
  return builder.sign(priv);
}
