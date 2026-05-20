/**
 * Global admin check.
 *
 * Primary: matches `user.id` against the comma-separated UUIDs in the
 * ADMIN_USER_IDS env var. This is the secure check — Supabase user IDs are
 * randomly assigned and cannot be squatted by an attacker, even if email
 * confirmation is bypassed during signup.
 *
 * Fallback: when ADMIN_USER_IDS is unset, falls back to ADMIN_EMAILS. This
 * is less safe because if a NEW admin email is added to the list before the
 * actual person creates their account, an attacker could sign up with that
 * email first (since api/signup.ts uses email_confirm: true). Migrate by
 * setting ADMIN_USER_IDS on Vercel and dropping ADMIN_EMAILS.
 */

interface MinimalUser {
  id?: string | null;
  email?: string | null;
}

let fallbackWarned = false;

export function isGlobalAdmin(user: MinimalUser | null | undefined): boolean {
  if (!user) return false;

  const ids = (process.env.ADMIN_USER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length > 0) {
    return !!user.id && ids.includes(user.id);
  }

  // Legacy fallback — warn once per process so the gap is visible in logs.
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn('[admin] ADMIN_USER_IDS is not set — falling back to ADMIN_EMAILS. Set ADMIN_USER_IDS on Vercel to remove the email-squat attack surface.');
  }
  const emails = (process.env.ADMIN_EMAILS || 'robert.sheahan@gmail.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!user.email && emails.includes(user.email.toLowerCase());
}
