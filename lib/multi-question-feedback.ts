/**
 * Per-question feedback engine for multi-question take-home assessments
 * (feedback_task, essay). The orchestration + persistence lives in
 * api/generate-multi-feedback.ts; this module owns the per-question generation
 * and the cross-question skill aggregation, with no DB access.
 *
 * Feedback depth scales to the question's marks (Rob's call, 2026-06):
 *   - SHORT-ANSWER  (marks < EXTENDED_RESPONSE_MIN_MARKS): one concise Haiku
 *     pass — warm, student-facing, no inline pen-marks. Mirrors how a teacher
 *     marks a short question.
 *   - EXTENDED      (marks ≥ threshold): the full Sonnet three-pass — holistic
 *     + criterion-by-criterion (only if the question carries criteria) + inline
 *     annotations anchored to that answer. Identical to the single-question
 *     feedback flow, scoped to one question.
 *
 * Every per-question result also carries a `skill_assessment` (system-only).
 * The endpoint aggregates these PER DIMENSION into one assessment per
 * submission before calling recordSkillSignals once — see aggregateSkillAssessments.
 * (The maths multi-part flow concatenates raw, which can produce duplicate
 * (student, dimension) rows and trip a Postgres upsert cardinality error; we
 * collapse to one signal per dimension instead.)
 */

import type Anthropic from '@anthropic-ai/sdk';
import { callTool } from './anthropic-tool-call.js';
import { HOLISTIC_FEEDBACK_TOOL, CRITERIA_CHECK_TOOL, SHORT_ANSWER_FEEDBACK_TOOL } from './feedback-tools.js';
import { buildUserPrompt, buildCriteriaCheckPrompt } from '../prompts/feedback-system.js';
import { buildShortAnswerSystem, buildShortAnswerUser } from '../prompts/multi-question-feedback-system.js';
import { generateInlineSuggestions } from './generate-inline-suggestions.js';
import { looksLikeBandRubric, stripBandLabels } from './rubric-detect.js';
import { wrapUntrusted } from './prompt-safety.js';
import { extractTaskVerbs } from './task-verbs.js';
import { SKILL_LEVELS, LEVEL_VALUE } from '../data/skill-taxonomy.js';
import type { FeedbackQuestion } from './feedback-questions.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';

/**
 * Marks at or above this get the full extended-response treatment; below it,
 * the concise short-answer pass. The single tuning dial for feedback depth /
 * cost. (A future refinement could also bump a long answer to "extended"
 * regardless of marks.)
 */
export const EXTENDED_RESPONSE_MIN_MARKS = 7;

/** Normalised, render-ready feedback for one question. `skill_assessment` is
 *  system-only and is stripped by the endpoint before this is stored/returned. */
export interface QuestionFeedback {
  question_id: string;
  marks: number;
  depth: 'short' | 'extended';
  /** false when generation failed for this question (the rest of the
   *  submission still saves; the student can resubmit to retry). */
  ok: boolean;
  what_youve_done_well: { summary: string[]; detail?: string[] };
  improvements: { summary: string[]; detail?: string[] };
  top_priority: { summary: string; detail?: string };
  task_verb_check?: { summary: string; detail?: string };
  what_a_strong_response_includes?: { summary: string[] };
  self_check?: string;
  criteria_feedback?: Array<{ criterion: string; strengths: string; improvements: string }> | null;
  inline_suggestions?: any[];
  is_band_rubric?: boolean;
  /** System-only — never shown to the student. */
  skill_assessment: any[];
}

export interface GenerateQuestionFeedbackOpts {
  client: Anthropic;
  question: FeedbackQuestion;
  answerText: string;
  course: string | null;
  discipline: string | null;
  yearLevel: number | null;
  outcomes: string[];
  teacherNotes: string | null;
  taskType: string | null;
  /** buildSystemPrompt(...) — built once and shared across questions (the
   *  ephemeral cache_control block makes a class burst pay one cache write). */
  holisticSystem: string;
  /** Shared skill-profile read for this student/discipline (graduated prompts). */
  readiness: any[];
  /** Logs a per-question failure without failing the submission. */
  onError?: (err: unknown, stage: string) => void;
}

/** An empty student-facing result (blank answer or hard failure). */
function emptyResult(question: FeedbackQuestion, depth: 'short' | 'extended', ok: boolean): QuestionFeedback {
  return {
    question_id: question.id,
    marks: question.marks,
    depth,
    ok,
    what_youve_done_well: { summary: [] },
    improvements: { summary: [], detail: [] },
    top_priority: { summary: '' },
    skill_assessment: [],
  };
}

