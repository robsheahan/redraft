import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPublicJwks } from '../../lib/lti/jwt.js';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const jwks = await getPublicJwks();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(jwks);
}
