/**
 * Skill-signal capture + rollup — the write side of the ProofReady skill
 * database.
 *
 * At feedback time the holistic pass emits a `skill_assessment` (per dimension:
 * level + confidence + actionable note). This module validates it against the
 * taxonomy and folds it into a per-(student, discipline, dimension) rollup that
 * the profile, insights, and Lesson Builder read.
 *
 * The rollup uses an exponentially-weighted moving average so recent work
 * dominates, and a confidence that grows with the number of observations — so
 * downstream readers can degrade gracefully (thin data → low confidence → fall
 * back to generic). Fire-and-forget from the caller: a failure here must never
 * affect the student's feedback.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TAXONOMY_VERSION,
  SkillFamily,
  SkillLevel,
  SKILL_LEVELS,
  LEVEL_VALUE,
  dimensionsForFamily,
} from '../data/skill-taxonomy.js';

interface RawSignal {
  dimension?: string;
  assessed?: boolean;
  level?: string;
  confidence?: string;
  note?: string;
}

// Recency weight for the EWMA. 0.4 means a new observation moves the estimate
// ~40% of the way toward itself — responsive without being jumpy.
const ALPHA = 0.4;
// Observations needed before a dimension is treated as fully confident.
const CONFIDENCE_FULL_AT = 5;

// Anti-gaming damping (P2). Two guards stop a couple of gamed drafts from
// flipping a profile to secure/extending (which would strip scaffolding,
// harden Lesson Builder re-skins, and pollute teacher insights):
//   1. The model's per-observation confidence scales how far that observation
//      moves the rollup — a weakly-evidenced read barely shifts it.
//   2. A hard ±1 cap on how far any single submission can move the stored
//      level, regardless of how extreme the reading.
const MAX_LEVEL_DELTA = 1;
// Where a skill read came from. The silent Haiku pass on quick/exam tasks is the
// BULK of submissions but a briefer, less-nuanced read than the full Sonnet
// feedback an assessment task gets — so a Haiku read moves the rollup less. This
// stops the store being dominated by the cheapest reads at full weight.
export type SkillSource = 'sonnet' | 'haiku';
const SOURCE_WEIGHT: Record<SkillSource, number> = { sonnet: 1, haiku: 0.5 };
// Neutral prior a FIRST observation is seeded toward (weighted by its evidence),
// so a single thin read can't peg a brand-new dimension at 1.0 or 5.0.
// 3 = consolidating, the midpoint of the 1–5 developmental scale.
const NEUTRAL_PRIOR = 3;
// Minimum smoothed movement (in levels) for a step to count as improving/
// regressing rather than stable — keeps trend from flipping on tiny wobbles.
const TREND_THRESHOLD = 0.15;
const EVIDENCE_WEIGHT: Record<string, number> = { high: 1, medium: 0.6, low: 0.3 };
// A note this short can't carry concrete evidence — treat as low confidence
// however the model labelled it.
const MIN_EVIDENCE_NOTE_LEN = 25;

function evidenceWeight(confidence: string, note: string): number {
  let w = EVIDENCE_WEIGHT[confidence.toLowerCase()] ?? EVIDENCE_WEIGHT.medium;
  if (note.trim().length < MIN_EVIDENCE_NOTE_LEN) w = Math.min(w, EVIDENCE_WEIGHT.low);
  return w;
}

// Standard deviation (in levels) treated as "reads fully disagree" — at/above
// this, the agreement multiplier bottoms out.
const SD_FULL_DISAGREEMENT = 1.5;
// Floor on the agreement multiplier so wildly-disagreeing reads still leave some
// confidence proportional to volume (they don't zero it out).
const AGREEMENT_FLOOR = 0.4;

/**
 * Confidence a rollup should carry, given how MANY observations back it and how
 * much they AGREE. Volume alone (count / CONFIDENCE_FULL_AT) pinned confidence to
 * 100% after 5 reads no matter how contradictory they were — and that confidence
 * drives whether graduated feedback strips a student's support. This tempers the
 * volume component by the spread of the recent observed levels: consistent reads
 * keep full volume-confidence; scattered reads are discounted toward the floor.
 * Pure — unit-tested.
 */
export function agreementConfidence(count: number, recentLevels: number[]): number {
  const volume = Math.min(1, count / CONFIDENCE_FULL_AT);
  if (!recentLevels || recentLevels.length < 2) return volume;
  const mean = recentLevels.reduce((a, b) => a + b, 0) / recentLevels.length;
  const variance = recentLevels.reduce((a, l) => a + (l - mean) ** 2, 0) / recentLevels.length;
  const sd = Math.sqrt(variance);
  const agreement = 1 - Math.min(1, sd / SD_FULL_DISAGREEMENT);
  return volume * (AGREEMENT_FLOOR + (1 - AGREEMENT_FLOOR) * agreement);
}

const VALID_LEVELS = new Set<string>(SKILL_LEVELS);

function nearestLabel(value: number): SkillLevel {
  const rounded = Math.max(1, Math.min(5, Math.round(value)));
  return (SKILL_LEVELS[rounded - 1] as SkillLevel) ?? 'developing';
}

