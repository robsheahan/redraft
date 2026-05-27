/**
 * Longitudinal student profile synthesis.
 *
 * The profile is an LLM-synthesised summary of a student's history of marked
 * submissions and AI feedback events. It lives in student_profile_synthesis
 * (one row per student), is invalidated on submission-grade and
 * generate-feedback events, and is regenerated lazily on the next read.
 *
 * Privacy contract:
 *   - The synthesis input never includes raw draft text.
 *   - It never includes verbatim teacher annotations or AI inline quotes
 *     (the .quote fields are stripped before the model sees them).
 *   - The model is forbidden from quoting or paraphrasing draft content.
 *
 * This means a teacher who never saw a previous teacher's class can still see
 * the profile without ever seeing what the student wrote in that class.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callTool } from './anthropic-tool-call.js';

type Tool = Anthropic.Messages.Tool;

const MODEL = 'claude-sonnet-4-6';

const PROFILE_TOOL: Tool = {
  name: 'synthesise_student_profile',
  description:
    'Synthesise a longitudinal academic profile from a student\'s history of submissions and feedback. Reads like a careful half-year report comment.',
  input_schema: {
    type: 'object',
    properties: {
      narrative: {
        type: 'string',
        description:
          '4–6 sentences describing where the student is now, what has improved, what is persistent. No quotes or paraphrases of draft text. No mark or band predictions.',
      },
      headline_strength: {
        type: 'string',
        description: 'One line — the strength most consistent across recent submissions.',
      },
      headline_priority: {
        type: 'string',
        description: 'One line — the single most useful next step for this student.',
      },
      improvement_themes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top 3–5 recurring improvement themes from recent submissions. Each 5–10 words.',
      },
      strength_themes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Top 3–5 recurring strengths. Each 5–10 words.',
      },
      mark_trend: {
        type: 'string',
        enum: ['improving', 'stable', 'declining', 'mixed', 'insufficient_data'],
        description: 'Overall mark trajectory across the visible submissions.',
      },
      profile_status: {
        type: 'string',
        enum: ['established', 'developing', 'new'],
        description: 'established = 6+ submissions; developing = 3–5; new = 0–2.',
      },
      profile_status_note: {
        type: 'string',
        description:
          'Short note explaining the status if profile_status is not "established" (e.g. "New to ProofReady — profile begins this term."). Empty string when established.',
      },
    },
    required: [
      'narrative',
      'headline_strength',
      'headline_priority',
      'improvement_themes',
      'strength_themes',
      'mark_trend',
      'profile_status',
      'profile_status_note',
    ],
  },
};

export interface ProfileSynthesisResult {
  narrative: string;
  headline_strength: string;
  headline_priority: string;
  improvement_themes: string[];
  strength_themes: string[];
  mark_trend: 'improving' | 'stable' | 'declining' | 'mixed' | 'insufficient_data';
  profile_status: 'established' | 'developing' | 'new';
  profile_status_note: string;
}

export interface StoredProfile extends ProfileSynthesisResult {
  metrics: {
    submission_count: number;
    graded_count: number;
    recent_mark_avg: number | null;
    distinct_courses: string[];
    first_submission_at: string | null;
    last_submission_at: string | null;
  };
  generated_at: string;
}

/**
 * Read the cached profile if present.
 */
export async function readCachedProfile(
  supabase: SupabaseClient,
  studentId: string,
): Promise<StoredProfile | null> {
  const { data } = await supabase
    .from('student_profile_synthesis')
    .select('*')
    .eq('student_id', studentId)
    .maybeSingle();
  if (!data) return null;
  return {
    narrative: data.narrative ?? '',
    headline_strength: data.headline_strength ?? '',
    headline_priority: data.headline_priority ?? '',
    improvement_themes: data.metrics?.improvement_themes ?? [],
    strength_themes: data.metrics?.strength_themes ?? [],
    mark_trend: data.metrics?.mark_trend ?? 'insufficient_data',
    profile_status: data.metrics?.profile_status ?? 'new',
    profile_status_note: data.metrics?.profile_status_note ?? '',
    metrics: {
      submission_count: data.metrics?.submission_count ?? 0,
      graded_count: data.metrics?.graded_count ?? 0,
      recent_mark_avg: data.metrics?.recent_mark_avg ?? null,
      distinct_courses: data.metrics?.distinct_courses ?? [],
      first_submission_at: data.metrics?.first_submission_at ?? null,
      last_submission_at: data.metrics?.last_submission_at ?? null,
    },
    generated_at: data.generated_at,
  };
}

