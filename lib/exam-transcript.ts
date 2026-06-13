/**
 * Server-side serializer: turn a multi-question exam submission's `answers[]`
 * into one plain-text transcript stored on `submissions.draft_text`.
 *
 * Every downstream reader consumes draft_text — the silent Haiku insights pass,
 * the longitudinal profile synthesis, insights fingerprints, CSV export — so
 * populating it the same way the maths flow serializes working_lines keeps all
 * of them unchanged (zero branching).
 *
 * IMPORTANT: the transcript can reach a pre-graded STUDENT payload (it lives on
 * the submission row), so it must never encode multiple-choice correctness —
 * only the student's own selection. The answer key stays on the task; auto marks
 * live in `submissions.question_marks`. See docs/multi-question-exam-plan.md §5.
 */

import type { ExamQuestionType } from './exam-questions.js';

export interface ExamAnswer {
  question_id: string;
  /** Snapshotted from the task at submit so the submission is self-describing. */
  question_text: string;
  marks: number;
  type: ExamQuestionType;
  /** text questions */
  text?: string;
  /** text questions: char index into `text` where post-deadline work begins */
  over_time_cutoff_index?: number | null;
  /** multiple_choice questions */
  selected_option_id?: string | null;
  selected_option_text?: string | null;
}

function marksLabel(marks: number): string {
  return `${marks} mark${marks === 1 ? '' : 's'}`;
}

/**
 * Serialize an answers array into the transcript stored on draft_text.
 * MC lines carry the selected option text only — never whether it was correct.
 */
export function serializeExamAnswers(answers: ExamAnswer[]): string {
  return answers
    .map((a, i) => {
      const n = i + 1;
      if (a.type === 'multiple_choice') {
        const sel = a.selected_option_text && a.selected_option_text.trim()
          ? `"${a.selected_option_text.trim()}"`
          : '(no answer)';
        return `Question ${n} (${marksLabel(a.marks)}, multiple choice): ${a.question_text}\nSelected: ${sel}`;
      }
      const body = a.text && a.text.trim() ? a.text.trim() : '(no answer)';
      return `Question ${n} (${marksLabel(a.marks)}): ${a.question_text}\nAnswer: ${body}`;
    })
    .join('\n\n');
}
