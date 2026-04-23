const SUPABASE_URL = 'https://jcxcbqsxshlwwvxlyyfd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeGNicXN4c2hsd3d2eGx5eWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1OTI1OTAsImV4cCI6MjA5MDE2ODU5MH0.v-jfhkGiknFQylRnX94c4yFYL2qd3Th_nVq8u8b5GsM';

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
  return fetch(url, { ...options, headers });
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
