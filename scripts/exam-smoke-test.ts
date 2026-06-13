/**
 * Multi-question exam — pure-logic smoke test (no DB, no network).
 * Exercises the full server-side chain: validate authored questions → process a
 * student submission (text + MC auto-mark + over-time) → serialise the stored
 * transcript → merge a teacher grade and compute the total.
 *
 * Run: npx tsx scripts/exam-smoke-test.ts
 */

import { validateExamQuestions, studentTaskView } from '../lib/exam-questions.js';
import { processExamAnswers, mergeExamGrade } from '../lib/exam-submission.js';
import { serializeExamAnswers } from '../lib/exam-transcript.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
}

// ---- 1. Validation -------------------------------------------------------
const v = validateExamQuestions([
  { id: 'q1', type: 'text', text: 'Outline TWO factors.', marks: 3, attachments: [] },
  { id: 'q2', type: 'multiple_choice', text: 'Which is correct?', marks: 1,
    options: [{ id: 'o1', text: 'Alpha' }, { id: 'o2', text: 'Beta' }], correct_option_id: 'o2' },
  { id: 'q3', type: 'text', text: 'Analyse how X.', marks: 8, attachments: [] },
]);
check('valid exam accepted', !('error' in v));
const questions = ('error' in v) ? [] : v.questions;
check('total_marks summed = 12', !('error' in v) && v.totalMarks === 12, ('error' in v) ? v : v.totalMarks);

const badCases: Array<[string, unknown]> = [
  ['empty list rejected', []],
  ['blank text rejected', [{ id: 'q1', type: 'text', text: '   ', marks: 3 }]],
  ['zero marks rejected', [{ id: 'q1', type: 'text', text: 'x', marks: 0 }]],
  ['one MC option rejected', [{ id: 'q1', type: 'multiple_choice', text: 'x', marks: 1, options: [{ id: 'o1', text: 'a' }], correct_option_id: 'o1' }]],
  ['MC correct not an option rejected', [{ id: 'q1', type: 'multiple_choice', text: 'x', marks: 1, options: [{ id: 'o1', text: 'a' }, { id: 'o2', text: 'b' }], correct_option_id: 'zz' }]],
  ['duplicate question id rejected', [{ id: 'q1', type: 'text', text: 'a', marks: 1 }, { id: 'q1', type: 'text', text: 'b', marks: 1 }]],
];
for (const [label, input] of badCases) check(label, 'error' in (validateExamQuestions(input) as any));

// ---- 2. Submission processing -------------------------------------------
// Student answers q1 (over time), picks the correct MC option, skips q3.
const proc = processExamAnswers(questions, [
  { question_id: 'q1', text: 'Diet and exercise.', over_time_cutoff_index: 12 },
  { question_id: 'q2', selected_option_id: 'o2' },
]);
check('hasContent true', proc.hasContent);
check('MC tally 1/1', proc.mcCorrect === 1 && proc.mcTotal === 1, { c: proc.mcCorrect, t: proc.mcTotal });
check('MC auto-mark full', proc.questionMarks?.some(m => m.question_id === 'q2' && m.mark === 1 && m.source === 'auto') === true, proc.questionMarks);
check('q1 over-time cutoff preserved', proc.answers[0].over_time_cutoff_index === 12);
check('skipped q3 stored empty', proc.answers[2].text === '');

const wrong = processExamAnswers(questions, [{ question_id: 'q2', selected_option_id: 'o1' }]);
check('wrong MC scores 0', wrong.questionMarks?.find(m => m.question_id === 'q2')?.mark === 0);

const tamper = processExamAnswers(questions, [{ question_id: 'q2', selected_option_id: 'NOT-AN-OPTION' }]);
check('tampered MC → no selection, 0', tamper.answers[1].selected_option_id === null && tamper.questionMarks?.find(m => m.question_id === 'q2')?.mark === 0);

const allEmpty = processExamAnswers(questions, [{ question_id: 'q2', selected_option_id: null }]);
check('all-empty hasContent false', allEmpty.hasContent === false);

