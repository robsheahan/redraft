/**
 * Smoke test for lib/maths-parts.ts. Run: npx tsx scripts/maths-parts-smoke-test.ts
 */
import { validateMathsParts, studentPartsView, MAX_PARTS, type MathsPart } from '../lib/maths-parts.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', name); }
}

// --- validateMathsParts ---
const good = validateMathsParts([
  { id: 'p1', label: '(a)', text: 'Differentiate f(x)=3x^2.', marks: 2, worked_solution: "f'(x)=6x" },
  { id: 'p2', text: 'Hence find the gradient at x=1.', marks: 1, marking_guideline: '- sub x=1 (1)' },
]);
check('good parts validate', !('error' in good));
if (!('error' in good)) {
  check('two parts returned', good.parts.length === 2);
  check('total marks summed', good.totalMarks === 3);
  check('blank label auto-filled to (b)', good.parts[1].label === '(b)');
  check('explicit label kept', good.parts[0].label === '(a)');
  check('worked_solution retained in validated (server-side)', good.parts[0].worked_solution === "f'(x)=6x");
  check('marking_guideline retained in validated', good.parts[1].marking_guideline === '- sub x=1 (1)');
}

// no marks anywhere → totalMarks null
const noMarks = validateMathsParts([{ id: 'a', text: 'x' }]);
check('no marks → totalMarks null', !('error' in noMarks) && noMarks.totalMarks === null);

// --- error cases ---
check('empty array rejected', 'error' in validateMathsParts([]));
check('non-array rejected', 'error' in validateMathsParts('nope' as any));
check('missing text rejected', 'error' in validateMathsParts([{ id: 'a', text: '' }]));
check('missing id rejected', 'error' in validateMathsParts([{ text: 'x' }]));
check('duplicate id rejected', 'error' in validateMathsParts([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]));
check('too many parts rejected', 'error' in validateMathsParts(
  Array.from({ length: MAX_PARTS + 1 }, (_, i) => ({ id: 'p' + i, text: 'x' }))));
check('negative marks rejected', 'error' in validateMathsParts([{ id: 'a', text: 'x', marks: -1 }]));

// --- studentPartsView (the security chokepoint) ---
const authored: MathsPart[] = [
  { id: 'p1', label: '(a)', text: 'Q', marks: 2, marking_guideline: 'GUIDE_SECRET', worked_solution: 'SOLN_SECRET' },
];
const preGrade = studentPartsView(authored, { isGraded: false });
const postGrade = studentPartsView(authored, { isGraded: true });

check('pre-grade: worked_solution stripped', !('worked_solution' in preGrade[0]));
check('pre-grade: marking_guideline stripped', !('marking_guideline' in preGrade[0]));
check('pre-grade: no SECRET strings leak', !JSON.stringify(preGrade).includes('SECRET'));
check('pre-grade: keeps label/text/marks', preGrade[0].label === '(a)' && preGrade[0].text === 'Q' && preGrade[0].marks === 2);
check('post-grade: worked_solution STILL stripped', !('worked_solution' in postGrade[0]) && !JSON.stringify(postGrade).includes('SOLN_SECRET'));
check('post-grade: marking_guideline revealed', postGrade[0].marking_guideline === 'GUIDE_SECRET');
check('studentPartsView tolerates non-array', Array.isArray(studentPartsView(null)) && studentPartsView(null).length === 0);

console.log(`\nmaths-parts smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
