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
const EVIDENCE_WEIGHT: Record<string, number> = { high: 1, medium: 0.6, low: 0.3 };
// A note this short can't carry concrete evidence — treat as low confidence
// however the model labelled it.
const MIN_EVIDENCE_NOTE_LEN = 25;

function evidenceWeight(confidence: string, note: string): number {
  let w = EVIDENCE_WEIGHT[confidence.toLowerCase()] ?? EVIDENCE_WEIGHT.medium;
  if (note.trim().length < MIN_EVIDENCE_NOTE_LEN) w = Math.min(w, EVIDENCE_WEIGHT.low);
  return w;
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
export async function recordSkillSignals(opts: {
  supabase: SupabaseClient;
  studentId: string;
  discipline: string;
  family: SkillFamily;
  assessment: unknown;
}): Promise<number> {
  const { supabase, studentId, discipline, family, assessment } = opts;
  if (!Array.isArray(assessment) || assessment.length === 0) return 0;

  const validKeys = new Set(dimensionsForFamily(family).map(d => d.key));

  // Keep only well-formed, actually-assessed signals for a dimension in this
  // family with a recognised level.
  const signals: Array<{ dimension: string; level: SkillLevel; note: string; confidence: string }> = [];
  for (const raw of assessment as RawSignal[]) {
    if (!raw || raw.assessed === false) continue;
    const dim = typeof raw.dimension === 'string' ? raw.dimension : '';
    const level = typeof raw.level === 'string' ? raw.level.toLowerCase() : '';
    if (!validKeys.has(dim) || !VALID_LEVELS.has(level)) continue;
    signals.push({
      dimension: dim,
      level: level as SkillLevel,
      note: (raw.note || '').toString().slice(0, 400),
      confidence: typeof raw.confidence === 'string' ? raw.confidence : '',
    });
  }
  if (signals.length === 0) return 0;

  // Defence-in-depth: collapse to one signal per dimension. A caller that passes
  // duplicate dimensions (the maths multi-part flow did) would otherwise build an
  // upsert with duplicate (student, discipline, dimension) conflict keys, which
  // Postgres rejects wholesale (error 21000) — silently dropping the entire
  // rollup. Callers should pre-aggregate, but this makes the drop impossible.
  const seenDim = new Set<string>();
  const dedupedSignals = signals.filter(s => {
    if (seenDim.has(s.dimension)) return false;
    seenDim.add(s.dimension);
    return true;
  });
  signals.length = 0;
  signals.push(...dedupedSignals);

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

  const now = new Date().toISOString();
  const rows = signals.map(s => {
    const obs = LEVEL_VALUE[s.level];
    const before = prev.get(s.dimension);
    let newLevel: number;
    if (before) {
      // Evidence-weighted EWMA: a weakly-evidenced observation moves the
      // estimate less, then a hard ±1 cap bounds any single submission.
      const effAlpha = ALPHA * evidenceWeight(s.confidence, s.note);
      const ewma = effAlpha * obs + (1 - effAlpha) * before.level;
      newLevel = Math.max(before.level - MAX_LEVEL_DELTA, Math.min(before.level + MAX_LEVEL_DELTA, ewma));
    } else {
      newLevel = obs;
    }
    const count = (before?.observation_count ?? 0) + 1;
    let trend: string;
    if (!before) trend = 'new';
    else if (obs > before.level + 0.25) trend = 'improving';
    else if (obs < before.level - 0.25) trend = 'regressing';
    else trend = 'stable';
    return {
      student_id: studentId,
      discipline,
      dimension: s.dimension,
      level: Math.round(newLevel * 100) / 100,
      level_label: nearestLabel(newLevel),
      confidence: Math.min(1, count / CONFIDENCE_FULL_AT),
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
