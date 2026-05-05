/**
 * Smoke test: AI rubric parser against the two real rubrics that broke
 * the regex parser earlier this session.
 *
 * Run: npx tsx test/smoke-rubric-parse.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length > 0) process.env[key.trim()] = rest.join('=').trim();
  }
} catch { /* optional */ }

import { parseRubricWithAI } from '../lib/parse-rubric-with-ai.js';

const RUBRIC_GRADE_A = `Marking Criteria
Grade A (21--25 marks) The student demonstrates an extensive knowledge and understanding of operations and marketing strategies and their relationship to the external environment.
Grade B (17--20 marks) The student demonstrates a thorough knowledge and understanding of relevant strategies across both functions.
Grade C (13--16 marks) The student demonstrates sound knowledge of operations and/or marketing strategies.
Grade D (9--12 marks) The student demonstrates basic knowledge of some relevant strategies.
Grade E (1--8 marks) The student demonstrates limited knowledge of operations or marketing strategies.`;

const RUBRIC_HITLER_FLAT = `Marking Criteria
MarksCriteria17–20Provides a sustained, well-structured analysis of both political and economic factors. Demonstrates a nuanced understanding of causation and the interplay between factors.13–16Analyses political and economic factors with generally sound reasoning.9–12Identifies and describes political and economic factors with limited analysis.5–8Describes some relevant factors with minimal analysis.1–4Attempts to address the question with limited or inaccurate information.`;

const RUBRIC_PER_CRITERION = `1. Knowledge and understanding (3 marks): Demonstrates understanding of CVD as a health priority.
2. Application of Ottawa Charter (4 marks): Applies the five action areas to CVD.
3. Analysis (2 marks): Identifies cause-effect relationships between strategies and CVD outcomes.
4. Communication (1 mark): Uses correct PDHPE terminology.`;

async function check(label: string, raw: string) {
  const t0 = Date.now();
  const parsed = await parseRubricWithAI(raw);
  const ms = Date.now() - t0;
  if (!parsed) {
    console.error(`✗ ${label} — null returned (${ms}ms)`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ ${label} — ${ms}ms, format=${parsed.format}`);
  if (parsed.format === 'band' && parsed.bands) {
    parsed.bands.forEach(b => {
      console.log(`    ${b.range}: ${(b.criteria[0] || '').slice(0, 70)}${(b.criteria[0] || '').length > 70 ? '…' : ''}`);
    });
  } else if (parsed.format === 'criterion' && parsed.criteria) {
    parsed.criteria.forEach(c => {
      console.log(`    ${c.range || '-'}: ${c.name}`);
    });
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('No ANTHROPIC_API_KEY in env');
    process.exit(1);
  }
  await check('Grade A (21--25 marks) format', RUBRIC_GRADE_A);
  await check('Flattened-table Hitler rubric', RUBRIC_HITLER_FLAT);
  await check('Per-criterion rubric (should be format=criterion)', RUBRIC_PER_CRITERION);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
