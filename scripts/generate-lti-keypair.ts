import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';

const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });

const kid = randomUUID();
const privatePem = await exportPKCS8(privateKey);
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = kid;
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

console.log('=== LTI_KEY_ID (kid) — set as env var LTI_KEY_ID ===');
console.log(kid);
console.log();
console.log('=== LTI_PRIVATE_KEY — set as env var (single line, \\n escaped, or paste multi-line in Vercel) ===');
console.log(privatePem.trim());
console.log();
console.log('=== Public JWK — already served at /lti/jwks once LTI_PRIVATE_KEY + LTI_KEY_ID are set ===');
console.log(JSON.stringify({ keys: [publicJwk] }, null, 2));