/**
 * Validate + persist a submission's skill read, then update the student's
 * rollup. Returns the number of dimensions recorded (0 on no-op).
 */
interface ValidSignal { dimension: string; level: SkillLevel; note: string; confidence: string }

/**
 * Validate a raw skill_assessment against the family's taxonomy and collapse to
 * one signal per dimension. Shared by the rollup write, the observation-history
 * write, and the backfill so all three see an identical, deduped signal set.
 *
 * The dedupe is load-bearing: a caller passing duplicate dimensions (the maths
 * multi-part flow did) would otherwise build an upsert with duplicate
 * (student, discipline, dimension) conflict keys, which Postgres rejects
 * wholesale (error 21000) — silently dropping the entire rollup.
 */
export function validateSkillSignals(assessment: unknown, family: SkillFamily): ValidSignal[] {
  if (!Array.isArray(assessment) || assessment.length === 0) return [];
  const validKeys = new Set(dimensionsForFamily(family).map(d => d.key));
  const seenDim = new Set<string>();
  const signals: ValidSignal[] = [];
  for (const raw of assessment as RawSignal[]) {
    if (!raw || raw.assessed === false) continue;
    const dim = typeof raw.dimension === 'string' ? raw.dimension : '';
    const level = typeof raw.level === 'string' ? raw.level.toLowerCase() : '';
    if (!validKeys.has(dim) || !VALID_LEVELS.has(level) || seenDim.has(dim)) continue;
    seenDim.add(dim);
    signals.push({
      dimension: dim,
      level: level as SkillLevel,
      note: (raw.note || '').toString().slice(0, 400),
      confidence: typeof raw.confidence === 'string' ? raw.confidence : '',
    });
  }
  return signals;
}

/**
 * Append this submission's skill reads to the skill_observations history — one
 * row per (submission, dimension). Best-effort and fully isolated: it never
 * throws, so a missing table or failed insert can't disturb the rollup that
 * already succeeded. Idempotent via the (submission_id, dimension) unique index.
 * Reused by the backfill script.
 */
export async function recordSkillObservations(opts: {
  supabase: SupabaseClient;
  studentId: string;
  discipline: string;
  family: SkillFamily;
  assessment: unknown;
  submissionId: string;
  taskId?: string | null;
  observedAt?: string | null;
  source?: SkillSource;
}): Promise<number> {
  const { supabase, studentId, discipline, family, assessment, submissionId, taskId, observedAt } = opts;
  const source: SkillSource = opts.source || 'sonnet';
  if (!submissionId) return 0;
  const signals = validateSkillSignals(assessment, family);
  if (signals.length === 0) return 0;
  const observed = observedAt || new Date().toISOString();
  const rows = signals.map(s => ({
    submission_id: submissionId,
    task_id: taskId || null,
    student_id: studentId,
    discipline,
    family,
    dimension: s.dimension,
    level: LEVEL_VALUE[s.level],
    level_label: s.level,
    confidence: s.confidence || null,
    evidence_weight: evidenceWeight(s.confidence, s.note) * (SOURCE_WEIGHT[source] ?? 1),
    source,
    observed_at: observed,
    taxonomy_version: TAXONOMY_VERSION,
  }));
  try {
    const { error } = await supabase
      .from('skill_observations')
      .upsert(rows, { onConflict: 'submission_id,dimension', ignoreDuplicates: true });
    if (error) {
      console.warn('[skill-observations] insert failed (history skipped):', error.message);
      return 0;
    }
    return rows.length;
  } catch (e: any) {
    console.warn('[skill-observations] insert threw (history skipped):', e?.message);
    return 0;
  }
}

