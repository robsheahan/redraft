/**
 * Extract the first balanced JSON object from a string.
 *
 * Replaces the greedy regex `/\{[\s\S]*\}/` which fails when a model returns
 * extra prose after the JSON (JSON.parse errors with "Unexpected non-whitespace
 * character after JSON"). Walks character-by-character, tracks brace depth,
 * and ignores braces inside string literals.
 *
 * Returns null if no balanced object is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
