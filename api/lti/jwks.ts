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
    const hex = process.env.LTI_PRIVATE_KEY_HEX || '';
    res.status(500).json({
      error: err?.message,
      diag: {
        keyIdSet: !!process.env.LTI_KEY_ID,
        hex: {
          set: hex.length > 0,
          len: hex.length,
          looksLikeHex: /^[0-9a-fA-F\s]+$/.test(hex),
          firstChars: hex.slice(0, 16),
          lastChars: hex.slice(-16),
        },
        pem: {
          set: raw.length > 0,
          len: raw.length,
          first20: raw.slice(0, 20),
        },
      },
    });
  }
}

