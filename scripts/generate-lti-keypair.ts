import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
console.log('=== LTI_PRIVATE_KEY_HEX — set as env var LTI_PRIVATE_KEY_HEX ===');
console.log('(Hex-encoded so Vercel\'s web input can\'t mangle special characters. Recommended.)');
console.log(Buffer.from(privatePem, 'utf8').toString('hex'));
console.log();
console.log('=== LTI_PRIVATE_KEY (alternative; only if hex is unavailable) ===');
console.log('(Multi-line PEM. Vercel often strips whitespace/+ chars — prefer the hex form above.)');
console.log(privatePem.trim());
console.log();
console.log('=== Public JWK — served at /lti/jwks once env vars are set ===');
console.log(JSON.stringify({ keys: [publicJwk] }, null, 2));
console.log();

const hex = Buffer.from(privatePem, 'utf8').toString('hex');
const pb = spawnSync('pbcopy', { input: hex });
if (pb.status === 0) {
  console.log(`✓ LTI_PRIVATE_KEY_HEX copied to clipboard (${hex.length} chars). Paste directly into Vercel.`);
} else {
  console.log(`(pbcopy unavailable — copy the hex value above manually; length ${hex.length} chars)`);
}