/**
 * Generate feedback for ONE question. Never throws — on failure it returns a
 * result with `ok: false` and empty feedback, so one bad question can't sink the
 * whole submission. The endpoint decides what to do if every question failed.
 */
export async function generateQuestionFeedback(opts: GenerateQuestionFeedbackOpts): Promise<QuestionFeedback> {
  const { client, question, answerText } = opts;
  const depth: 'short' | 'extended' = question.marks >= EXTENDED_RESPONSE_MIN_MARKS ? 'extended' : 'short';
  const log = opts.onError || (() => {});

  // A blank answer gets an empty (ok) result — no LLM call, mirrors the maths
  // multi-part blank-part behaviour.
  if (!answerText || !answerText.trim()) {
    return emptyResult(question, depth, true);
  }

  if (depth === 'short') {
    // One concise Sonnet call with a lightweight, student-facing tool (no heavy
    // skill_assessment). Haiku proved unreliable here — even with the small tool
    // it intermittently dropped required student fields (improvements /
    // top_priority), so every short question paid a failed Haiku call + a Sonnet
    // retry. Sonnet fills it reliably; one small call is still ~10× cheaper than
    // the extended three-pass, so the marks-scaling still pays. Short-answer
    // questions don't feed the skill database (thin signal) → skill_assessment [].
    let v: any;
    try {
      const r = await callTool<{
        what_youve_done_well?: { summary?: string[] };
        task_verb_check?: { summary?: string };
        improvements?: { summary?: string[]; detail?: string[] };
        top_priority?: string;
      }>({
        client,
        model: SONNET,
        max_tokens: 1200,
        system: buildShortAnswerSystem(opts.course || undefined, opts.yearLevel || undefined),
        user: buildShortAnswerUser({
          question: question.text,
          marks: question.marks,
          criteriaText: question.criteria_text,
          answer: answerText,
        }),
        tool: SHORT_ANSWER_FEEDBACK_TOOL,
        label: 'multi:short',
        requiredKeys: ['what_youve_done_well', 'improvements', 'top_priority'],
      });
      v = r.value || {};
    } catch (err) {
      log(err, 'multi-short');
      return emptyResult(question, depth, false);
    }
    return {
      question_id: question.id,
      marks: question.marks,
      depth,
      ok: true,
      what_youve_done_well: { summary: v.what_youve_done_well?.summary || [] },
      improvements: { summary: v.improvements?.summary || [], detail: v.improvements?.detail || [] },
      top_priority: { summary: typeof v.top_priority === 'string' ? v.top_priority : '' },
      task_verb_check: v.task_verb_check?.summary ? { summary: v.task_verb_check.summary } : undefined,
      skill_assessment: [],
    };
  }

  // ---- Extended-response path: the full Sonnet three-pass, scoped to one Q ----
  const taskVerbs = extractTaskVerbs(question.text);
  const taskDescription = opts.course
    ? `${opts.course}\n\nQuestion:\n${question.text}`
    : `Question:\n${question.text}`;

  const rawCriteria = question.criteria_text && question.criteria_text.trim() ? question.criteria_text : null;
  const isBandRubric = looksLikeBandRubric(rawCriteria);
  const criteriaForModel = rawCriteria && isBandRubric ? stripBandLabels(rawCriteria) : rawCriteria;
  const hasCriteria = !!(criteriaForModel && criteriaForModel.trim());

  const criteriaCheckUser = `ASSESSMENT TASK:
${taskDescription}

MARKING CRITERIA:
${criteriaForModel || 'No specific criteria provided — assess against general HSC standards'}

---

STUDENT'S DRAFT RESPONSE:
${wrapUntrusted('student_draft', answerText)}

---

Assess this draft against each marking criterion above. Address every criterion individually.`;

  const [pass1, pass2, inline] = await Promise.allSettled([
    callTool<Record<string, any>>({
      client,
      model: SONNET,
      max_tokens: 5000,
      system: opts.holisticSystem,
      user: buildUserPrompt({
        taskDescription,
        taskVerb: taskVerbs[0],
        taskVerbs: taskVerbs.length ? taskVerbs : undefined,
        outcomes: opts.outcomes,
        criteria: [],
        criteriaText: criteriaForModel || undefined,
        studentText: answerText,
        teacherNotes: opts.teacherNotes || undefined,
        taskType: opts.taskType || undefined,
        readiness: opts.readiness,
        untrusted: false,
      }),
      tool: HOLISTIC_FEEDBACK_TOOL,
      cacheSystem: true,
      label: 'multi:holistic',
      requiredKeys: ['what_youve_done_well', 'improvements', 'top_priority'],
    }),
    hasCriteria
      ? callTool<{ criteria_feedback: any }>({
          client,
          model: SONNET,
          max_tokens: 2000,
          system: buildCriteriaCheckPrompt(opts.course || undefined, isBandRubric),
          user: criteriaCheckUser,
          tool: CRITERIA_CHECK_TOOL,
          cacheSystem: true,
          label: 'multi:criteria',
          requiredKeys: ['criteria_feedback'],
        })
      : Promise.resolve(null),
    generateInlineSuggestions(client, {
      taskDescription,
      taskVerbs: taskVerbs.length ? taskVerbs : undefined,
      studentText: answerText,
      holisticImprovements: [],
      courseName: opts.course || undefined,
      discipline: opts.discipline || undefined,
    }),
  ]);

  // Pass 1 is load-bearing for this question — if it failed, this question has
  // no feedback. Soft-fail (ok:false) rather than throw; the rest save.
  if (pass1.status !== 'fulfilled') {
    log(pass1.reason, 'multi-holistic');
    return emptyResult(question, depth, false);
  }
  const h = pass1.value.value;

  let criteriaFeedback: any = null;
  if (pass2.status === 'fulfilled' && pass2.value) {
    criteriaFeedback = pass2.value.value?.criteria_feedback || null;
  } else if (pass2.status === 'rejected') {
    log(pass2.reason, 'multi-criteria');
  }

  let inlineSuggestions: any[] = [];
  if (inline.status === 'fulfilled') inlineSuggestions = inline.value.annotations || [];
  else log(inline.reason, 'multi-inline');

  const { skill_assessment, ...holistic } = h;
  return {
    question_id: question.id,
    marks: question.marks,
    depth,
    ok: true,
    what_youve_done_well: holistic.what_youve_done_well || { summary: [] },
    improvements: holistic.improvements || { summary: [], detail: [] },
    top_priority: holistic.top_priority || { summary: '' },
    task_verb_check: holistic.task_verb_check,
    what_a_strong_response_includes: holistic.what_a_strong_response_includes,
    self_check: holistic.self_check,
    criteria_feedback: criteriaFeedback,
    inline_suggestions: inlineSuggestions,
    is_band_rubric: isBandRubric,
    skill_assessment: Array.isArray(skill_assessment) ? skill_assessment : [],
  };
}

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const CONF_LABEL = ['', 'low', 'medium', 'high'];

