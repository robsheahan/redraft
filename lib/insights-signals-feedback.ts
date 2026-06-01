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
import { INSIGHTS_SIGNALS_TOOL } from './feedback-tools.js';
import { buildInsightsSignalsPrompt } from '../prompts/insights-signals-system.js';

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
}): Promise<InsightsSignals> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });

  const { system, user } = buildInsightsSignalsPrompt(opts);
  const result = await callTool<InsightsSignals>({
    client,
    model: MODEL,
    max_tokens: 1400,
    temperature: 0.2,
    system,
    user,
    tool: INSIGHTS_SIGNALS_TOOL,
  });
  return result.value;
}
