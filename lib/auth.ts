import type { VercelRequest } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export async function verifyAuth(req: VercelRequest) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;

  const supabase = getSupabase();
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * The authoritative role for authorization decisions. It lives in
 * `app_metadata`, which only the service role can write — NEVER read
 * `user_metadata.role` for a trust decision, because the user can rewrite their
 * own `user_metadata` from the browser (e.g. `auth.updateUser({ data })`, as
 * student.html already does for disclosure). verifyAuth() returns a freshly
 * read user, so this reflects the current DB value, not stale token claims.
 */
export function authoritativeRole(
  user: { app_metadata?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const r = user?.app_metadata?.role;
  return typeof r === 'string' ? r : null;
}
