/**
 * Cohort skill matrix (insights R1) — the first insights reader of the skill
 * database.
 *
 * Turns the raw `student_skill_profile` rollup rows for a cohort into a
 * per-dimension distribution: for each writing dimension (W1–W7) and maths
 * dimension (M1–M6), how the in-scope students spread across the developmental
 * levels (emerging → extending), the cohort median, trend, and confidence. Plus
 * a 4-capability spine rollup for the whole-student view.
 *
 * This is a DETERMINISTIC card — no LLM, no rate limit, no floor beyond a small
 * data threshold. It reads numbers ProofReady already stores, so it's free,
 * instant, quantified, and identical on every load — the opposite of the prose
 * re-derivation the LLM cohort cards do. It never predicts a mark or band: the
 * scale is developmental, and no student is named (aggregate distribution only),
 * so it honours both the no-band rule and the cohort-anonymity rule.
 *
 * Pure function so it can be unit-tested without a DB.
 */

import {
  SKILL_LEVELS,
  SkillLevel,
  LEVEL_VALUE,
  WRITING_DIMENSIONS,
  MATHS_DIMENSIONS,
  SPINE,
  SpineCapability,
  dimensionByKey,
} from '../data/skill-taxonomy.js';

/** One rollup row as stored in student_skill_profile. */
export interface SkillProfileRowIn {
  student_id: string;
  discipline: string;
  dimension: string;
  level: number;            // 1–5 (may be fractional from the EWMA)
  level_label?: string | null;
  confidence: number;       // 0–1
  trend?: string | null;    // improving | stable | regressing | new
  observation_count?: number | null;
}

export interface DimensionStat {
  key: string;
  label: string;
  spine: SpineCapability;
  spine_label: string;
  observed_students: number;
  distribution: Record<SkillLevel, number>;
  mean_level: number;
  mean_label: SkillLevel;
  median_level: number;
  median_label: SkillLevel;
  avg_confidence: number;      // 0–1
  low_confidence_students: number;
  trend: { improving: number; stable: number; regressing: number; new: number };
  net_trend: number;           // improving − regressing
}

export interface SpineStat {
  spine: SpineCapability;
  label: string;
  blurb: string;
  mean_level: number;
  mean_label: SkillLevel;
  observed_students: number;
}

export interface FamilyMatrix {
  family: 'writing' | 'maths';
  student_count: number;       // distinct students with any data in this family
  dimensions: DimensionStat[];
  spine_rollup: SpineStat[];
  focus_dimension: string | null;   // lowest mean level (with enough data) — the "reteach this" nudge
}

export interface SkillMatrix {
  writing: FamilyMatrix | null;
  maths: FamilyMatrix | null;
}

// A family sub-matrix only renders once at least this many students have data in
// it — below that a "distribution" is just a handful of points and misleads.
const FAMILY_MIN_STUDENTS = 3;
// Confidence below this (≈ fewer than 2 observations) is "thin" — surfaced so a
// teacher discounts a dimension resting on almost no evidence.
const LOW_CONFIDENCE_BELOW = 0.4;
// A dimension needs at least this many observed students before it can be the
// flagged focus — one weak student shouldn't nominate the whole cohort's focus.
const FOCUS_MIN_STUDENTS = 4;

