import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPublicJwks } from '../../lib/lti/jwt.js';

// Kept with the other api/lti/* handlers as a bespoke group rather than on
// lib/with-handler — a fixed public JWKS GET with its own cache headers.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const jwks = await getPublicJwks();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(jwks);
}

