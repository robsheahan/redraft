/**
 * Multi-question take-home assessments (feedback_task, essay) — shared types +
 * server-side validation.
 *
 * A feedback_task (essay subject) may carry an ordered `questions` array instead
 * of a single scalar `question`. Each question is a written response with its
 * OWN optional marking criteria, and the student gets per-question AI feedback
 * whose depth scales to the question's marks (see lib/multi-question-feedback.ts).
 *
 * Distinct from lib/exam-questions.ts (which owns the marked_task exam variant:
 * a flat list of text + multiple-choice questions with a hidden answer key). The
 * two share the `tasks.questions` jsonb column and the `submissions.answers`
 * shape; which validator runs is decided by `task_mode` in api/task.ts. Feedback
 * questions are text-only (no MC) and carry NOTHING hidden — the per-question
 * criteria are meant to be shown to the student (live criterion feedback is the
 * whole point), so there is no student-facing strip the way exams need one.
 *
 * See PROJECT_OVERVIEW.md (multi-question take-home) + the maths multi-part
 * precedent in lib/maths-parts.ts.
 */

import type { ExamAttachment } from './exam-questions.js';

export interface FeedbackQuestion {
  id: string;
  /** Text only in v1 (MC has no formative-feedback meaning — deferred). */
  type: 'text';
  text: string;
  /** Required — shown to students, drives teacher marking + AGS, and selects
   *  the per-question feedback depth (short-answer vs extended response). */
  marks: number;
  /** Optional per-question rubric. When present, that question runs the
   *  criterion-by-criterion pass against it; when absent, holistic + inline
   *  only. Raw text — the renderer parses it client-side, like task criteria. */
  criteria_text?: string;
  /** Optional per-question stimulus files (sources, data tables). */
  attachments: ExamAttachment[];
}

export const MAX_FEEDBACK_QUESTIONS = 8;
const MAX_QUESTION_TEXT = 5000;
const MAX_CRITERIA_TEXT = 5000;
const MAX_ATTACHMENTS = 3;
const MAX_MARKS = 1000;

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

    const question: FeedbackQuestion = {
      id,
      type: 'text',
      text,
      marks,
      attachments: cleanAttachments(q?.attachments),
    };

    const criteria = typeof q?.criteria_text === 'string' ? q.criteria_text.trim() : '';
    if (criteria) {
      if (criteria.length > MAX_CRITERIA_TEXT) return { error: `Question ${n} criteria are too long.` };
      question.criteria_text = criteria;
    }

    out.push(question);
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
