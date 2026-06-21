/**
 * Multi-part maths questions (take-home feedback) — shared types + validation.
 *
 * A maths feedback_task may carry an ordered `parts` array: sub-questions
 * (a)(b)(c) of ONE question, each worked + diagnosed separately, with "Hence"
 * parts seeing earlier ones. The shared stem stays in tasks.question.
 *
 * Distinct from lib/exam-questions.ts (a FLAT list of independent exam
 * questions + MC). Here every part is fully visible text; the only hidden
 * things are the per-part marking_guideline + worked_solution — the marker's
 * instruments, stripped from student reads by studentPartsView (the chokepoint
 * applied at every student-facing task read, like exam-questions' studentTaskView).
 *
 * See docs/maths-overhaul-plan.md §#2.
 */

export interface MathsPart {
  id: string;
  /** Free text — "(a)", "(b)(i)". Auto-filled (a)(b)(c)… when blank. */
  label: string;
  text: string;
  /** Optional per-part marks (feedback tasks don't require them). */
  marks?: number;
  /** Optional. Hidden from students until their submission is graded. */
  marking_guideline?: string;
  /** Optional. The per-part correctness anchor — NEVER sent to students. */
  worked_solution?: string;
}

export const MAX_PARTS = 12;
const MAX_PART_TEXT = 5000;
const MAX_LABEL = 40;
const MAX_HIDDEN = 8000;
const MAX_MARKS = 1000;

export interface ValidatedParts {
  parts: MathsPart[];
  /** Sum of per-part marks when any are present, else null. */
  totalMarks: number | null;
}

/** (a), (b), … (z), (aa), … — positional fallback label. */
function autoLabel(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `(${s})`;
}

/**
 * Validate + normalise a client-supplied `parts` array. Returns the normalised
 * parts (stable ids, auto-filled labels, trimmed hidden fields) plus the summed
 * total marks (null if no part carried marks), or `{ error }` for a 400.
 */
export function validateMathsParts(raw: unknown): { error: string } | ValidatedParts {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'A multi-part question needs at least one part.' };
  }
  if (raw.length > MAX_PARTS) {
    return { error: `A question can have at most ${MAX_PARTS} parts.` };
  }

  const seen = new Set<string>();
  const out: MathsPart[] = [];
  let anyMarks = false;
  let totalMarks = 0;

  for (let i = 0; i < raw.length; i++) {
    const p: any = raw[i];
    const n = i + 1;

    const id = typeof p?.id === 'string' ? p.id.trim() : '';
    if (!id) return { error: `Part ${n} is missing an id.` };
    if (seen.has(id)) return { error: `Part ${n} has a duplicate id.` };
    seen.add(id);

    const label = typeof p?.label === 'string' ? p.label.trim() : '';
    if (label.length > MAX_LABEL) return { error: `Part ${n} label is too long.` };

    const text = typeof p?.text === 'string' ? p.text.trim() : '';
    if (!text) return { error: `Part ${n} needs question text.` };
    if (text.length > MAX_PART_TEXT) return { error: `Part ${n} is too long.` };

    const part: MathsPart = { id, label: label || autoLabel(i), text };

    if (p?.marks !== undefined && p?.marks !== null && p?.marks !== '') {
      const marks = Number(p.marks);
      if (!Number.isFinite(marks) || marks <= 0 || marks > MAX_MARKS) {
        return { error: `Part ${n} has an invalid mark value.` };
      }
      part.marks = marks;
      anyMarks = true;
      totalMarks += marks;
    }

    const mg = typeof p?.marking_guideline === 'string' ? p.marking_guideline.trim() : '';
    if (mg) {
      if (mg.length > MAX_HIDDEN) return { error: `Part ${n} marking guideline is too long.` };
      part.marking_guideline = mg;
    }
    const ws = typeof p?.worked_solution === 'string' ? p.worked_solution.trim() : '';
    if (ws) {
      if (ws.length > MAX_HIDDEN) return { error: `Part ${n} worked solution is too long.` };
      part.worked_solution = ws;
    }

    out.push(part);
  }

  return { parts: out, totalMarks: anyMarks ? totalMarks : null };
}

/**
 * Return a copy of `parts` safe to send to a student. Allowlist of student-safe
 * fields only (id/label/text/marks), so a future hidden field can't leak by
 * accident:
 *   - worked_solution: removed ALWAYS (the correctness anchor; never shown).
 *   - marking_guideline: removed pre-grading; revealed once the student's
 *     submission is graded (mirrors the single-question marking-guideline reveal).
 */
export function studentPartsView(parts: unknown, opts?: { isGraded?: boolean }): MathsPart[] {
  if (!Array.isArray(parts)) return [];
  const reveal = !!(opts && opts.isGraded);
  return parts.map((p: any) => {
    const out: MathsPart = {
      id: typeof p?.id === 'string' ? p.id : '',
      label: typeof p?.label === 'string' ? p.label : '',
      text: typeof p?.text === 'string' ? p.text : '',
    };
    if (typeof p?.marks === 'number') out.marks = p.marks;
    if (reveal && typeof p?.marking_guideline === 'string') out.marking_guideline = p.marking_guideline;
    // worked_solution is never included.
    return out;
  });
}
