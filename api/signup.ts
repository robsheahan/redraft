import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, display_name, role } = req.body;

  if (!email || !password || !display_name) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }

  if (role && !['teacher', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Role must be teacher or student' });
  }

  const supabase = getSupabase();

  const metadata: Record<string, string> = { display_name };
  if (role) metadata.role = role;

  // Create user with admin API — bypasses email confirmation
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ user: { id: data.user.id, email: data.user.email } });
}