function nearestLabel(value: number): SkillLevel {
  const i = Math.max(1, Math.min(5, Math.round(value)));
  return SKILL_LEVELS[i - 1] as SkillLevel;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Collapsed per-(student, dimension) value across however many disciplines a
 *  student carries that dimension in (e.g. W4 in both English and PDHPE). */
interface Collapsed { level: number; confidence: number; trend: string }

function collapseByStudentDimension(
  rows: SkillProfileRowIn[],
): Map<string, Map<string, Collapsed>> {
  // dimension -> studentId -> collapsed
  const acc = new Map<string, Map<string, { levels: number[]; conf: number; trendRow: { trend: string; obs: number } }>>();
  for (const r of rows) {
    if (!r || typeof r.level !== 'number' || !dimensionByKey(r.dimension)) continue;
    let byStudent = acc.get(r.dimension);
    if (!byStudent) { byStudent = new Map(); acc.set(r.dimension, byStudent); }
    const e = byStudent.get(r.student_id) || { levels: [], conf: 0, trendRow: { trend: 'new', obs: -1 } };
    e.levels.push(r.level);
    e.conf = Math.max(e.conf, typeof r.confidence === 'number' ? r.confidence : 0);
    // Trend from the most-observed discipline row (most evidence wins).
    const obs = typeof r.observation_count === 'number' ? r.observation_count : 0;
    if (obs > e.trendRow.obs) e.trendRow = { trend: (r.trend || 'stable'), obs };
    byStudent.set(r.student_id, e);
  }
  const out = new Map<string, Map<string, Collapsed>>();
  for (const [dim, byStudent] of acc) {
    const m = new Map<string, Collapsed>();
    for (const [sid, e] of byStudent) {
      m.set(sid, {
        level: e.levels.reduce((a, b) => a + b, 0) / e.levels.length,
        confidence: e.conf,
        trend: e.trendRow.trend,
      });
    }
    out.set(dim, m);
  }
  return out;
}

function buildFamily(
  family: 'writing' | 'maths',
  rows: SkillProfileRowIn[],
): FamilyMatrix | null {
  const dims = family === 'maths' ? MATHS_DIMENSIONS : WRITING_DIMENSIONS;
  const dimKeys = new Set(dims.map(d => d.key));
  const famRows = rows.filter(r => dimKeys.has(r.dimension));
  if (famRows.length === 0) return null;

  const collapsed = collapseByStudentDimension(famRows);
  const studentsInFamily = new Set(famRows.map(r => r.student_id));
  if (studentsInFamily.size < FAMILY_MIN_STUDENTS) return null;

  const dimensions: DimensionStat[] = dims.map(d => {
    const byStudent = collapsed.get(d.key) || new Map<string, Collapsed>();
    const distribution: Record<SkillLevel, number> = {
      emerging: 0, developing: 0, consolidating: 0, secure: 0, extending: 0,
    };
    const levels: number[] = [];
    const trend = { improving: 0, stable: 0, regressing: 0, new: 0 };
    let confSum = 0;
    let lowConf = 0;
    for (const c of byStudent.values()) {
      distribution[nearestLabel(c.level)]++;
      levels.push(c.level);
      confSum += c.confidence;
      if (c.confidence < LOW_CONFIDENCE_BELOW) lowConf++;
      if (c.trend === 'improving') trend.improving++;
      else if (c.trend === 'regressing') trend.regressing++;
      else if (c.trend === 'new') trend.new++;
      else trend.stable++;
    }
    const n = levels.length;
    const mean = n ? levels.reduce((a, b) => a + b, 0) / n : 0;
    const med = median(levels);
    return {
      key: d.key,
      label: d.label,
      spine: d.spine,
      spine_label: SPINE[d.spine].label,
      observed_students: n,
      distribution,
      mean_level: Math.round(mean * 100) / 100,
      mean_label: nearestLabel(mean),
      median_level: Math.round(med * 100) / 100,
      median_label: nearestLabel(med),
      avg_confidence: n ? Math.round((confSum / n) * 100) / 100 : 0,
      low_confidence_students: lowConf,
      trend,
      net_trend: trend.improving - trend.regressing,
    };
  });

  // Focus = the dimension with the lowest mean level, among those with enough
  // observed students to be trustworthy. The UI highlights it as "start here".
  let focus: string | null = null;
  let focusMean = Infinity;
  for (const ds of dimensions) {
    if (ds.observed_students >= FOCUS_MIN_STUDENTS && ds.mean_level > 0 && ds.mean_level < focusMean) {
      focusMean = ds.mean_level;
      focus = ds.key;
    }
  }

  // Spine rollup — the 4-capability whole-student view. Mean of every collapsed
  // (student, dimension) level whose dimension rolls up to that spine.
  const spineAgg = new Map<SpineCapability, { levels: number[]; students: Set<string> }>();
  for (const d of dims) {
    const byStudent = collapsed.get(d.key);
    if (!byStudent) continue;
    const agg = spineAgg.get(d.spine) || { levels: [], students: new Set<string>() };
    for (const [sid, c] of byStudent) { agg.levels.push(c.level); agg.students.add(sid); }
    spineAgg.set(d.spine, agg);
  }
  const spine_rollup: SpineStat[] = [...spineAgg.entries()].map(([spine, agg]) => {
    const mean = agg.levels.length ? agg.levels.reduce((a, b) => a + b, 0) / agg.levels.length : 0;
    return {
      spine,
      label: SPINE[spine].label,
      blurb: SPINE[spine].blurb,
      mean_level: Math.round(mean * 100) / 100,
      mean_label: nearestLabel(mean),
      observed_students: agg.students.size,
    };
  }).sort((a, b) => a.mean_level - b.mean_level);

  return {
    family,
    student_count: studentsInFamily.size,
    dimensions,
    spine_rollup,
    focus_dimension: focus,
  };
}

/**
 * Build the cohort skill matrix from the in-scope rollup rows. Callers must have
 * already scoped `rows` to the students AND disciplines in view (so faculty
 * restriction is honoured). Returns { writing, maths }, either null when there
 * isn't enough data in that family.
 */
export function computeSkillMatrix(rows: SkillProfileRowIn[]): SkillMatrix {
  const safe = Array.isArray(rows) ? rows : [];
  return {
    writing: buildFamily('writing', safe),
    maths: buildFamily('maths', safe),
  };
}

/** True when neither family has enough data to render — lets the handler send a
 *  single "no skill data yet" empty state instead of two nulls. */
export function isEmptyMatrix(m: SkillMatrix): boolean {
  return !m.writing && !m.maths;
}
