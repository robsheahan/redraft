import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { role } = req.body;
  if (!role || !['teacher', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Role must be teacher or student' });
  }

  const supabase = getSupabase();

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, role },
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ role });
}
