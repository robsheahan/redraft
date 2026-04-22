import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';

/**
 * Export all submissions for a task as CSV. Only accessible to the task owner.
 * One row per draft version so teachers see progression.
 */

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function summariseFeedback(fb: any): { overall: string; priority: string; improvements: string; strengths: string } {
  if (!fb || typeof fb !== 'object') return { overall: '', priority: '', improvements: '', strengths: '' };

  const pick = (val: any): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && typeof val.summary === 'string') return val.summary;
    if (Array.isArray(val)) return val.join(' | ');
    if (typeof val === 'object' && Array.isArray(val.summary)) return val.summary.join(' | ');
    return '';
  };

  return {
    overall: pick(fb.overall),
    priority: pick(fb.top_priority),
    improvements: pick(fb.improvements),
    strengths: pick(fb.what_youve_done_well),
  };
}

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

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('code, title, course, class_name, question')
    .eq('code', code)
    .eq('teacher_id', user.id)
    .single();
  if (taskError || !task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { data: submissions, error } = await supabase
    .from('submissions')
    .select('student_id, draft_version, draft_text, feedback, created_at')
    .eq('task_code', code)
    .order('created_at', { ascending: true });
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Look up student display names in one pass
  const studentIds = [...new Set((submissions || []).map(s => s.student_id).filter(Boolean))];
  const nameMap: Record<string, string> = {};
  const emailMap: Record<string, string> = {};
  for (const id of studentIds) {
    const { data } = await supabase.auth.admin.getUserById(id);
    if (data?.user) {
      nameMap[id] = data.user.user_metadata?.display_name || '';
      emailMap[id] = data.user.email || '';
    }
  }

  const headers = [
    'student_name',
    'student_email',
    'draft_version',
    'submitted_at',
    'overall',
    'top_priority',
    'improvements',
    'strengths',
    'draft_text',
  ];

  const rows: string[] = [headers.join(',')];
  for (const s of (submissions || [])) {
    const summary = summariseFeedback(s.feedback);
    rows.push([
      nameMap[s.student_id] || 'Unknown',
      emailMap[s.student_id] || '',
      s.draft_version || 1,
      s.created_at,
      summary.overall,
      summary.priority,
      summary.improvements,
      summary.strengths,
      s.draft_text || '',
    ].map(csvEscape).join(','));
  }

  const csv = '\uFEFF' + rows.join('\n') + '\n'; // BOM so Excel opens UTF-8 correctly

  const safeCode = code.replace(/[^A-Z0-9]/g, '');
  const filename = `proofready-${safeCode}-submissions.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}
