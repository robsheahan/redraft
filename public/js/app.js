// Sentry browser SDK — DSN is safe to expose by design. Loads from the
// Sentry CDN so we don't need a build step. Skipped on localhost.
(function() {
  if (typeof window === 'undefined') return;
  var host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
  var s = document.createElement('script');
  s.src = 'https://browser.sentry-cdn.com/8.42.0/bundle.tracing.min.js';
  s.crossOrigin = 'anonymous';
  s.onload = function() {
    if (!window.Sentry) return;
    window.Sentry.init({
      dsn: 'https://483d2cc6da6e5f258448ca84900aee01@o4510830359937024.ingest.us.sentry.io/4511308025233408',
      environment: host.indexOf('proofready.app') >= 0 ? 'production' : 'preview',
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  };
  document.head.appendChild(s);
})();

const SUPABASE_URL = 'https://jcxcbqsxshlwwvxlyyfd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeGNicXN4c2hsd3d2eGx5eWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1OTI1OTAsImV4cCI6MjA5MDE2ODU5MH0.v-jfhkGiknFQylRnX94c4yFYL2qd3Th_nVq8u8b5GsM';

// API base. Production routes /api/* through api.proofready.app (DNS-only,
// not Cloudflare-proxied) so requests can hold a connection longer than
// Cloudflare's 100s edge timeout. Local dev and Vercel preview deployments
// keep relative paths since they're already direct-to-Vercel.
const API_BASE = (function() {
  var host = window.location.hostname;
  if (host === 'proofready.app' || host === 'www.proofready.app') return 'https://api.proofready.app';
  return '';
})();

function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//.test(path)) return path;
  return API_BASE + path;
}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getCurrentUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}

async function getAccessToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || null;
}

async function authFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(apiUrl(url), { ...options, headers });
}

async function requireAuth(expectedRole) {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = '/auth.html' + (expectedRole ? '?role=' + expectedRole : '');
    return null;
  }
  const role = user.user_metadata?.role;
  if (expectedRole && role !== expectedRole) {
    window.location.href = '/';
    return null;
  }
  return user;
}

function getUserMeta(user) {
  const role = user.user_metadata?.role || 'student';
  // Google OAuth populates full_name/name; email/password signup uses display_name.
  let displayName = user.user_metadata?.display_name
    || user.user_metadata?.full_name
    || user.user_metadata?.name
    || user.email;
  // Strip role prefix if display_name starts with it (e.g. "Teacher - Rob" → "Rob")
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  if (displayName.toLowerCase().startsWith(role)) {
    displayName = displayName.slice(role.length).replace(/^[\s\-–—:·]+/, '').trim() || user.email;
  }
  return { displayName, role };
}

async function logout() {
  await sb.auth.signOut();
  window.location.href = '/';
}