/**
 * Collapse the per-question skill reads into ONE assessment per dimension, so
 * recordSkillSignals logs exactly one observation per dimension for this
 * submission (and never duplicate-keys the upsert). Level = average across
 * questions that assessed the dimension; confidence = the strongest among them;
 * note = the most specific (longest) one.
 */
export function aggregateSkillAssessments(groups: any[][]): any[] {
  const LV = LEVEL_VALUE as Record<string, number>;
  const byDim = new Map<string, { levels: number[]; conf: number; notes: string[] }>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const sig of group) {
      if (!sig || sig.assessed === false) continue;
      const dim = typeof sig.dimension === 'string' ? sig.dimension : '';
      const level = typeof sig.level === 'string' ? sig.level.toLowerCase() : '';
      if (!dim || LV[level] == null) continue;
      const e = byDim.get(dim) || { levels: [], conf: 0, notes: [] };
      e.levels.push(LV[level]);
      const confRank = CONF_RANK[typeof sig.confidence === 'string' ? sig.confidence.toLowerCase() : 'medium'] ?? 2;
      if (confRank > e.conf) e.conf = confRank;
      const note = typeof sig.note === 'string' ? sig.note.trim() : '';
      if (note) e.notes.push(note);
      byDim.set(dim, e);
    }
  }
  const out: any[] = [];
  for (const [dimension, e] of byDim) {
    const avg = e.levels.reduce((a, b) => a + b, 0) / e.levels.length;
    const level = SKILL_LEVELS[Math.max(1, Math.min(5, Math.round(avg))) - 1];
    const note = e.notes.sort((a, b) => b.length - a.length)[0] || '';
    out.push({ dimension, assessed: true, level, confidence: CONF_LABEL[e.conf] || 'medium', note });
  }
  return out;
}