// ---- 3. Transcript: never leaks MC correctness --------------------------
const transcript = serializeExamAnswers(proc.answers);
check('transcript has no right/wrong/correct-answer marker',
  !/\bcorrect answer\b/i.test(transcript) && !/✓|✗/.test(transcript), transcript);
check('transcript shows the selected option text', transcript.includes('Selected: "Beta"'));

// ---- 4. Teacher grade merge + total -------------------------------------
// Teacher gives q1=2/3 and q3=6/8; q2 stays auto 1/1. Total = 9.
const merged = mergeExamGrade(proc.answers, proc.questionMarks, [
  { question_id: 'q1', mark: 2 },
  { question_id: 'q3', mark: 6 },
]);
check('merge ok', !('error' in merged));
check('merged total = 9', !('error' in merged) && merged.total === 9, ('error' in merged) ? merged : merged.total);
check('MC auto row preserved in merge', !('error' in merged) && merged.questionMarks.some(m => m.question_id === 'q2' && m.source === 'auto'));

// Reject a text mark over the max.
const over = mergeExamGrade(proc.answers, proc.questionMarks, [{ question_id: 'q1', mark: 99 }]);
check('over-max text mark rejected', 'error' in over);
// A teacher mark on an MC question is ignored (MC is auto only).
const mcByTeacher = mergeExamGrade(proc.answers, proc.questionMarks, [{ question_id: 'q2', mark: 0 }]);
check('teacher cannot override MC', !('error' in mcByTeacher) && mcByTeacher.questionMarks.filter(m => m.question_id === 'q2').length === 1
  && mcByTeacher.questionMarks.find(m => m.question_id === 'q2')?.source === 'auto');

// ---- 5. studentTaskView: answer-key stripping + per-student scramble ------
// A 4-option MC so scramble divergence is observable.
const mcTask: any = {
  id: 't1',
  questions: [
    { id: 'q1', type: 'text', text: 'Explain.', marks: 4, attachments: [] },
    { id: 'qm', type: 'multiple_choice', text: 'Pick one.', marks: 1,
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }],
      correct_option_id: 'c', attachments: [] },
  ],
};

const studentA = studentTaskView(mcTask, 'student-aaaa');
const studentB = studentTaskView(mcTask, 'student-bbbb');
const mcA = studentA.questions.find((q: any) => q.id === 'qm');
const mcB = studentB.questions.find((q: any) => q.id === 'qm');

check('key stripped for student A', !('correct_option_id' in mcA), Object.keys(mcA));
check('key stripped for student B', !('correct_option_id' in mcB));
check('no key anywhere in student payload', !JSON.stringify(studentA).includes('correct_option_id'));
check('all 4 options still present', mcA.options.length === 4 && new Set(mcA.options.map((o: any) => o.id)).size === 4);
check('option ids unchanged (only order scrambles)', mcA.options.map((o: any) => o.id).sort().join('') === 'abcd');

// Deterministic per student: same student → identical order across calls.
const studentA2 = studentTaskView(mcTask, 'student-aaaa');
const mcA2 = studentA2.questions.find((q: any) => q.id === 'qm');
check('same student → stable order across reloads', mcA.options.map((o: any) => o.id).join('') === mcA2.options.map((o: any) => o.id).join(''));
// Divergent across students (with these seeds the orders differ).
check('different students → different order', mcA.options.map((o: any) => o.id).join('') !== mcB.options.map((o: any) => o.id).join(''),
  { a: mcA.options.map((o: any) => o.id), b: mcB.options.map((o: any) => o.id) });

// Post-grading reveal keeps the key (and the SAME order the student sat).
const graded = studentTaskView(mcTask, 'student-aaaa', { revealAnswerKey: true });
const mcGraded = graded.questions.find((q: any) => q.id === 'qm');
check('graded reveal restores the key', mcGraded.correct_option_id === 'c');
check('graded reveal keeps the sat order', mcGraded.options.map((o: any) => o.id).join('') === mcA.options.map((o: any) => o.id).join(''));

// Non-exam task passes through untouched.
const plain = studentTaskView({ id: 'x', question: 'hi' } as any, 'student-aaaa');
check('non-exam task unchanged', (plain as any).question === 'hi');

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
if (failures > 0) process.exit(1);
