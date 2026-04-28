/**
 * CORS middleware for ProofReady API routes.
 *
 * Production split: the static site is served from proofready.app
 * (Cloudflare-proxied) while API routes live at api.proofready.app
 * (DNS-only → direct to Vercel). Cross-origin requests from the
 * browser need explicit CORS headers and a 204 OPTIONS preflight.
 *
 * Usage:
 *   import { applyCors } from '../lib/cors.js';
 *   export default async function handler(req, res) {
 *     if (applyCors(req, res)) return;   // preflight handled
 *     // ... normal handler logic
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = new Set([
  'https://proofready.app',
  'https://www.proofready.app',
  'http://localhost:3000',
  'http://localhost:5173',
]);

/**
 * Apply CORS headers and handle OPTIONS preflight.
 * Returns true if the response has been sent (preflight) — caller should return immediately.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = (req.headers.origin as string) || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Default to the production origin so requests from same-origin
    // (e.g. internal calls during testing) still work.
    res.setHeader('Access-Control-Allow-Origin', 'https://proofready.app');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
