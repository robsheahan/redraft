/**
 * Extract NESA task verbs from a question string.
 *
 * Multi-word verbs (e.g. "critically analyse") are matched before their
 * single-word parts so the longer match wins. Returns verbs in the order they
 * appear in the question.
 */

// Multi-word verbs must come first so they match before their single-word parts
export const TASK_VERBS = [
  'compare and contrast', 'critically analyse', 'critically evaluate', 'account for',
  'analyse', 'analyze', 'appreciate', 'apply', 'assess',
  'calculate', 'clarify', 'classify', 'compare', 'construct', 'contrast',
  'deduce', 'demonstrate', 'describe', 'discuss', 'distinguish',
  'evaluate', 'examine', 'explain', 'extract', 'extrapolate',
  'identify', 'interpret', 'investigate', 'justify',
  'outline', 'predict', 'propose', 'recommend', 'recount',
];

export function extractTaskVerbs(question: string): string[] {
  const qLower = question.toLowerCase();

  const found: { verb: string; index: number }[] = [];
  for (const v of TASK_VERBS) {
    const idx = qLower.indexOf(v);
    if (idx !== -1) found.push({ verb: v, index: idx });
  }

  if (found.length === 0) return [];

  // Remove single-word verbs that are part of a matched multi-word verb
  const filtered = found.filter(f => {
    return !found.some(other =>
      other.verb !== f.verb &&
      other.verb.length > f.verb.length &&
      other.verb.includes(f.verb)
    );
  });

  const seen = new Set<string>();
  return filtered
    .sort((a, b) => a.index - b.index)
    .filter(f => {
      if (seen.has(f.verb)) return false;
      seen.add(f.verb);
      return true;
    })
    .map(f => f.verb);
}
