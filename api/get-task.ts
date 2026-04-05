import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  const code = (req.query.code as string || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Code is required' });
  }

  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('code', code)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Task not found. Check the code and try again.' });
  }

  const { notes, ...studentData } = data;
  return res.status(200).json(studentData);
}
