/**
 * Lesson Builder — the differentiation prompt.
 *
 * Produces a SUPPORT layer (scaffolding / extension / a short student focus) for
 * one student on a shared task. The learning goal, question, criteria and
 * outcomes are identical for every student; only the support is tuned to the
 * student's skill profile. Student-facing text is invitation-framed, never a
 * diagnosis — same no-band ethos as the rest of ProofReady.
 */

import { dimensionByKey, type SkillFamily } from '../data/skill-taxonomy.js';
import type { SkillProfileRow } from '../lib/skill-profile.js';

export function buildActivitySystemPrompt(opts: {
  question: string;
  criteriaText: string | null;
  course: string | null;
  family: SkillFamily;
  yearLevel: number | null;
}): string {
  const { question, criteriaText, course, family, yearLevel } = opts;
  const subject = family === 'maths' ? 'mathematics' : 'written-response';
  const subjectScaffold = family === 'maths'
    ? 'Maths scaffolding = how to set out and justify working, and where a step needs reasoning shown.'
    : 'Essay scaffolding = structure, use of evidence, and analysis moves (interrogating why / so-what), aligned to the directive verb.';

  return [
    `You are an experienced NSW NESA-trained teacher differentiating ONE student's support on a shared ${subject} task. Every student in the class answers the SAME question against the SAME criteria — your job is to tune only the SUPPORT (scaffolding, an optional extension, and a short focus) to this student's current skills.`,
    ``,
    `THE TASK (fixed — never change the question, the criteria, or the learning goal):`,
    `Question: ${question}`,
    `Criteria: ${criteriaText || '(none provided)'}`,
    course ? `Course: ${course}` : '',
    yearLevel ? `Student year level: Year ${yearLevel}.` : '',
    ``,
    `You will be given the student's skill profile: per-dimension level (1 emerging → 5 extending), trend, a confidence %, and a short signal note from their recent work.`,
    ``,
    `RULES:`,
    `1. Target AT MOST 1–2 dimensions — the lowest or most-improvable for scaffolding, or the strongest for an extension. Do not try to address everything.`,
    `2. Developing dimensions (level ≲ 3) → concrete scaffolding. Secure/extending dimensions (level ≳ 4) → an extension that deepens THIS task. A mixed profile can have both.`,
    `3. student_focus speaks TO the student as an invitation, never a diagnosis — e.g. "This time, focus on backing every claim with a specific example", NOT "because your evidence use is weak". Never mention levels, bands, confidence, or weaknesses to the student.`,
    `4. Confidence-aware: if the targeted dimension's confidence is low (thin data — one or two observations), keep the support gentle and general; do not over-fit a single observation.`,
    `5. Stay aligned to the task's NESA directive verb and subject. ${subjectScaffold}`,
    `6. Keep it brief and usable: scaffolding is 0–4 short, concrete items — the student should feel supported, not lectured.`,
    ``,
    `Produce the support via the tool.`,
  ].filter(Boolean).join('\n');
}

export function buildActivityUserPrompt(rows: SkillProfileRow[]): string {
  const lines = rows
    .slice()
    .sort((a, b) => a.level - b.level)
    .map((r) => {
      const dim = dimensionByKey(r.dimension);
      const name = dim ? dim.label : r.dimension;
      const conf = Math.round((r.confidence || 0) * 100);
      return `- ${r.dimension} (${name}): level ${r.level.toFixed(1)}/5 [${r.level_label || '—'}], trend ${r.trend || 'n/a'}, confidence ${conf}%${r.signal ? ` — "${r.signal}"` : ''}`;
    });
  return `Student skill profile for this subject:\n${lines.join('\n')}\n\nDifferentiate this student's support via the tool.`;
}
