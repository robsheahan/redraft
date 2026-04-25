import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabase, verifyAuth } from '../lib/auth.js';
import { getUserInfoBatch } from '../lib/user-names.js';

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const taskId = (req.query.task_id as string || '').trim();
  if (!taskId) return res.status(400).json({ error: 'task_id is required.' });

  const supabase = getSupabase();

  const { data: task } = await supabase
    .from('tasks').select('id, title, course, question, classes(teacher_id, name)').eq('id', taskId).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const teacherId = (task.classes as any)?.teacher_id;
  if (teacherId !== user.id) return res.status(403).json({ error: 'Not authorised.' });

  const { data: submissions, error } = await supabase
    .from('submissions').select('student_id, draft_version, draft_text, feedback, created_at').eq('task_id', taskId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const studentIds = [...new Set((submissions || []).map(s => s.student_id).filter(Boolean))] as string[];
  const userInfo = await getUserInfoBatch(supabase, studentIds);

  const headers = ['student_name','student_email','draft_version','submitted_at','overall','top_priority','improvements','strengths','draft_text'];
  const rows: string[] = [headers.join(',')];
  for (const s of (submissions || [])) {
    const summary = summariseFeedback(s.feedback);
    rows.push([
      userInfo[s.student_id]?.name || 'Unknown',
      userInfo[s.student_id]?.email || '',
      s.draft_version || 1,
      s.created_at,
      summary.overall,
      summary.priority,
      summary.improvements,
      summary.strengths,
      s.draft_text || '',
    ].map(csvEscape).join(','));
  }

  const csv = '\uFEFF' + rows.join('\n') + '\n';
  const safeTitle = (task.title || task.id).toString().replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) || 'task';
  const filename = `proofready-${safeTitle}-submissions.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}
