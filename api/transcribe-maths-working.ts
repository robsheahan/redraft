/**
 * Pass A (photo) — transcribe a photo of handwritten maths working into the
 * canonical { math } line shape. Claude Sonnet 4.6 vision.
 *
 * The client downscales the image (≈1600px, JPEG) before sending base64, so the
 * body stays well under Vercel's limit and we avoid a storage round-trip. The
 * student confirms the transcribed lines (the existing freeform/talk-through
 * confirm screen) before any feedback runs — misreads become a teaching moment,
 * not silent corruption. See docs/maths-overhaul-plan.md §#3.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { MATHS_STRUCTURE_WORKING_TOOL } from '../lib/feedback-tools.js';
import {
  buildMathsTranscriptionSystem,
  buildMathsTranscriptionUserText,
} from '../prompts/maths-system.js';

// base64 is ~1.33× the binary size; cap the string so the JSON body stays under
// Vercel's ~4.5MB request limit. Client downscaling keeps real photos far below this.
const MAX_BASE64_CHARS = 4_000_000;
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedMedia = typeof ALLOWED_MEDIA[number];

export default withHandler({ methods: ['POST'], label: 'transcribe-maths-working' }, async (req, res, ctx) => {
  const user = ctx.user!;
  const { task_id, image_base64, media_type } = (req.body || {}) as {
    task_id?: string; image_base64?: string; media_type?: string;
  };

  if (!task_id) return res.status(400).json({ error: 'task_id is required.' });
  if (!image_base64 || typeof image_base64 !== 'string') {
    return res.status(400).json({ error: 'No image provided.' });
  }
  if (image_base64.length > MAX_BASE64_CHARS) {
    return res.status(400).json({ error: 'That photo is too large — retake it, or it will be downscaled automatically.' });
  }
  const mt: AllowedMedia = (ALLOWED_MEDIA as readonly string[]).includes(media_type || '')
    ? (media_type as AllowedMedia)
    : 'image/jpeg';

  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'transcribe-maths-working',
    perUserPerHour: 30,
    globalPerDay: 2000,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded.' });
  }

  const { data: task } = await supabase
    .from('tasks').select('id, question, subject_type, class_id, published_at').eq('id', task_id).maybeSingle();
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!task.published_at) return res.status(400).json({ error: 'This task is a draft and not yet open for submissions.' });
  if (task.subject_type !== 'maths') return res.status(400).json({ error: 'Photo transcription is for maths tasks only.' });
  const { data: membership } = await supabase
    .from('class_members').select('student_id').eq('class_id', task.class_id).eq('student_id', user.id).maybeSingle();
  if (!membership) return res.status(403).json({ error: 'You are not a member of this task\'s class.' });

  const question = String(task.question || '').trim();

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const result = await callTool<{ lines: Array<{ math: string }> }>({
      client,
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: buildMathsTranscriptionSystem(),
      user: [
        { type: 'text', text: buildMathsTranscriptionUserText(question) },
        { type: 'image', source: { type: 'base64', media_type: mt, data: image_base64 } },
      ],
      tool: MATHS_STRUCTURE_WORKING_TOOL,
      label: 'maths:transcribe',
    });

    const lines = (result.value.lines || [])
      .map(l => ({ math: typeof l?.math === 'string' ? l.math.trim() : '' }))
      .filter(l => l.math);

    if (lines.length === 0) {
      return res.status(422).json({ error: 'No working could be read from that photo. Try a clearer, well-lit shot — or switch to typing.' });
    }
    return res.status(200).json({ working_lines: lines });
  } catch (err: any) {
    captureError(err, { stage: 'transcribe-maths-working', task_id, user_id: user.id });
    return res.status(500).json({ error: 'Could not read your photo. Try a clearer shot, or switch to typing.' });
  }
});
