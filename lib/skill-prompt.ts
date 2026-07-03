/**
 * Skill data → prompt text (insights R3).
 *
 * Feeds the measured skill database into the LLM syntheses (student profile,
 * student cards, cohort cards) alongside the feedback prose they already get.
 * The structured levels ANCHOR the narrative — "their Use of evidence has moved
 * from emerging to consolidating over five submissions" — cut run-to-run
 * variance, and are cheaper than more prose.
 *
 * Guardrails baked into the block text: the developmental scale is explicitly
 * NOT a mark/band, and the model is told to anchor to (not contradict, not
 * restate as scores) these levels. Pure string builders — no I/O.
 */

import {
  SKILL_LEVELS,
  SkillLevel,
  WRITING_DIMENSIONS,
  MATHS_DIMENSIONS,
  dimensionByKey,
} from './../data/skill-taxonomy.js';
import type { SkillProfileRow } from './skill-profile.js';
import type { SkillMatrix } from './skill-matrix.js';

const SCALE_NOTE =
  'developmental scale emerging → developing → consolidating → secure → extending; this is NOT a mark or band and must never be restated as a score';

function taxonomyOrder(dimKeys: string[]): string[] {
  const order = [...WRITING_DIMENSIONS, ...MATHS_DIMENSIONS].map(d => d.key);
  return [...dimKeys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function nearestLabel(value: number): SkillLevel {
  const i = Math.max(1, Math.min(5, Math.round(value)));
  return SKILL_LEVELS[i - 1] as SkillLevel;
}

/**
 * One student's rollup (student_skill_profile rows) as a compact prompt block.
 * Returns null when there's no skill data (caller omits the block).
 */
export function formatStudentSkillProfile(rows: SkillProfileRow[] | null | undefined): string | null {
  if (!rows || rows.length === 0) return null;
  // Collapse to one row per dimension (a student may carry a dimension under
  // several disciplines) — keep the most-observed.
  const byDim = new Map<string, SkillProfileRow>();
  for (const r of rows) {
    if (!dimensionByKey(r.dimension)) continue;
    const prev = byDim.get(r.dimension);
    if (!prev || (r.observation_count || 0) > (prev.observation_count || 0)) byDim.set(r.dimension, r);
  }
  if (byDim.size === 0) return null;

  const fmt = (r: SkillProfileRow): string => {
    const dim = dimensionByKey(r.dimension);
    const label = dim ? dim.label : r.dimension;
    const level = r.level_label || nearestLabel(Number(r.level));
    const conf = Math.round((r.confidence || 0) * 100);
    const trend = r.trend && r.trend !== 'stable' && r.trend !== 'new' ? `, ${r.trend}` : '';
    const obs = r.observation_count ? `, ${r.observation_count} obs` : '';
    return `- ${r.dimension} ${label}: ${level}${trend} (confidence ${conf}%${obs})`;
  };

  const writing = taxonomyOrder([...byDim.keys()].filter(k => k.startsWith('W'))).map(k => fmt(byDim.get(k)!));
  const maths = taxonomyOrder([...byDim.keys()].filter(k => k.startsWith('M'))).map(k => fmt(byDim.get(k)!));

  const sections: string[] = [];
  if (writing.length) sections.push('Writing:\n' + writing.join('\n'));
  if (maths.length) sections.push('Maths:\n' + maths.join('\n'));
  if (sections.length === 0) return null;

  return [
    `MEASURED SKILL LEVELS for this student (${SCALE_NOTE}), from ProofReady's skill database.`,
    `Use these to ANCHOR your synthesis: where your reading of the feedback and these levels agree, be specific and confident; do NOT claim progress or decline the levels don't support; do NOT restate a level as a mark, band, or percentage.`,
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * The cohort skill matrix (from computeSkillMatrix) as a compact prompt block.
 * Returns null when there's no cohort skill data.
 */
export function formatCohortSkillMatrix(matrix: SkillMatrix | null | undefined): string | null {
  if (!matrix) return null;
  const sections: string[] = [];
  for (const fam of [matrix.writing, matrix.maths]) {
    if (!fam) continue;
    const lines = fam.dimensions
      .filter(d => d.observed_students > 0)
      .map(d => {
        const belowOrAt = (d.distribution.emerging || 0) + (d.distribution.developing || 0);
        const focus = fam.focus_dimension === d.key ? '  [lowest — likely whole-cohort focus]' : '';
        // Surface confidence so the model can weight a thin distribution lightly:
        // a median resting mostly on low-confidence reads shouldn't override a
        // real prose gap.
        const conf = `avg confidence ${Math.round((d.avg_confidence || 0) * 100)}%`;
        const thin = d.low_confidence_students > 0 ? `, ${d.low_confidence_students} on thin evidence` : '';
        return `- ${d.key} ${d.label}: cohort median ${d.median_label}; ${belowOrAt}/${d.observed_students} at developing-or-below (${conf}${thin})${focus}`;
      });
    if (lines.length === 0) continue;
    const famName = fam.family === 'maths' ? 'Maths' : 'Writing';
    sections.push(`${famName} (${fam.student_count} students):\n` + lines.join('\n'));
  }
  if (sections.length === 0) return null;

  return [
    `MEASURED COHORT SKILL DISTRIBUTION (${SCALE_NOTE}), from ProofReady's skill database.`,
    `Anchor your patterns to these where they AGREE and the distribution is well-evidenced. Where a dimension's confidence is low (few observations / many on thin evidence), treat it as weak corroboration — it should NOT override a clear pattern in the feedback text. Do not restate levels as marks or bands.`,
    '',
    sections.join('\n\n'),
  ].join('\n');
}
