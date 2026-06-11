/**
 * Silent insights pass for marked_task and quick_task submissions.
 *
 * Runs a single Haiku call against the draft, returns structured signals
 * shaped to match the relevant subset of HOLISTIC_FEEDBACK_TOOL — so the
 * existing cohort cards and student-profile synthesis consume it without
 * any changes.
 *
 * Never shown to students. Roughly $0.004 per call at current Haiku
 * pricing (vs ~$0.10–0.20 for the 3-pass Sonnet feedback).
 */

import Anthropic from '@anthropic-ai/sdk';
import { callTool } from './anthropic-tool-call.js';
import { buildInsightsSignalsTool } from './feedback-tools.js';
import { buildInsightsSignalsPrompt } from '../prompts/insights-signals-system.js';
import type { SkillFamily } from '../data/skill-taxonomy.js';

const MODEL = 'claude-haiku-4-5-20251001';

export interface InsightsSignals {
  what_youve_done_well: { summary: string[] };
  task_verb_check: { summary: string };
  improvements: { summary: string[]; detail: string[] };
  top_priority: string;
  skill_assessment?: any[];
}

export async function generateInsightsSignals(opts: {
  course: string | null;
  question: string;
  draft: string;
  // Which skill family to assess against. Maths working → M1–M6; everything
  // else → writing W1–W7. Defaults to writing for back-compat.
  family?: SkillFamily;
}): Promise<InsightsSignals> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  const family: SkillFamily = opts.family === 'maths' ? 'maths' : 'writing';
  const { system, user } = buildInsightsSignalsPrompt({ ...opts, family });
  const result = await callTool<InsightsSignals>({
    client,
    model: MODEL,
    max_tokens: 1400,
    temperature: 0.2,
    system,
    user,
    tool: buildInsightsSignalsTool(family),
  });
  return result.value;
}
