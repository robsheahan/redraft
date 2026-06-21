/**
 * Smoke test for lib/maths-verify.ts (the Phase 2 equivalence engine).
 * Run: npx tsx scripts/maths-verify-smoke-test.ts
 *
 * Asserts correct verdicts AND — load-bearing — that unsupported expressions
 * return 'unknown' rather than a wrong guess.
 */
import { checkEquivalence } from '../lib/maths-verify.js';

let pass = 0, fail = 0;
function t(a: string, b: string, expect: string) {
  const r = checkEquivalence(a, b);
  if (r.verdict === expect) { pass++; }
  else { fail++; console.error(`  ✗ ${expect} expected, got ${r.verdict}:  ${a}  ⟷  ${b}`); }
}

// Equivalent
t('(x+2)^2', 'x^2+4x+4', 'equivalent');
t('\\frac{6x+2}{2}', '3x+1', 'equivalent');
t('2(x-3)', '2x-6', 'equivalent');
t('(x+1)(x-1)', 'x^2-1', 'equivalent');
t('\\frac{x^2-1}{x-1}', 'x+1', 'equivalent');
t('3x \\cdot 2', '6x', 'equivalent');
t('-(x-5)', '5-x', 'equivalent');
t('x^{2}+2xy+y^{2}', '(x+y)^2', 'equivalent');
t('6(1)+2', '8', 'equivalent');
// Not equivalent
t('(x+2)^2', 'x^2+4', 'not_equivalent');
t('6x+2', '6x', 'not_equivalent');
t('2(x-3)', '2x-3', 'not_equivalent');
t('\\frac{x+4}{2}', 'x+2', 'not_equivalent');
t('x^2', '2x', 'not_equivalent');
// Unknown (safety — must refuse to guess)
t('\\sin x', '\\sin x', 'unknown');
t('\\sqrt{x}', 'x^{1/2}', 'unknown');
t('\\ln x', '\\ln x', 'unknown');
t('x_1+1', 'x_1+1', 'unknown');
t('6x+2=0', 'x=-1/3', 'unknown');
t('|x|', 'x', 'unknown');

console.log(`maths-verify smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
