/**
 * Cohort skill growth (insights R2) — the second reader of the skill database,
 * over the skill_observations history rather than the snapshot rollup.
 *
 * Measures growth as a WITHIN-STUDENT delta: for each student with ≥2
 * observations in a dimension, latest level − earliest level, then averaged
 * across the cohort per dimension. This deliberately avoids the composition
 * confound that sinks a naive cohort-mean comparison — a wave of new, weaker
 * students would drag a cohort mean down even as every individual improved.
 * Averaging per-student change instead answers the question schools actually
 * ask: "are our students getting better at this?"
 *
 * Deterministic, free, no LLM, developmental levels only (never a mark/band),
 * aggregate (no student named). Pure function — unit-testable without a DB.
 */

import {
  SKILL_LEVELS,
  SkillLevel,
  WRITING_DIMENSIONS,
  MATHS_DIMENSIONS,
  SPINE,
  SpineCapability,
} from '../data/skill-taxonomy.js';

export interface SkillObservationIn {
  student_id: string;
  dimension: string;
  level: number;          // observed level 1–5 for that submission
  observed_at: string;    // ISO
}

export interface DimensionGrowth {
  key: string;
  label: string;
  spine: SpineCapability;
  spine_label: string;
  students_with_trend: number;   // students with ≥2 observations in this dimension
  mean_delta: number;            // average within-student change in levels (−4..+4)
  improved: number;
  declined: number;
  steady: number;
  earliest_mean: number;
  latest_mean: number;
}

export interface FamilyGrowth {
  family: 'writing' | 'maths';
  student_count: number;
  dimensions: DimensionGrowth[];      // sorted by mean_delta, most-improved first
  top_improved: string | null;        // dimension key, or null if nothing net-positive
  top_declined: string | null;        // dimension key, or null if nothing net-negative
  observed_from: string | null;
  observed_to: string | null;
}

export interface SkillGrowth {
  writing: FamilyGrowth | null;
  maths: FamilyGrowth | null;
}

// A student needs at least this many observations in a dimension to contribute a
// cohort-growth trend. 3 (not 2) so a "most improved" headline a leader sees
// rests on more than a single before/after pair.
const MIN_OBS_FOR_TREND = 3;
// A family growth panel renders only once this many students contribute a trend.
const FAMILY_MIN_STUDENTS_WITH_TREND = 3;
// A delta smaller than this (in levels) is "steady", not a real move. Raised from
// 0.25 → 0.4 so ordinary read-to-read wobble doesn't register as improvement or
// decline (the per-submission reads are noisy — that's why the rollup smooths).
const MOVE_THRESHOLD = 0.4;

// Endpoint levels for a within-student delta, smoothed: the mean of the first k
// and last k observations rather than the single first/last read (k scales with
// how much history the student has, 1–3). This diffs a smoothed start against a
// smoothed end instead of the two noisiest points.
function smoothedEndpoints(sortedLevels: number[]): { earliest: number; latest: number } {
  const n = sortedLevels.length;
  const k = Math.max(1, Math.min(3, Math.floor(n / 3)));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return { earliest: mean(sortedLevels.slice(0, k)), latest: mean(sortedLevels.slice(n - k)) };
}