interface RawSubmission {
  id: string;
  student_id: string;
  task_id: string | null;
  course: string | null;
  draft_version: number | null;
  feedback: any;
  total_mark: number | null;
  criterion_marks: any;
  teacher_comment: string | null;
  teacher_annotations: any;
  graded_at: string | null;
  created_at: string;
  tasks?: { title: string | null; total_marks: number | null } | null;
}

/**
 * Generate a fresh profile from the student's submissions and persist it.
 * Returns the new StoredProfile. If the student has no submissions at all,
 * we still produce a "new" profile (so the UI has something coherent to
 * show) without calling the model.
 */
export async function regenerateProfile(
  supabase: SupabaseClient,
  studentId: string,
): Promise<StoredProfile> {
  const { data: rawSubs, error } = await supabase
    .from('submissions')
    .select(
      'id, student_id, task_id, course, draft_version, feedback, total_mark, criterion_marks, teacher_comment, teacher_annotations, graded_at, created_at, tasks(title, total_marks)',
    )
    .eq('student_id', studentId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`profile fetch failed: ${error.message}`);

  const subs = ((rawSubs as unknown) as RawSubmission[] | null) || [];
  const metrics = computeMetrics(subs);

  let synthesis: ProfileSynthesisResult;
  if (subs.length === 0) {
    synthesis = emptyProfile();
  } else {
    synthesis = await callSynthesisLLM(subs);
  }

  const row = {
    student_id: studentId,
    narrative: synthesis.narrative,
    headline_strength: synthesis.headline_strength,
    headline_priority: synthesis.headline_priority,
    metrics: {
      ...metrics,
      improvement_themes: synthesis.improvement_themes,
      strength_themes: synthesis.strength_themes,
      mark_trend: synthesis.mark_trend,
      profile_status: synthesis.profile_status,
      profile_status_note: synthesis.profile_status_note,
    },
    submission_count_at_generation: subs.length,
    generated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('student_profile_synthesis')
    .upsert(row, { onConflict: 'student_id' });
  if (upsertErr) throw new Error(`profile upsert failed: ${upsertErr.message}`);

  return {
    ...synthesis,
    metrics,
    generated_at: row.generated_at,
  };
}

function computeMetrics(subs: RawSubmission[]): StoredProfile['metrics'] {
  const graded = subs.filter(s => s.graded_at && typeof s.total_mark === 'number');
  // Recent mark avg uses the 5 most recently graded submissions, normalised
  // against task.total_marks where available so we're comparing percentages.
  const recentGraded = graded.slice(-5);
  let recent_mark_avg: number | null = null;
  if (recentGraded.length > 0) {
    const pcts: number[] = [];
    for (const s of recentGraded) {
      const max = s.tasks?.total_marks;
      if (typeof s.total_mark === 'number' && typeof max === 'number' && max > 0) {
        pcts.push((s.total_mark / max) * 100);
      }
    }
    if (pcts.length > 0) {
      recent_mark_avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
    }
  }
  const courses = Array.from(new Set(subs.map(s => s.course).filter(Boolean) as string[]));
  return {
    submission_count: subs.length,
    graded_count: graded.length,
    recent_mark_avg,
    distinct_courses: courses,
    first_submission_at: subs[0]?.created_at ?? null,
    last_submission_at: subs[subs.length - 1]?.created_at ?? null,
  };
}

function emptyProfile(): ProfileSynthesisResult {
  return {
    narrative:
      'This student is new to ProofReady. Their academic profile will begin building as soon as they submit and have their first drafts marked.',
    headline_strength: 'Profile not yet established.',
    headline_priority: 'Once the first drafts are submitted, recurring strengths and priorities will appear here.',
    improvement_themes: [],
    strength_themes: [],
    mark_trend: 'insufficient_data',
    profile_status: 'new',
    profile_status_note: 'No submissions yet — profile begins on first marked draft.',
  };
}

async function callSynthesisLLM(subs: RawSubmission[]): Promise<ProfileSynthesisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });

  const system = `You are an experienced HSC marker writing a longitudinal academic profile for one student, based on the structured history of their submissions on ProofReady.

This profile will be read by any teacher currently teaching this student — including teachers who never saw the underlying drafts. Your job is to give that teacher an accurate picture of where the student is NOW, informed by their trajectory.

HARD RULES:
1. Never quote or paraphrase the student's draft text. You are synthesising patterns, not retelling their work. (You won't be given the raw drafts anyway.)
2. Never predict marks or band levels. The narrative describes patterns; it doesn't grade.
3. Recent submissions matter most. The most recent 5–7 entries should dominate your reading; older entries are context. If the student has clearly moved past an older pattern, do not let it shape the narrative.
4. If submission_count ≤ 2, set profile_status="new" and acknowledge the thin data honestly. Do not infer trends from a single point.
5. If submission_count is 3–5, set profile_status="developing".
6. If submission_count ≥ 6, set profile_status="established".
7. The narrative should read like a careful half-year report comment from an experienced teacher: specific, generous, honest about priorities.`;

  const lines: string[] = [];
  subs.forEach((s, i) => {
    const date = (s.graded_at || s.created_at || '').slice(0, 10);
    const taskTitle = s.tasks?.title || '(untitled task)';
    const course = s.course || '';
    const max = s.tasks?.total_marks ?? null;
    const markStr = typeof s.total_mark === 'number'
      ? (max ? `${s.total_mark}/${max} (${Math.round((s.total_mark / max) * 100)}%)` : `${s.total_mark} marks`)
      : 'not yet marked';
    lines.push(`#${i + 1} · ${date} · ${course} · "${taskTitle}" · draft ${s.draft_version ?? '?'} · mark: ${markStr}`);

    const fb = s.feedback || {};
    if (fb.top_priority) lines.push(`  top_priority: ${trimToWords(fb.top_priority, 40)}`);
    const improvSummary = arrayFromFeedback(fb.improvements, 'summary');
    if (improvSummary.length) lines.push(`  improvements: ${improvSummary.slice(0, 4).join(' | ')}`);
    const wellSummary = arrayFromFeedback(fb.what_youve_done_well, 'summary');
    if (wellSummary.length) lines.push(`  strengths: ${wellSummary.slice(0, 4).join(' | ')}`);
    const verb = fb.task_verb_check?.summary;
    if (verb) lines.push(`  verb_check: ${trimToWords(verb, 25)}`);

    const criteria = Array.isArray(fb.criteria_feedback) ? fb.criteria_feedback : [];
    if (criteria.length) {
      const verdicts = criteria
        .map((c: any) => c.criterion ? `${c.criterion}: ${trimToWords(c.verdict || c.summary || '', 12)}` : '')
        .filter(Boolean)
        .slice(0, 5);
      if (verdicts.length) lines.push(`  criteria: ${verdicts.join(' | ')}`);
    }

    if (s.criterion_marks && typeof s.criterion_marks === 'object') {
      const cm = Object.entries(s.criterion_marks)
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 6)
        .join(', ');
      if (cm) lines.push(`  criterion_marks: ${cm}`);
    }
    if (s.teacher_comment) lines.push(`  teacher_comment: ${trimToWords(s.teacher_comment, 40)}`);

    // Strip the .quote field from annotations — drafts must not leak to the model.
    const annots = Array.isArray(s.teacher_annotations) ? s.teacher_annotations : [];
    if (annots.length) {
      const a = annots
        .map((x: any) => `${x.category || 'note'}: ${trimToWords(x.comment || '', 18)}`)
        .filter((x: string) => x.length > 5)
        .slice(0, 6);
      if (a.length) lines.push(`  teacher_annotations: ${a.join(' | ')}`);
    }
  });

  const user = `submission_count: ${subs.length}\n\nSubmissions (oldest first, recent ones weigh most):\n\n${lines.join('\n')}\n\nProduce the profile via the tool.`;

  const result = await callTool<ProfileSynthesisResult>({
    client,
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.3,
    system,
    user,
    tool: PROFILE_TOOL,
  });
  return result.value;
}

function arrayFromFeedback(field: any, key: 'summary' | 'detail'): string[] {
  if (!field) return [];
  // Newer shape: { summary: [], detail: [] }
  if (Array.isArray(field[key])) return field[key].filter((x: any) => typeof x === 'string');
  // Older shape: plain array of strings
  if (Array.isArray(field)) return field.filter((x: any) => typeof x === 'string');
  return [];
}

function trimToWords(s: string | undefined, max: number): string {
  if (!s) return '';
  const words = String(s).split(/\s+/);
  if (words.length <= max) return s.trim();
  return words.slice(0, max).join(' ') + '…';
}
