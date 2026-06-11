import { withHandler } from '../lib/with-handler.js';

/**
 * Liveness + deployed-version probe. Returns the commit SHA Vercel built from,
 * so you can confirm a push actually deployed (the auto-deploy has been flaky —
 * `curl https://api.proofready.app/health` and check `sha` against `git rev-parse HEAD`).
 * Public, no auth, no secrets.
 */
export default withHandler(
  { methods: ['GET'], auth: 'none', label: 'health' },
  (_req, res) => {
    res.status(200).json({
      ok: true,
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      env: process.env.VERCEL_ENV ?? null,
    });
  },
);