function buildFamily(
  family: 'writing' | 'maths',
  rows: SkillObservationIn[],
): FamilyGrowth | null {
  const dims = family === 'maths' ? MATHS_DIMENSIONS : WRITING_DIMENSIONS;
  const dimKeys = new Set(dims.map(d => d.key));
  const famRows = rows.filter(r => dimKeys.has(r.dimension) && typeof r.level === 'number' && r.observed_at);
  if (famRows.length === 0) return null;

  // Group by (dimension → student → observations), then reduce to first/last.
  const byDim = new Map<string, Map<string, SkillObservationIn[]>>();
  let fromISO: string | null = null;
  let toISO: string | null = null;
  for (const r of famRows) {
    if (!fromISO || r.observed_at < fromISO) fromISO = r.observed_at;
    if (!toISO || r.observed_at > toISO) toISO = r.observed_at;
    let byStudent = byDim.get(r.dimension);
    if (!byStudent) { byStudent = new Map(); byDim.set(r.dimension, byStudent); }
    const arr = byStudent.get(r.student_id) || [];
    arr.push(r);
    byStudent.set(r.student_id, arr);
  }

  const studentsWithTrend = new Set<string>();
  const dimensions: DimensionGrowth[] = dims.map(d => {
    const byStudent = byDim.get(d.key) || new Map<string, SkillObservationIn[]>();
    const deltas: number[] = [];
    const earliests: number[] = [];
    const latests: number[] = [];
    let improved = 0, declined = 0, steady = 0;
    for (const [sid, obs] of byStudent) {
      if (obs.length < MIN_OBS_FOR_TREND) continue;
      const sorted = [...obs].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
      const { earliest: first, latest: last } = smoothedEndpoints(sorted.map(o => o.level));
      const delta = last - first;
      deltas.push(delta);
      earliests.push(first);
      latests.push(last);
      if (delta > MOVE_THRESHOLD) improved++;
      else if (delta < -MOVE_THRESHOLD) declined++;
      else steady++;
      studentsWithTrend.add(sid);
    }
    const n = deltas.length;
    const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    return {
      key: d.key,
      label: d.label,
      spine: d.spine,
      spine_label: SPINE[d.spine].label,
      students_with_trend: n,
      mean_delta: Math.round(mean(deltas) * 100) / 100,
      improved,
      declined,
      steady,
      earliest_mean: Math.round(mean(earliests) * 100) / 100,
      latest_mean: Math.round(mean(latests) * 100) / 100,
    };
  });

  if (studentsWithTrend.size < FAMILY_MIN_STUDENTS_WITH_TREND) return null;

  // Rank most-improved first. Only dimensions that actually have trend data can
  // be top movers.
  const withData = dimensions.filter(d => d.students_with_trend > 0);
  const sorted = [...dimensions].sort((a, b) => b.mean_delta - a.mean_delta);
  const byDelta = [...withData].sort((a, b) => b.mean_delta - a.mean_delta);
  const topImproved = byDelta.length && byDelta[0].mean_delta > MOVE_THRESHOLD ? byDelta[0].key : null;
  const bottom = byDelta.length ? byDelta[byDelta.length - 1] : null;
  const topDeclined = bottom && bottom.mean_delta < -MOVE_THRESHOLD ? bottom.key : null;

  return {
    family,
    student_count: studentsWithTrend.size,
    dimensions: sorted,
    top_improved: topImproved,
    top_declined: topDeclined,
    observed_from: fromISO,
    observed_to: toISO,
  };
}

export function computeSkillGrowth(rows: SkillObservationIn[]): SkillGrowth {
  const safe = Array.isArray(rows) ? rows : [];
  return {
    writing: buildFamily('writing', safe),
    maths: buildFamily('maths', safe),
  };
}

export function isEmptyGrowth(g: SkillGrowth): boolean {
  return !g.writing && !g.maths;
}

// ─────────────── Per-student journey (R2b / R4) ───────────────

// Longest sparkline we return per dimension — the most recent N observations.
// Delta/status are always computed over the FULL history, not this tail.
const MAX_SERIES_POINTS = 20;

export type SkillMoveStatus = 'improved' | 'steady' | 'regressed' | 'single';

export interface JourneyPoint { level: number; at: string }

export interface DimensionJourney {
  key: string;
  label: string;
  spine: SpineCapability;
  spine_label: string;
  count: number;              // total observations
  series: JourneyPoint[];     // oldest → newest, capped to MAX_SERIES_POINTS most recent
  earliest_level: number;
  current_level: number;
  current_label: SkillLevel;
  delta: number;              // current − earliest (0 when a single observation)
  status: SkillMoveStatus;
}

export interface FamilyJourney {
  family: 'writing' | 'maths';
  dimensions: DimensionJourney[];   // taxonomy order; only dimensions with data
  observed_from: string | null;
  observed_to: string | null;
}

export interface SkillJourney {
  writing: FamilyJourney | null;
  maths: FamilyJourney | null;
}

function nearestLabel(value: number): SkillLevel {
  const i = Math.max(1, Math.min(5, Math.round(value)));
  return SKILL_LEVELS[i - 1] as SkillLevel;
}

