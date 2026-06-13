/**
 * Build a multi-question exam submission from the task's questions and the
 * client-supplied answers. Pure + server-side:
 *   - snapshots question_text + marks + type into each stored answer (so the
 *     submission stays self-describing even if the task is later edited),
 *   - auto-marks multiple-choice questions by comparing the student's selection
 *     to the task's `correct_option_id` (writing `question_marks` rows with
 *     source:'auto'); text questions are left for the teacher to mark,
 *   - returns an MC tally for the (unstored) Haiku context line.
 *
 * Correctness is NEVER written into the stored answers or the transcript — it
 * lives only in `question_marks`, which is stripped from student-facing payloads
 * until graded. See docs/multi-question-exam-plan.md §5.
 */

import type { ExamQuestion } from './exam-questions.js';
import type { ExamAnswer } from './exam-transcript.js';

const MAX_ANSWER_CHARS = 50_000;

export interface QuestionMark {
  question_id: string;
  mark: number;
  source: 'auto' | 'teacher';
}

export interface ProcessedExam {
  /** stored on submissions.answers (parallel to task.questions, in order) */
  answers: ExamAnswer[];
  /** MC auto-mark rows for submissions.question_marks; null if the exam has no MC */
  questionMarks: QuestionMark[] | null;
  /** whether any answer carried content (used to reject an entirely empty submit) */
  hasContent: boolean;
  mcCorrect: number;
  mcTotal: number;
}

function clampCutoff(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null;
  return Math.min(v, max);
}

export function processExamAnswers(questions: ExamQuestion[], clientAnswers: unknown): ProcessedExam {
  const byId = new Map<string, any>();
  if (Array.isArray(clientAnswers)) {
    for (const a of clientAnswers) {
      if (a && typeof a.question_id === 'string') byId.set(a.question_id, a);
    }
  }

  const answers: ExamAnswer[] = [];
  const questionMarks: QuestionMark[] = [];
  let hasContent = false;
  let mcCorrect = 0;
  let mcTotal = 0;

  for (const q of questions) {
    const a = byId.get(q.id) || {};

    if (q.type === 'multiple_choice') {
      mcTotal += 1;
      const opts = q.options || [];
      const requested = typeof a.selected_option_id === 'string' ? a.selected_option_id : null;
      // A selection that doesn't match an option is treated as no answer (a
      // tampered client can't break marking — it just scores zero).
      const match = requested ? opts.find((o) => o.id === requested) : null;
      const selectedId = match ? match.id : null;
      if (selectedId) hasContent = true;
      answers.push({
        question_id: q.id,
        question_text: q.text,
        marks: q.marks,
        type: 'multiple_choice',
        selected_option_id: selectedId,
        selected_option_text: match ? match.text : null,
      });
      const correct = selectedId != null && selectedId === q.correct_option_id;
      if (correct) mcCorrect += 1;
      questionMarks.push({ question_id: q.id, mark: correct ? q.marks : 0, source: 'auto' });
    } else {
      const text = typeof a.text === 'string' ? a.text.trim().slice(0, MAX_ANSWER_CHARS) : '';
      if (text) hasContent = true;
      answers.push({
        question_id: q.id,
        question_text: q.text,
        marks: q.marks,
        type: 'text',
        text,
        over_time_cutoff_index: clampCutoff(a.over_time_cutoff_index, text.length),
      });
    }
  }

  return {
    answers,
    questionMarks: questionMarks.length ? questionMarks : null,
    hasContent,
    mcCorrect,
    mcTotal,
  };
}

/**
 * Merge a teacher's per-text-question marks with the stored MC auto-marks and
 * compute the exam total. Teachers mark TEXT questions only; the MC rows
 * (source:'auto') are preserved untouched. Returns the merged marks + total, or
 * `{ error }` for a 400 (invalid question, or a mark out of range).
 */
export function mergeExamGrade(
  answers: any[],
  storedQuestionMarks: unknown,
  teacherMarks: unknown,
): { error: string } | { questionMarks: QuestionMark[]; total: number } {
  const answerById = new Map<string, any>(answers.map((a) => [a.question_id, a]));
  const stored = Array.isArray(storedQuestionMarks) ? storedQuestionMarks : [];
  const autoRows = stored.filter((m: any) => m && m.source === 'auto');

  const teacherRows: QuestionMark[] = [];
  const seen = new Set<string>();
  for (const m of (Array.isArray(teacherMarks) ? teacherMarks : [])) {
    const qid = m && typeof m.question_id === 'string' ? m.question_id : null;
    if (!qid || seen.has(qid)) continue;
    const ans = answerById.get(qid);
    if (!ans || ans.type !== 'text') continue; // teachers mark text questions only
    const mark = Number(m.mark);
    if (!Number.isFinite(mark) || mark < 0) {
      return { error: 'Marks must be zero or greater.' };
    }
    if (typeof ans.marks === 'number' && mark > ans.marks) {
      return { error: `A mark can't exceed the ${ans.marks} available for that question.` };
    }
    seen.add(qid);
    teacherRows.push({ question_id: qid, mark, source: 'teacher' });
  }

  const questionMarks = [...autoRows, ...teacherRows];
  const total = questionMarks.reduce((s, m) => s + (typeof m.mark === 'number' ? m.mark : 0), 0);
  return { questionMarks, total };
}
