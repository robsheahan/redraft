/**
 * Multi-question in-class exams — shared types + server-side validation.
 *
 * A marked_task (essay subject) may carry an ordered `questions` array instead
 * of a single scalar `question`. Each question is text or multiple-choice. This
 * file owns the question/answer/mark types and the create/update validator used
 * by api/task.ts.
 *
 * The MC answer key (`correct_option_id`) is preserved here and stored on the
 * task. It is the highest-severity thing in the feature: it must NEVER reach a
 * student client pre-grading. Stripping + per-student option scrambling are
 * applied by `studentTaskView` (added in the MC step) at every student-facing
 * read; this file's job is only to validate the authored shape.
 *
 * See docs/multi-question-exam-plan.md.
 */

export type ExamQuestionType = 'text' | 'multiple_choice';

export interface ExamOption {
  id: string;
  text: string;
}

export interface ExamAttachment {
  path: string;
  name: string;
  content_type: string;
  size: number;
}

export interface ExamQuestion {
  id: string;
  type: ExamQuestionType;
  text: string;
  marks: number;
  attachments: ExamAttachment[];
  /** multiple_choice only */
  options?: ExamOption[];
  /** multiple_choice only — the answer key. Never sent to students pre-grading. */
  correct_option_id?: string;
}

export const MAX_QUESTIONS = 20;
const MAX_QUESTION_TEXT = 5000;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_OPTION_TEXT = 1000;
const MAX_ATTACHMENTS = 3;
const MAX_MARKS = 1000;

/** Coerce a client attachment list to the stored shape (mirrors teacher_attachments). */
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

export interface ValidatedQuestions {
  questions: ExamQuestion[];
  totalMarks: number;
}

/**
 * Validate + normalise a client-supplied `questions` array. Returns the
 * normalised questions (stable ids, clean attachments, validated MC options)
 * plus the summed total_marks, or `{ error }` for a 400.
 *
 * Per-question marks are required (a real exam paper always shows them); the
 * task's total_marks is the derived sum, never an independent client value.
 */
export function validateExamQuestions(raw: unknown): { error: string } | ValidatedQuestions {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'An exam must have at least one question.' };
  }
  if (raw.length > MAX_QUESTIONS) {
    return { error: `An exam can have at most ${MAX_QUESTIONS} questions.` };
  }

  const seenQuestionIds = new Set<string>();
  const out: ExamQuestion[] = [];
  let totalMarks = 0;

  for (let i = 0; i < raw.length; i++) {
    const q: any = raw[i];
    const n = i + 1;

    const id = typeof q?.id === 'string' ? q.id.trim() : '';
    if (!id) return { error: `Question ${n} is missing an id.` };
    if (seenQuestionIds.has(id)) return { error: `Question ${n} has a duplicate id.` };
    seenQuestionIds.add(id);

    const text = typeof q?.text === 'string' ? q.text.trim() : '';
    if (!text) return { error: `Question ${n} needs question text.` };
    if (text.length > MAX_QUESTION_TEXT) return { error: `Question ${n} is too long.` };

    const marks = Number(q?.marks);
    if (!Number.isFinite(marks) || marks <= 0 || marks > MAX_MARKS) {
      return { error: `Question ${n} needs a mark value greater than zero.` };
    }

    const type: ExamQuestionType = q?.type === 'multiple_choice' ? 'multiple_choice' : 'text';
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
      out.push({ id, type, text, marks, attachments });
    }

    totalMarks += marks;
  }

  return { questions: out, totalMarks };
}

// ---- Student-facing view: strip the answer key + scramble option order -----
//
// The single chokepoint applied at EVERY endpoint that returns task data to a
// student. It does two things the feature's security depends on:
//   1. removes `correct_option_id` from every MC question (unless the answer key
//      is being revealed post-grading), and
//   2. deterministically scrambles each MC question's option order per student,
//      so two students sitting the same exam don't see the same arrangement —
//      but one student sees a stable order across reloads and at grading time.
// The seed is pure data (studentId + questionId), never a randomness call, so it
// reproduces exactly wherever it's recomputed.

function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Return a copy of `task` safe to send to a student: MC options scrambled per
 * student, and `correct_option_id` stripped unless `revealAnswerKey` is set
 * (true only once the student's submission has been graded). Non-exam tasks and
 * non-MC questions pass through unchanged.
 */
export function studentTaskView<T extends { questions?: any }>(
  task: T,
  studentId: string,
  opts?: { revealAnswerKey?: boolean },
): T {
  if (!task || !Array.isArray(task.questions)) return task;
  const revealKey = !!(opts && opts.revealAnswerKey);
  const questions = task.questions.map((q: any) => {
    if (!q || q.type !== 'multiple_choice' || !Array.isArray(q.options)) return q;
    const options = shuffleSeeded(q.options, hashSeed(`${studentId}:${q.id}`));
    const out: any = { ...q, options };
    if (!revealKey) delete out.correct_option_id;
    return out;
  });
  return { ...task, questions };
}
