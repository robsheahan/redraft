/**
 * AI-powered rubric parser.
 *
 * Replaces the brittle regex-based client parser for the storage path:
 * a teacher pastes their rubric in any reasonable shape, the model returns
 * a normalised structure, and we cache it on the task row. The renderer
 * uses this directly — no parsing on every page load, no failure when a
 * new format shows up.
 *
 * Returns null on any failure so the caller can fall back to the
 * client-side regex parser. Never throws.
 */

import Anthropic from '@anthropic-ai/sdk';
import { callTool } from './anthropic-tool-call.js';
import { RUBRIC_PARSE_TOOL } from './feedback-tools.js';

export interface StructuredBand {
  range: string;
  criteria: string[];
}

export interface StructuredCriterion {
  name: string;
  range: string;
  details: string[];
}

export interface StructuredRubric {
  format: 'band' | 'criterion';
  bands?: StructuredBand[];
  criteria?: StructuredCriterion[];
}

const SYSTEM_PROMPT = `You parse marking rubrics that NSW HSC teachers paste from various sources (Word, PDFs, Google Docs, websites). Pasted text often has lost its formatting — table cells glued together, line breaks missing, multi-hyphens in ranges. Your job is to recover the structure faithfully.

Rules:
1. PRESERVE the teacher's wording exactly. Do not paraphrase, summarise, or rewrite. Each descriptor must be verbatim from the input.
2. Choose 'band' format when the rubric organises descriptors by overall quality level with mark ranges (e.g. "17-20", "Band 5", "Grade A").
3. Choose 'criterion' format when the rubric lists separable assessment criteria (e.g. Knowledge, Analysis, Communication).
4. For band format, list bands HIGHEST range first. Each band's "criteria" array holds the descriptor points for that band — SPLIT each distinct point/sentence into its own array entry. If the teacher wrote a band's descriptor as a continuous paragraph that covers multiple separable qualities (e.g. one sentence about analysis, one about evidence, one about communication), split those into separate entries. The renderer shows each entry as a bullet, so multi-point descriptors must be multi-entry arrays. Only collapse into a single entry if the descriptor is genuinely one indivisible idea. Preserve the teacher's exact wording — split, don't paraphrase.
5. For criterion format, preserve the teacher's order. Each criterion's "details" array holds bullet/detail points (empty array if none).
6. Drop pure header rows like "Marks | Criteria", "Range | Descriptor", "Marking Criteria" — these are table headers, not content.
7. Normalise mark ranges so the dash is "–" (en-dash) — accept any of "21-25", "21–25", "21--25", "21 to 25" and output "21–25".
8. If the rubric is genuinely unstructured prose, choose the format that fits best and put the prose into a single band/criterion.`;

export async function parseRubricWithAI(rawText: string): Promise<StructuredRubric | null> {
  if (!rawText || !rawText.trim()) return null;
  const client = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 })
    : undefined;

  try {
    const result = await callTool<StructuredRubric>({
      client,
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      user: `Parse this marking rubric:\n\n${rawText}`,
      tool: RUBRIC_PARSE_TOOL,
    });
    const value = result.value;

    // Sanity-check the returned shape before storing
    if (!value || (value.format !== 'band' && value.format !== 'criterion')) {
      console.warn('[parse-rubric] unexpected format:', value?.format);
      return null;
    }
    if (value.format === 'band') {
      if (!Array.isArray(value.bands) || value.bands.length === 0) {
        console.warn('[parse-rubric] band format but no bands returned');
        return null;
      }
      return { format: 'band', bands: value.bands };
    }
    if (!Array.isArray(value.criteria) || value.criteria.length === 0) {
      console.warn('[parse-rubric] criterion format but no criteria returned');
      return null;
    }
    return { format: 'criterion', criteria: value.criteria };
  } catch (err: any) {
    console.warn('[parse-rubric] AI parse failed:', err?.message || err);
    return null;
  }
}
