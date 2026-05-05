/**
 * Server-side detection + cleanup for band/grade-style rubrics.
 *
 * Why this exists:
 * The model occasionally quoted teacher-supplied band labels back at the
 * student ("Grade C (13–16 marks): Sound knowledge…"), violating the
 * "no band/mark judgements in feedback" rule. The fix is structural —
 *   1. Skip Pass 2 (per-criterion strengths/improvements) for band rubrics,
 *      because each band is a quality level of the overall response, not
 *      a separable criterion.
 *   2. Strip the labels themselves from the criteria text passed to Pass 1,
 *      so the model has no concrete band/mark string to copy. Descriptor
 *      language is preserved, which keeps the quality-calibration signal.
 */

const RANGE = /\(\s*\d{1,2}\s*[–\-]\s*\d{1,2}\s*(?:marks?)?\s*\)/i;
const BAND_PREFIX = /(?:^|\n|\s)(Band|Grade)\s+(?:[A-G]|\d{1,2})\s*[(:\-]/i;

/**
 * Heuristic: a rubric is "band-style" if we see at least 2 mark-range
 * parens like "(13–15 marks)" or "(13-16)", or at least 2 "Band/Grade X"
 * label prefixes. Either pattern is a strong signal that the teacher
 * pasted a band rubric rather than a list of independent criteria.
 */
export function looksLikeBandRubric(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalised = text.replace(/(\d{1,2})\s*-{2,}\s*(\d{1,2})/g, '$1–$2');

  let rangeCount = 0;
  let labelCount = 0;
  const rangeRegex = new RegExp(RANGE.source, 'gi');
  const labelRegex = /(?:^|[\n\s])(?:Band|Grade)\s+(?:[A-G]|\d{1,2})\s*[(:\-]/gi;
  while (rangeRegex.exec(normalised)) rangeCount++;
  while (labelRegex.exec(normalised)) labelCount++;

  return rangeCount >= 2 || labelCount >= 2;
}

/**
 * Remove band/grade label prefixes and mark ranges from rubric text,
 * leaving the descriptor language intact. Output uses "- " bullets so
 * the model still sees a list of quality levels (highest to lowest as
 * teacher pasted), without any concrete label to quote back.
 *
 * Examples:
 *   "Grade A (21–25 marks): Extensive knowledge…"  → "- Extensive knowledge…"
 *   "Band 5 (17-20) Sophisticated evaluation…"     → "- Sophisticated evaluation…"
 *   "A (17–20): Strong response…"                  → "- Strong response…"
 *   "(13–15) Effective…"                           → "- Effective…"
 */
export function stripBandLabels(text: string): string {
  if (!text) return '';
  let out = text;

  // Normalise multi-hyphen ranges before pattern matching
  out = out.replace(/(\d{1,2})\s*-{2,}\s*(\d{1,2})/g, '$1–$2');

  // Drop a "Marking Criteria" / "Marking Rubric" header up top (the system
  // prompt already labels this section, so the redundant header just
  // confuses the model).
  out = out.replace(/^\s*marking\s*(rubric|criteria|guidelines?)\s*:?\s*\n?/i, '');

  // Strip band/grade labels that are followed by a mark-range paren:
  //   "Grade A (21–25 marks):" / "Band 5 (17-20)" / "A (17–20):"
  // These are the labels the model copy-pastes. Replace with "\n- " so
  // the descriptor that follows becomes a clean bullet.
  out = out.replace(
    /(?:(?:Band|Grade)\s+)?(?:[A-G]|\d{1,2})?\s*\(\s*\d{1,2}\s*[–\-]\s*\d{1,2}\s*(?:marks?)?\s*\)\s*(?:marks?)?\s*[:\-]?\s*/gi,
    '\n- ',
  );

  // Strip any remaining bare "Grade X" / "Band X" prefixes (no parens),
  // e.g. "Grade A: Extensive…"
  out = out.replace(/(?:^|\n)\s*(?:Band|Grade)\s+(?:[A-G]|\d{1,2})\s*[:\-]?\s*/gi, '\n- ');

  // Tidy
  out = out
    .replace(/^[\s\n]+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^-\s*$/gm, '')
    .trim();

  return out;
}
