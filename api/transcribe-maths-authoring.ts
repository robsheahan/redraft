/**
 * Teacher authoring transcription (#3b) — Claude Sonnet 4.6 vision.
 *
 * A teacher photographs a question, a worked solution, or a multi-part question
 * while setting a task; this returns editable content (text, or {stem, parts}).
 * Transcribe + structure ONLY — never solves or invents content; the teacher
 * reviews + edits before publishing. See docs/maths-overhaul-plan.md §#3b.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, authoritativeRole } from '../lib/auth.js';
import { withHandler } from '../lib/with-handler.js';
import { checkAndLogRateLimit } from '../lib/rate-limit.js';
import { captureError } from '../lib/sentry.js';
import { callTool } from '../lib/anthropic-tool-call.js';
import { MATHS_AUTHORING_TEXT_TOOL, MATHS_AUTHORING_PARTS_TOOL } from '../lib/feedback-tools.js';
import {
  buildMathsAuthoringTranscriptionSystem,
  buildMathsAuthoringUserText,
} from '../prompts/maths-system.js';

const MAX_BASE64_CHARS = 4_000_000;
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedMedia = typeof ALLOWED_MEDIA[number];
type Target = 'question' | 'worked_solution' | 'parts';

export default withHandler({ methods: ['POST'], label: 'transcribe-maths-authoring' }, async (req, res, ctx) => {
  const user = ctx.user!;
  // Teacher-only: this is an authoring tool, and a student shouldn't be able to
  // transcribe arbitrary images on our dime.
  if (authoritativeRole(user) !== 'teacher') {
    return res.status(403).json({ error: 'Only teachers can transcribe authoring photos.' });
  }

  const { image_base64, media_type, target: rawTarget, course } = (req.body || {}) as {
    image_base64?: string; media_type?: string; target?: string; course?: string;
  };
  if (!image_base64 || typeof image_base64 !== 'string') {
    return res.status(400).json({ error: 'No image provided.' });
  }
  if (image_base64.length > MAX_BASE64_CHARS) {
    return res.status(400).json({ error: 'That photo is too large — retake it at a lower resolution.' });
  }
  const mt: AllowedMedia = (ALLOWED_MEDIA as readonly string[]).includes(media_type || '')
    ? (media_type as AllowedMedia)
    : 'image/jpeg';
  const target: Target = rawTarget === 'worked_solution' || rawTarget === 'parts' ? rawTarget : 'question';

  const supabase = getSupabase();
  const rateLimit = await checkAndLogRateLimit(supabase, user.id, {
    endpoint: 'transcribe-maths-authoring',
    perUserPerHour: 40,
    globalPerDay: 1500,
  });
  if (!rateLimit.ok) {
    if (rateLimit.retryAfterSeconds) res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: rateLimit.reason || 'Rate limit exceeded.' });
  }

  const courseStr = typeof course === 'string' && course.trim() ? course.trim() : null;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const tool = target === 'parts' ? MATHS_AUTHORING_PARTS_TOOL : MATHS_AUTHORING_TEXT_TOOL;
    const result = await callTool<any>({
      client,
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: buildMathsAuthoringTranscriptionSystem(target),
      user: [
        { type: 'text', text: buildMathsAuthoringUserText(target, courseStr) },
        { type: 'image', source: { type: 'base64', media_type: mt, data: image_base64 } },
      ],
      tool,
      label: 'maths:authoring-transcribe',
    });

    if (target === 'parts') {
      const stem = typeof result.value.stem === 'string' ? result.value.stem.trim() : '';
      const parts = (Array.isArray(result.value.parts) ? result.value.parts : [])
        .map((p: any) => ({
          label: typeof p?.label === 'string' ? p.label.trim() : '',
          text: typeof p?.text === 'string' ? p.text.trim() : '',
        }))
        .filter((p: any) => p.text);
      if (parts.length === 0) {
        return res.status(422).json({ error: 'No parts could be read from that photo. Try a clearer shot, or type them.' });
      }
      return res.status(200).json({ stem, parts });
    }

    const text = typeof result.value.text === 'string' ? result.value.text.trim() : '';
    if (!text) {
      return res.status(422).json({ error: 'Nothing could be read from that photo. Try a clearer, well-lit shot.' });
    }
    return res.status(200).json({ text });
  } catch (err: any) {
    captureError(err, { stage: 'transcribe-maths-authoring', user_id: user.id });
    return res.status(500).json({ error: 'Could not read your photo. Try a clearer shot, or type it.' });
  }
});