export async function recordSkillSignals(opts: {
  supabase: SupabaseClient;
  studentId: string;
  discipline: string;
  family: SkillFamily;
  assessment: unknown;
  // Optional provenance — when supplied, the same signals are also appended to
  // the skill_observations history (best-effort; never affects the rollup).
  submissionId?: string | null;
  taskId?: string | null;
  observedAt?: string | null;
  // Which model produced the read — the Haiku silent pass is discounted (see
  // SOURCE_WEIGHT). Defaults to 'sonnet' (the AI-feedback paths).
  source?: SkillSource;
}): Promise<number> {
  const { supabase, studentId, discipline, family, assessment } = opts;
  const source: SkillSource = opts.source || 'sonnet';
  const srcWeight = SOURCE_WEIGHT[source] ?? 1;

  const signals = validateSkillSignals(assessment, family);
  if (signals.length === 0) return 0;

  // Append to the history log first — isolated so it can't affect the rollup.
  if (opts.submissionId) {
    await recordSkillObservations({
      supabase, studentId, discipline, family, assessment,
      submissionId: opts.submissionId, taskId: opts.taskId, observedAt: opts.observedAt, source,
    });
  }

  const dims = signals.map(s => s.dimension);

  // Read existing rollup rows for these dimensions in one query.
  const { data: existingRows } = await supabase
    .from('student_skill_profile')
    .select('dimension, level, observation_count')
    .eq('student_id', studentId)
    .eq('discipline', discipline)
    .in('dimension', dims);
  const prev = new Map<string, { level: number; observation_count: number }>();
  (existingRows || []).forEach((r: any) => prev.set(r.dimension, { level: Number(r.level), observation_count: r.observation_count }));

  // Recent observed levels per dimension, to temper confidence by how much the
  // reads agree (1.3). Best-effort: the current read was just written to the log
  // above, so it's included; any read error leaves the map empty and confidence
  // falls back to volume-only. Capped per dimension so old history doesn't drown
  // the recent picture.
  const RECENT_PER_DIM = 10;
  const recentByDim = new Map<string, number[]>();
  try {
    const { data: obsHist } = await supabase
      .from('skill_observations')
      .select('dimension, level, observed_at')
      .eq('student_id', studentId)
      .eq('discipline', discipline)
      .in('dimension', dims)
      .order('observed_at', { ascending: false })
      .limit(dims.length * RECENT_PER_DIM * 2);
    (obsHist || []).forEach((r: any) => {
      const arr = recentByDim.get(r.dimension) || [];
      if (arr.length < RECENT_PER_DIM && typeof r.level === 'number') arr.push(Number(r.level));
      recentByDim.set(r.dimension, arr);
    });
  } catch { /* confidence falls back to volume-only */ }

  const now = new Date().toISOString();
  const rows = signals.map(s => {
    const obs = LEVEL_VALUE[s.level];
    const before = prev.get(s.dimension);
    // Evidence weight, discounted by source: a Haiku read moves the rollup less
    // than a Sonnet read of the same self-reported confidence.
    const ew = evidenceWeight(s.confidence, s.note) * srcWeight;
    let newLevel: number;
    if (before) {
      // Evidence-weighted EWMA: a weakly-evidenced observation moves the
      // estimate less, then a hard ±1 cap bounds any single submission.
      const effAlpha = ALPHA * ew;
      const ewma = effAlpha * obs + (1 - effAlpha) * before.level;
      newLevel = Math.max(before.level - MAX_LEVEL_DELTA, Math.min(before.level + MAX_LEVEL_DELTA, ewma));
    } else {
      // First observation: seed toward a neutral prior weighted by the read's
      // evidence, so one thin/low-confidence read can't peg the extremes (a
      // single low-confidence "extending" would otherwise set the level to 5.0
      // outright). A high-confidence first read passes through ~unchanged.
      newLevel = ew * obs + (1 - ew) * NEUTRAL_PRIOR;
    }
    const count = (before?.observation_count ?? 0) + 1;
    // Trend from the SMOOTHED movement this step (post-EWMA newLevel vs the prior
    // stored level), not the raw observation vs the prior — the raw-residual
    // version flipped improving/regressing on any single reading above/below the
    // average, so it oscillated submission-to-submission instead of tracking a
    // trajectory.
    let trend: string;
    if (!before) trend = 'new';
    else if (newLevel > before.level + TREND_THRESHOLD) trend = 'improving';
    else if (newLevel < before.level - TREND_THRESHOLD) trend = 'regressing';
    else trend = 'stable';
    return {
      student_id: studentId,
      discipline,
      dimension: s.dimension,
      level: Math.round(newLevel * 100) / 100,
      level_label: nearestLabel(newLevel),
      // Confidence = volume tempered by agreement of the recent reads (1.3), not
      // volume alone. The recent-levels list already includes this submission's
      // read (written to the history log just above).
      confidence: Math.round(agreementConfidence(count, recentByDim.get(s.dimension) || []) * 100) / 100,
      trend,
      signal: s.note || null,
      observation_count: count,
      taxonomy_version: TAXONOMY_VERSION,
      updated_at: now,
    };
  });

  const { error } = await supabase
    .from('student_skill_profile')
    .upsert(rows, { onConflict: 'student_id,discipline,dimension' });
  if (error) throw new Error(`skill rollup upsert failed: ${error.message}`);

  return rows.length;
}

export interface SkillProfileRow {
  discipline: string;
  dimension: string;
  level: number;
  level_label: string | null;
  confidence: number;
  trend: string | null;
  signal: string | null;
  observation_count: number;
}

/**
 * Read side of the skill database — the per-(discipline, dimension) rollup for
 * one student. Lesson Builder reads this to differentiate an activity.
 *
 * Returns [] when the student has no skill data yet — the caller treats an empty
 * read as "deliver the main activity unchanged". Optionally filter to one
 * discipline (the task's KLA), which is what the differentiation uses.
 */
export async function readSkillProfile(
  supabase: SupabaseClient,
  studentId: string,
  discipline?: string,
): Promise<SkillProfileRow[]> {
  let query = supabase
    .from('student_skill_profile')
    .select('discipline, dimension, level, level_label, confidence, trend, signal, observation_count')
    .eq('student_id', studentId);
  if (discipline) query = query.eq('discipline', discipline);
  const { data, error } = await query;
  if (error) {
    console.warn('[skill-profile] read failed:', error.message);
    return [];
  }
  return (data as SkillProfileRow[]) || [];
}
