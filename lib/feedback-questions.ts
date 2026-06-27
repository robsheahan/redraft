/**
 * Multi-question take-home assessments (feedback_task, essay) — shared types +
 * server-side validation.
 *
 * A feedback_task (essay subject) may carry an ordered `questions` array instead
 * of a single scalar `question`. Each question is a written response with its
 * OWN optional marking criteria, and the student gets per-question AI feedback
 * whose depth scales to the question's marks (see lib/multi-question-feedback.ts).
 *
 * Distinct from lib/exam-questions.ts (which owns the marked_task exam variant).
 * The two share the `tasks.questions` jsonb column and the `submissions.answers`
 * shape; which validator runs is decided by `task_mode` in api/task.ts. Feedback
 * questions are either:
 *   - `text`: a written response with its own optional marking criteria → gets
 *     AI feedback (criteria are shown to the student); or
 *   - `multiple_choice`: options + a hidden `correct_option_id` (the answer key,
 *     stripped from students pre-grading by studentTaskView, then revealed in the
 *     per-question feedback) → auto-marked, no LLM call.
 *
 * See PROJECT_OVERVIEW.md (multi-question take-home) + the maths multi-part
 * precedent in lib/maths-parts.ts.
 */

import type { ExamAttachment, ExamOption } from './exam-questions.js';

export interface FeedbackQuestion {
  id: string;
  type: 'text' | 'multiple_choice';
  text: string;
  /** Required — shown to students, drives teacher marking + AGS, and (text only)
   *  selects the per-question feedback depth (short-answer vs extended). */
  marks: number;
  /** text only — optional per-question rubric. When present, that question runs
   *  the criterion-by-criterion pass against it. Raw text, parsed client-side. */
  criteria_text?: string;
  /** Optional per-question stimulus files (sources, data tables). */
  attachments: ExamAttachment[];
  /** multiple_choice only — 2–6 answer options (stable ids). */
  options?: ExamOption[];
  /** multiple_choice only — the answer key. Never sent to students pre-grading. */
  correct_option_id?: string;
}

export const MAX_FEEDBACK_QUESTIONS = 8;
const MAX_QUESTION_TEXT = 5000;
const MAX_CRITERIA_TEXT = 5000;
const MAX_ATTACHMENTS = 3;
const MAX_MARKS = 1000;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_OPTION_TEXT = 1000;

/** Coerce a client attachment list to the stored shape (mirrors exam-questions). */
function cleanAttachments(raw: unknown): ExamAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_ATTACHMENTS)
    .map((a: any) => ({
      path: String(a?.path || ''),
      name: String(a?.name || ''),
      content_type: String(a?.content_type || ''),
      size: Number(a?.size) || 0,
    }))
    .filter((a) => a.path);
}

export interface ValidatedFeedbackQuestions {
  questions: FeedbackQuestion[];
  totalMarks: number;
}

/**
 * Validate + normalise a client-supplied feedback `questions` array. Returns the
 * normalised questions (stable ids, trimmed criteria, clean attachments) plus
 * the summed total_marks, or `{ error }` for a 400.
 *
 * Per-question marks are required: they drive teacher marking / AGS and select
 * the feedback depth. The task's total_marks is the derived sum, never an
 * independent client value.
 */
export function validateFeedbackQuestions(raw: unknown): { error: string } | ValidatedFeedbackQuestions {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'A multi-question assessment must have at least one question.' };
  }
  if (raw.length > MAX_FEEDBACK_QUESTIONS) {
    return { error: `A take-home assessment can have at most ${MAX_FEEDBACK_QUESTIONS} questions.` };
  }

  const seen = new Set<string>();
  const out: FeedbackQuestion[] = [];
  let totalMarks = 0;

  for (let i = 0; i < raw.length; i++) {
    const q: any = raw[i];
    const n = i + 1;

    const id = typeof q?.id === 'string' ? q.id.trim() : '';
    if (!id) return { error: `Question ${n} is missing an id.` };
    if (seen.has(id)) return { error: `Question ${n} has a duplicate id.` };
    seen.add(id);

    const text = typeof q?.text === 'string' ? q.text.trim() : '';
    if (!text) return { error: `Question ${n} needs question text.` };
    if (text.length > MAX_QUESTION_TEXT) return { error: `Question ${n} is too long.` };

    const marks = Number(q?.marks);
    if (!Number.isFinite(marks) || marks <= 0 || marks > MAX_MARKS) {
      return { error: `Question ${n} needs a mark value greater than zero.` };
    }

    const type: 'text' | 'multiple_choice' = q?.type === 'multiple_choice' ? 'multiple_choice' : 'text';
    const attachments = cleanAttachments(q?.attachments);

    if (type === 'multiple_choice') {
      const rawOptions = Array.isArray(q?.options) ? q.options : [];
      if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
        return { error: `Question ${n} needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.` };
      }
      const seenOptionIds = new Set<string>();
      const options: ExamOption[] = [];
      for (const o of rawOptions) {
        const oid = typeof o?.id === 'string' ? o.id.trim() : '';
        const otext = typeof o?.text === 'string' ? o.text.trim() : '';
        if (!oid) return { error: `Question ${n} has an option missing an id.` };
        if (seenOptionIds.has(oid)) return { error: `Question ${n} has a duplicate option id.` };
        if (!otext) return { error: `Question ${n} has an empty option.` };
        if (otext.length > MAX_OPTION_TEXT) return { error: `Question ${n} has an option that is too long.` };
        seenOptionIds.add(oid);
        options.push({ id: oid, text: otext });
      }
      const correct = typeof q?.correct_option_id === 'string' ? q.correct_option_id.trim() : '';
      if (!correct || !seenOptionIds.has(correct)) {
        return { error: `Question ${n} needs a correct answer selected.` };
      }
      out.push({ id, type, text, marks, attachments, options, correct_option_id: correct });
    } else {
      const question: FeedbackQuestion = { id, type: 'text', text, marks, attachments };
      const criteria = typeof q?.criteria_text === 'string' ? q.criteria_text.trim() : '';
      if (criteria) {
        if (criteria.length > MAX_CRITERIA_TEXT) return { error: `Question ${n} criteria are too long.` };
        question.criteria_text = criteria;
      }
      out.push(question);
    }

    totalMarks += marks;
  }

  return { questions: out, totalMarks };
}

/** True when a task's stored `questions` array is the feedback (take-home)
 *  variant rather than the exam variant. The discriminator is task_mode: only
 *  feedback questions live on a feedback_task. */
export function isFeedbackQuestionsTask(task: { task_mode?: string | null; questions?: unknown }): boolean {
  return task?.task_mode === 'feedback_task'
    && Array.isArray(task.questions)
    && task.questions.length > 0;
}
