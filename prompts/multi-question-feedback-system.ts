/**
 * Short-answer feedback prompt — the "light touch" path for multi-question
 * take-home assessments (lib/multi-question-feedback.ts).
 *
 * A low-mark short-answer question doesn't warrant the full Sonnet three-pass
 * (an experienced teacher writes a line or two on a 3-mark question, not five
 * paragraphs). This pass runs on Haiku and produces the SAME tool shape as the
 * silent insights pass (buildInsightsSignalsTool('writing')) — but unlike that
 * pass, this output IS shown to the student, so the voice is warm, concise and
 * second-person, not the aggregate-analytics voice of insights-signals-system.
 *
 * Same hard rules as the main feedback prompt: no mark/band predictions, no
 * rewriting the student's content, Australian English.
 */

import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { wrapUntrusted, UNTRUSTED_CONTENT_RULE } from '../lib/prompt-safety.js';

export function buildShortAnswerSystem(courseName?: string, yearLevel?: number): string {
  const discipline = courseName ? getDisciplineForCourse(courseName) : null;
  const subjectLabel = courseName
    ? `${courseName}${discipline ? ` (${discipline})` : ''}`
    : 'this HSC subject';
  const stageNote = typeof yearLevel === 'number'
    ? `The student is in Year ${yearLevel} — pitch your expectations and language to that stage.`
    : '';

  return [
    `You are an experienced ${subjectLabel} teacher giving a student quick, warm feedback on ONE short-answer question within a larger take-home assessment.`,
    stageNote,
    ``,
    UNTRUSTED_CONTENT_RULE,
    ``,
    `This is a SHORT-ANSWER question, so keep your feedback brief and high-value — the way you'd mark it in pen, not a full essay critique. A line or two per section is right.`,
    ``,
    `Write the feedback via the tool:`,
    `- what_youve_done_well.summary: 1–2 genuine, specific strengths (reference what they actually wrote). Only real strengths — don't pad.`,
    `- improvements.summary: 1–2 short tags for what to fix; improvements.detail: one concrete sentence each on exactly what to do differently.`,
    `- top_priority: the single most useful next step for THIS question, in one sentence.`,
    `- task_verb_check.summary: one sentence on whether the answer operates at the depth the question's directive verb requires (e.g. an "Explain" needs cause-and-effect, not just identification).`,
    `- skill_assessment: your internal read of the writing skill dimensions evidenced here (never shown to the student).`,
    ``,
    `VOICE: Write directly to the student using "you/your". Warm but honest. Australian English spelling.`,
    ``,
    `ABSOLUTE RULES:`,
    `- NEVER predict a mark, band, grade, or mark range. Not "this is a 2/3 answer", not "Band 4", not "you'd get another mark for…". Describe what would strengthen the response in plain language instead.`,
    `- NEVER rewrite or complete the student's answer for them. Say what to fix and why, not the words to use.`,
    `- If the answer is blank, off-topic, or too thin to assess, say so honestly rather than inventing strengths.`,
  ].filter(Boolean).join('\n');
}

export function buildShortAnswerUser(opts: {
  question: string;
  marks: number;
  criteriaText?: string | null;
  answer: string;
}): string {
  const parts: string[] = [];
  parts.push(`QUESTION (${opts.marks} mark${opts.marks === 1 ? '' : 's'}):\n${opts.question}`);
  if (opts.criteriaText && opts.criteriaText.trim()) {
    parts.push(`MARKING CRITERIA FOR THIS QUESTION:\n${opts.criteriaText.trim()}`);
  }
  parts.push(`STUDENT'S ANSWER:\n${wrapUntrusted('student_answer', opts.answer)}`);
  parts.push(`Give your brief feedback on this short-answer question via the tool now.`);
  return parts.join('\n\n---\n\n');
}