function buildFamilyJourney(
  family: 'writing' | 'maths',
  rows: SkillObservationIn[],
): FamilyJourney | null {
  const dims = family === 'maths' ? MATHS_DIMENSIONS : WRITING_DIMENSIONS;
  const dimKeys = new Set(dims.map(d => d.key));
  const famRows = rows.filter(r => dimKeys.has(r.dimension) && typeof r.level === 'number' && r.observed_at);
  if (famRows.length === 0) return null;

  let fromISO: string | null = null;
  let toISO: string | null = null;
  const byDim = new Map<string, SkillObservationIn[]>();
  for (const r of famRows) {
    if (!fromISO || r.observed_at < fromISO) fromISO = r.observed_at;
    if (!toISO || r.observed_at > toISO) toISO = r.observed_at;
    const arr = byDim.get(r.dimension) || [];
    arr.push(r);
    byDim.set(r.dimension, arr);
  }

  const dimensions: DimensionJourney[] = [];
  for (const d of dims) {
    const obs = byDim.get(d.key);
    if (!obs || obs.length === 0) continue;
    const sorted = [...obs].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    // Delta, status and the "now" level are computed on SMOOTHED endpoints, so
    // they don't swing on a single noisy read — and "now" tracks the smoothed
    // recent level (closer to the anchored rollup) rather than the latest single
    // observation. The sparkline series below stays RAW to show the real journey.
    const { earliest, latest: current } = smoothedEndpoints(sorted.map(o => o.level));
    const delta = sorted.length >= 2 ? Math.round((current - earliest) * 100) / 100 : 0;
    let status: SkillMoveStatus;
    if (sorted.length < 2) status = 'single';
    else if (delta > MOVE_THRESHOLD) status = 'improved';
    else if (delta < -MOVE_THRESHOLD) status = 'regressed';
    else status = 'steady';
    const series = sorted
      .slice(-MAX_SERIES_POINTS)
      .map(o => ({ level: o.level, at: o.observed_at }));
    dimensions.push({
      key: d.key,
      label: d.label,
      spine: d.spine,
      spine_label: SPINE[d.spine].label,
      count: sorted.length,
      series,
      earliest_level: Math.round(earliest * 100) / 100,
      current_level: Math.round(current * 100) / 100,
      current_label: nearestLabel(current),
      delta,
      status,
    });
  }
  if (dimensions.length === 0) return null;
  return { family, dimensions, observed_from: fromISO, observed_to: toISO };
}

/**
 * One student's skill journey — the ordered observation series per dimension,
 * with the net change and a movement status. Powers the per-student trajectory
 * sparklines (R2b) and the skill-movement summary (R4).
 */
export function computeStudentSkillJourney(rows: SkillObservationIn[]): SkillJourney {
  const safe = Array.isArray(rows) ? rows : [];
  return {
    writing: buildFamilyJourney('writing', safe),
    maths: buildFamilyJourney('maths', safe),
  };
}

export function isEmptyJourney(j: SkillJourney): boolean {
  return !j.writing && !j.maths;
}

// ─────────────── Skill movement summary (R4) ───────────────

// At/above this level a dimension is "held" rather than a live growth area.
const SECURE_LEVEL = 4;

export interface SkillMovementItem {
  key: string;
  label: string;
  delta: number;
  current_level: number;
  current_label: SkillLevel;
}

export interface SkillMovement {
  improved: SkillMovementItem[];       // net up over the student's own history
  slipped: SkillMovementItem[];        // net down — reteach / check in
  still_working: SkillMovementItem[];  // flat AND still below secure — a persistent growth area
  tracked_count: number;               // dimensions with ≥2 observations (a real trend)
}

/**
 * Summarise a student's skill movement from their journey — the R4 replacement
 * for the old improvement-velocity card, which compared LLM improvement TITLES
 * as verbatim strings (so rephrased feedback read as churn and the numbers were
 * noise). This classifies real, measured level change per dimension instead:
 * improved / slipped / a persistent growth area. Reuses the already-computed
 * journey, so it costs no extra read.
 */
export function summariseSkillMovement(j: SkillJourney): SkillMovement {
  const dims = [
    ...((j.writing && j.writing.dimensions) || []),
    ...((j.maths && j.maths.dimensions) || []),
  ];
  const trend = dims.filter(d => d.status !== 'single');
  const pick = (d: DimensionJourney): SkillMovementItem => ({
    key: d.key,
    label: d.label,
    delta: d.delta,
    current_level: d.current_level,
    current_label: d.current_label,
  });
  const improved = trend.filter(d => d.status === 'improved').sort((a, b) => b.delta - a.delta).map(pick);
  const slipped = trend.filter(d => d.status === 'regressed').sort((a, b) => a.delta - b.delta).map(pick);
  const still_working = trend
    .filter(d => d.status === 'steady' && d.current_level < SECURE_LEVEL)
    .sort((a, b) => a.current_level - b.current_level)
    .map(pick);
  return { improved, slipped, still_working, tracked_count: trend.length };
}
