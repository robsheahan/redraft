/**
 * Attachments — signed upload + signed download for task/submission files.
 *
 * Files live in a PRIVATE Supabase Storage bucket ('attachments'). Nothing is
 * done with them; they are stored and shown only. All authorization lives here
 * (the bucket has no Storage RLS — the service role bypasses it on read, and a
 * signed-upload token authorises a single write):
 *
 *   POST /api/attachment   → mint a signed UPLOAD url for one file. Validates
 *                            type + size; teacher role required for task scope.
 *                            The client then uploads directly to Storage and
 *                            records the returned `meta` on the task/submission.
 *   GET  /api/attachment   → authorise the caller against the owning task or
 *                            submission, then mint a short-lived signed DOWNLOAD
 *                            url. ?path=… plus ?task_id=… or ?submission_id=….
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { getSupabase, authoritativeRole } from '../lib/auth.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { withHandler } from '../lib/with-handler.js';

const BUCKET = 'attachments';
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
  'application/pdf',
]);
const DOWNLOAD_TTL = 300; // seconds

export default withHandler({ methods: ['POST', 'GET'], label: 'attachment' }, async (req, res, ctx) => {
  const user = ctx.user!;
  if (req.method === 'POST') return signUpload(req, res, user);
  return signDownload(req, res, user);
});

// Strip path separators and exotic characters; keep something human-readable for
// the stored object name. The real uniqueness comes from the UUID prefix.
function safeName(name: string): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

async function signUpload(req: VercelRequest, res: VercelResponse, user: any) {
  const { scope, filename, content_type, size } = req.body || {};
  if (scope !== 'task' && scope !== 'submission') {
    return res.status(400).json({ error: 'scope must be "task" or "submission".' });
  }
  if (typeof filename !== 'string' || !filename.trim()) {
    return res.status(400).json({ error: 'filename is required.' });
  }
  if (typeof content_type !== 'string' || !ALLOWED_TYPES.has(content_type)) {
    return res.status(400).json({ error: 'Only images (JPG, PNG, HEIC, WebP) and PDFs are allowed.' });
  }
  if (typeof size !== 'number' || size <= 0 || size > MAX_SIZE) {
    return res.status(400).json({ error: 'Each file must be 10MB or smaller.' });
  }
  if (scope === 'task' && authoritativeRole(user) !== 'teacher') {
    return res.status(403).json({ error: 'Only teachers can attach task materials.' });
  }

  // Storage-abuse guard: each successful call mints a signed write into the
  // bucket, so cap how fast one account can fill it.
  const rateLimit = await checkAndLogRateLimit(getSupabase(), user.id, {
    endpoint: 'attachment-upload',
    perUserPerHour: 60,
    globalPerDay: 2000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many uploads — please wait a while and try again.' });
  }

  const folder = scope === 'task' ? 'tasks' : 'submissions';
  const path = `${folder}/${user.id}/${randomUUID()}-${safeName(filename)}`;

  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return res.status(500).json({ error: error?.message || 'Could not create upload URL.' });

  return res.status(200).json({
    path,
    token: data.token,
    signedUrl: data.signedUrl,
    meta: { path, name: safeName(filename), content_type, size },
  });
}

async function signDownload(req: VercelRequest, res: VercelResponse, user: any) {
  const path = String(req.query.path || '').trim();
  const taskId = String(req.query.task_id || '').trim();
  const submissionId = String(req.query.submission_id || '').trim();
  if (!path) return res.status(400).json({ error: 'path is required.' });

  const supabase = getSupabase();

  if (taskId) {
    // Task material: caller must own the task or be enrolled in its class, and
    // the path must actually belong to this task.
    const { data: task } = await supabase
      .from('tasks').select('id, teacher_id, class_id, teacher_attachments').eq('id', taskId).maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!attachmentListHas(task.teacher_attachments, path)) return res.status(403).json({ error: 'Forbidden' });
    // The attachment list was written verbatim from the client, so membership in
    // it is NOT proof of ownership — also require the path to sit inside the
    // task teacher's own upload folder (paths are minted as tasks/<userId>/…).
    if (!path.startsWith(`tasks/${task.teacher_id}/`)) return res.status(403).json({ error: 'Forbidden' });

    let allowed = task.teacher_id === user.id;
    if (!allowed) {
      const { data: m } = await supabase
        .from('class_members').select('student_id')
        .eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
      allowed = !!m;
    }
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  } else if (submissionId) {
    // Submission attachment: caller must be the student owner or the teacher who
    // owns the submission's task class, and the path must belong to it.
    const { data: sub } = await supabase
      .from('submissions').select('id, student_id, task_id, student_attachments').eq('id', submissionId).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    if (!attachmentListHas(sub.student_attachments, path)) return res.status(403).json({ error: 'Forbidden' });
    // The attachment list came verbatim from the client at submit time — a
    // student could list ANY bucket path in their own submission. Require the
    // path to sit inside the submitting student's own upload folder (paths are
    // minted as submissions/<userId>/…).
    if (!path.startsWith(`submissions/${sub.student_id}/`)) return res.status(403).json({ error: 'Forbidden' });

    let allowed = sub.student_id === user.id;
    if (!allowed && sub.task_id) {
      const { data: task } = await supabase
        .from('tasks').select('teacher_id').eq('id', sub.task_id).maybeSingle();
      allowed = !!task && task.teacher_id === user.id;
    }
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  } else {
    return res.status(400).json({ error: 'task_id or submission_id is required.' });
  }

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, DOWNLOAD_TTL);
  if (error || !data) return res.status(500).json({ error: error?.message || 'Could not create download URL.' });
  return res.status(200).json({ url: data.signedUrl });
}

function attachmentListHas(list: any, path: string): boolean {
  return Array.isArray(list) && list.some((a) => a && a.path === path);
}
