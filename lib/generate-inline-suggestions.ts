/**
 * Generate inline annotations (Pass 3) for a student draft.
 *
 * Given a draft and the improvements from Pass 1, asks Claude to produce
 * exact-quote-anchored margin notes. Validates every quote appears verbatim
 * in the draft; drops any that don't. Resolves overlapping annotations
 * (keeps the longer, more specific quote).
 *
 * Returns a result object with `ok: false` on API/network failure (so callers
 * who care — e.g. the backfill script — can distinguish "Claude call failed"
 * from "Claude responded but produced no usable annotations"). Never throws.
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildInlineSuggestionsSystemPrompt } from '../prompts/inline-suggestions-system.js';
import { buildInlineSuggestionsUserPrompt } from '../prompts/inline-suggestions-user.js';
import { extractFirstJsonObject } from './extract-json.js';

export type InlineCategory =
  | 'strength'
  | 'clarity'
  | 'evidence'
  | 'depth'
  | 'structure'
  | 'task_alignment'
  | 'mechanics';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<InlineCategory>([
  'strength', 'clarity', 'evidence', 'depth', 'structure', 'task_alignment', 'mechanics',
]);

export interface InlineSuggestion {
  quote: string;
  occurrence: number;
  category: InlineCategory;
  comment: string;
  linked_improvement_index: number | null;
  // Resolved server-side so the client doesn't have to re-search the draft:
  start: number;
  end: number;
}

interface GenerateInput {
  taskDescription: string;
  taskVerbs?: string[];
  studentText: string;
  holisticImprovements: string[];
  courseName?: string;
  discipline?: string;
}

export interface GenerateInlineSuggestionsResult {
  /** true if Claude responded successfully (even if zero usable annotations); false if the call itself failed (auth, network, etc.). */
  ok: boolean;
  annotations: InlineSuggestion[];
  /** Populated when ok === false. */
  error?: string;
}

const MAX_ANNOTATIONS = 20;

export async function generateInlineSuggestions(
  client: Anthropic,
  input: GenerateInput,
): Promise<GenerateInlineSuggestionsResult> {
  let response;
  try {
    const system = buildInlineSuggestionsSystemPrompt(input.courseName, input.discipline);
    const user = buildInlineSuggestionsUserPrompt({
      taskDescription: input.taskDescription,
      taskVerbs: input.taskVerbs,
      studentText: input.studentText,
      holisticImprovements: input.holisticImprovements,
    });

    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err: any) {
    const message = err?.message || 'unknown error';
    console.warn('[inline-suggestions] Claude call failed:', message);
    return { ok: false, annotations: [], error: message };
  }

  // From here the model responded — any "zero annotations" outcome counts as ok: true.
  const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    console.warn('[inline-suggestions] no JSON object in model response');
    return { ok: true, annotations: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    console.warn('[inline-suggestions] JSON parse failed', e);
    return { ok: true, annotations: [] };
  }

  const raw = (parsed as { inline_suggestions?: unknown })?.inline_suggestions;
  if (!Array.isArray(raw)) {
    console.warn('[inline-suggestions] missing or non-array inline_suggestions field');
    return { ok: true, annotations: [] };
  }

  const annotations = validateAndResolve(raw, input.studentText, input.holisticImprovements.length);
  return { ok: true, annotations };
}

/**
 * Validates each suggestion, resolves its position in the draft, and drops
 * overlaps. Exported for unit testing.
 */
export function validateAndResolve(
  raw: unknown[],
  draft: string,
  improvementsCount: number,
): InlineSuggestion[] {
  const resolved: InlineSuggestion[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;

    const quote = typeof s.quote === 'string' ? s.quote : null;
    if (!quote || quote.length === 0) continue;

    const occurrence = Number.isInteger(s.occurrence) && (s.occurrence as number) > 0
      ? (s.occurrence as number)
      : 1;

    const category = typeof s.category === 'string' && VALID_CATEGORIES.has(s.category)
      ? (s.category as InlineCategory)
      : null;
    if (!category) continue;

    const comment = typeof s.comment === 'string' ? s.comment.trim() : '';
    if (!comment) continue;

    let linkedIdx: number | null = null;
    if (Number.isInteger(s.linked_improvement_index)) {
      const n = s.linked_improvement_index as number;
      if (n >= 0 && n < improvementsCount) linkedIdx = n;
    }

    const start = findNthOccurrence(draft, quote, occurrence);
    if (start === -1) continue; // quote not found — drop

    resolved.push({
      quote,
      occurrence,
      category,
      comment,
      linked_improvement_index: linkedIdx,
      start,
      end: start + quote.length,
    });
  }

  return capAndDropOverlaps(resolved).slice(0, MAX_ANNOTATIONS);
}

function findNthOccurrence(text: string, quote: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = text.indexOf(quote, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

/**
 * When two annotations overlap in the draft, keep the one with the longer
 * quote (more specific) and drop the shorter. Preserves draft order in output.
 */
function capAndDropOverlaps(items: InlineSuggestion[]): InlineSuggestion[] {
  const byLengthDesc = [...items].sort(
    (a, b) => (b.end - b.start) - (a.end - a.start),
  );

  const kept: InlineSuggestion[] = [];
  for (const candidate of byLengthDesc) {
    const overlaps = kept.some(k => candidate.start < k.end && candidate.end > k.start);
    if (!overlaps) kept.push(candidate);
  }

  return kept.sort((a, b) => a.start - b.start);
}
