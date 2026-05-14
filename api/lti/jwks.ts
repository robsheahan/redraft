import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPublicJwks } from '../../lib/lti/jwt.js';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const jwks = await getPublicJwks();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(jwks);
  } catch (err: any) {
    const raw = process.env.LTI_PRIVATE_KEY || '';
    res.status(500).json({
      error: err?.message,
      diag: {
        len: raw.length,
        hasRealNewline: raw.includes('\n'),
        hasEscapedNewline: raw.includes('\\n'),
        hasSpace: raw.includes(' '),
        hasBegin: raw.includes('-----BEGIN PRIVATE KEY-----'),
        hasEnd: raw.includes('-----END PRIVATE KEY-----'),
        startsWithDashes: raw.startsWith('-----'),
        first20: raw.slice(0, 20),
        keyIdSet: !!process.env.LTI_KEY_ID,
      },
    });
  }
}

