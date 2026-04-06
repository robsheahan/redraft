import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Fetch all drafts a student has submitted for a given task code.
 * Used on the feedback page to cycle between prior drafts.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const code = (req.query.code as string || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Task code is required' });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('submissions')
    .select('draft_text, feedback, draft_version, created_at, question, course')
    .eq('student_id', user.id)
    .eq('task_code', code)
    .order('draft_version', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ drafts: data || [] });
}
