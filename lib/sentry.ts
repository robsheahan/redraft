import * as Sentry from '@sentry/node';

let initialised = false;

function init() {
  if (initialised) return;
  initialised = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

init();

export function captureError(err: unknown, context?: Record<string, any>) {
  if (!process.env.SENTRY_DSN) return;
  try {
    if (context) {
      Sentry.withScope(scope => {
        Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
        Sentry.captureException(err);
      });
    } else {
      Sentry.captureException(err);
    }
  } catch {
    // never let observability break the request
  }
}

export { Sentry };
