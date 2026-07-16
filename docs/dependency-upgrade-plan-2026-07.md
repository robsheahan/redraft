# Dependency upgrade plan — July 2026

`npm audit fix` has applied the available non-breaking dependency updates,
including the high-severity `ws` fix. Remaining advisories require breaking
major upgrades and should be handled separately rather than with
`npm audit fix --force`.

## Anthropic SDK

- Current line: `@anthropic-ai/sdk` 0.80.x.
- Audit target: 0.111.x or newer.
- Exposure is limited: the reported advisories affect the local filesystem
  memory tool, which ProofReady does not use. The SDK is still required by the
  maths verifier and provider fallback.
- Upgrade in its own PR. Re-run the maths equivalence loop, prompt caching,
  forced tool calls, vision input, fallback, and usage extraction before
  deployment.

## Sentry / OpenTelemetry

- Current line: `@sentry/node` 8.x.
- Audit target: 10.x or newer, which changes the OpenTelemetry dependency tree.
- Upgrade in its own PR. Verify `captureError`, serverless cold start, request
  context, source maps, and Vercel function bundle size.

## Vercel development tooling

The remaining `ajv`, `undici`, `path-to-regexp`, `minimatch`, `js-yaml`, and
related findings are under the local `@vercel/node` build-tool dependency.
Do not accept npm's suggested downgrade to `@vercel/node@4`. Reassess against
the next compatible Vercel Node release and confirm `npm audit --omit=dev`
separately from the full development-tree report.
