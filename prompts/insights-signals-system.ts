/**
 * Lightweight system prompt for the silent insights pass on marked_task /
 * quick_task submissions.
 *
 * Designed for Haiku — short, structured, signals-not-prose. The output is
 * never read by students; it only feeds aggregate cohort cards and the
 * student profile. So we drop the student-marker-voice tuning and ask for
 * tags that aggregate well across many submissions.
 */

import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { extractTaskVerbs } from '../lib/task-verbs.js';
import type { SkillFamily } from '../data/skill-taxonomy.js';
import { wrapUntrusted, UNTRUSTED_CONTENT_RULE } from '../lib/prompt-safety.js';

export function buildInsightsSignalsPrompt(opts: {
  course: string | null;
  question: string;
  draft: string;
  family?: SkillFamily;
}): { system: string; user: string } {
  const isMaths = opts.family === 'maths';
  const subjectLabel = opts.course
    ? `${opts.course} (${getDisciplineForCourse(opts.course) || 'general'})`
    : 'general HSC';
  const verbs = extractTaskVerbs(opts.question || '');
  const verb = verbs.length > 0 ? verbs[0] : '(directive verb not detected)';

  const system = isMaths ? [
    `You are extracting structured insights signals from a student's HSC-stage mathematics working for school-level analytics. This output is NEVER shown to the student — it feeds aggregate cohort patterns of what students struggle with and do well.`,
    ``,
    UNTRUSTED_CONTENT_RULE,
    ``,
    `Subject: ${subjectLabel} (mathematics)`,
    `The submission is the student's typed working, line by line (the math on each step plus a short reason).`,
    ``,
    `RULES:`,
    `- Assess the maths skill dimensions in the tool (method selection, reasoning/justification, accuracy, notation/communication, etc.) from the working.`,
    `- Produce concise, pattern-friendly signals. Good: "Sets up the integral but omits the constant of integration." Bad: "On line 3 you forgot +C."`,
    `- task_verb_check: one sentence on whether the working shows the reasoning/justification the task expects (e.g. a "Show that" needs each step justified).`,
    `- Do NOT predict marks or bands.`,
    `- Do NOT rewrite or complete the student's working.`,
    `- If the working is very short or off-task, name that honestly rather than fabricating.`,
  ].join('\n') : [
    `You are extracting structured insights signals from a student's HSC-stage draft for school-level analytics. This output is NEVER shown to the student — it feeds aggregate cohort patterns showing what students struggle with, what they do well, and how they handle directive verbs.`,
    ``,
    UNTRUSTED_CONTENT_RULE,
    ``,
    `Subject: ${subjectLabel}`,
    `Primary directive verb in the task: ${verb}`,
    ``,
    `RULES:`,
    `- Produce concise, pattern-friendly signals via the tool.`,
    `- Phrases must aggregate well across the cohort. Good: "Statistics used as decoration, not evidence." Bad: "I noticed in your third paragraph you cited a statistic without integrating it."`,
    `- Use NESA marker vocabulary where it sharpens the point.`,
    `- Do NOT predict marks or bands.`,
    `- Do NOT rewrite the student's content.`,
    `- If the draft is very short or off-topic, name that pattern honestly rather than fabricating themes.`,
  ].join('\n');

  const user =
    `Task question:\n${opts.question}\n\n` +
    `${isMaths ? 'Student working' : 'Student draft'}:\n${wrapUntrusted(isMaths ? 'student_working' : 'student_draft', opts.draft)}\n\n` +
    `Produce the insights signals via the tool now.`;

  return { system, user };
}
