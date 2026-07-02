/**
 * Backfill skill_observations from existing submissions.skill_assessment.
 *
 * The observation history only starts accumulating from the moment the write
 * path ships. This replays every already-scored submission into the log so the
 * growth cards have depth on day one. Idempotent — the (submission_id, dimension)
 * unique index means re-running is a no-op, so it's safe to run repeatedly (e.g.
 * again after the write path has been live for a while, to catch any gaps).
 *
 *   npx tsx scripts/backfill-skill-observations.ts          # apply
 *   npx tsx scripts/backfill-skill-observations.ts --dry    # count only, no writes
 *
 * Prereq: scripts/skill-observations-migration.sql applied.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateSkillSignals } from '../lib/skill-profile.js';
import { familyForSubjectType, LEVEL_VALUE, TAXONOMY_VERSION, SkillFamily } from '../data/skill-taxonomy.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';

const envFile = join(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value.trim();
  }
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (try: vercel env pull .env.local)');
  process.exit(1);
}

const DRY = process.argv.includes('--dry');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGE = 1000;

// The submission carries no family flag, but the assessment's dimension keys do
// (W* = writing, M* = maths). Infer the family from the first recognised key so
// we validate against the right taxonomy half.
function inferFamily(assessment: any): SkillFamily | null {
  if (!Array.isArray(assessment)) return null;
  for (const a of assessment) {
    const d = a && typeof a.dimension === 'string' ? a.dimension : '';
    if (d.startsWith('W')) return 'writing';
    if (d.startsWith('M')) return 'maths';
  }
  return null;
}

async function main() {
  let from = 0;
  let scanned = 0, eligible = 0, rowsBuilt = 0, inserted = 0, skipped = 0;

  for (;;) {
    const { data, error } = await sb
      .from('submissions')
      .select('id, task_id, student_id, course, skill_assessment, graded_at, created_at')
      .not('skill_assessment', 'is', null)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) { console.error('read failed:', error.message); process.exit(1); }
    const rows = data || [];
    if (rows.length === 0) break;

    const toInsert: any[] = [];
    for (const s of rows) {
      scanned++;
      if (!s.student_id) continue;
      const family = inferFamily(s.skill_assessment);
      if (!family) continue;
      const signals = validateSkillSignals(s.skill_assessment, family);
      if (signals.length === 0) continue;
      eligible++;
      const discipline = (s.course ? getDisciplineForCourse(s.course) : null)
        || (family === 'maths' ? 'Mathematics' : 'General');
      const observedAt = s.graded_at || s.created_at || new Date().toISOString();
      for (const sig of signals) {
        toInsert.push({
          submission_id: s.id,
          task_id: s.task_id || null,
          student_id: s.student_id,
          discipline,
          family,
          dimension: sig.dimension,
          level: LEVEL_VALUE[sig.level],
          level_label: sig.level,
          confidence: sig.confidence || null,
          observed_at: observedAt,
          taxonomy_version: TAXONOMY_VERSION,
        });
      }
    }
    rowsBuilt += toInsert.length;

    if (!DRY && toInsert.length > 0) {
      // Chunk the upsert so a big page doesn't exceed statement limits.
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500);
        const { error: upErr, count } = await sb
          .from('skill_observations')
          .upsert(chunk, { onConflict: 'submission_id,dimension', ignoreDuplicates: true, count: 'exact' });
        if (upErr) { console.error('upsert failed:', upErr.message); process.exit(1); }
        inserted += count ?? 0;
        skipped += chunk.length - (count ?? 0);
      }
    }

    process.stdout.write(`\rscanned ${scanned} · eligible ${eligible} · rows ${rowsBuilt}` + (DRY ? '' : ` · inserted ${inserted} · skipped(existing) ${skipped}`));
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log('\n' + (DRY ? 'DRY RUN — no writes.' : 'Done.'));
  console.log(`submissions scanned: ${scanned}`);
  console.log(`with usable skill signals: ${eligible}`);
  console.log(`observation rows built: ${rowsBuilt}`);
  if (!DRY) {
    console.log(`inserted: ${inserted}`);
    console.log(`already present (skipped): ${skipped}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
