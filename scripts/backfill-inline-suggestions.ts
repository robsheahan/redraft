/**
 * Backfill inline_suggestions (Pass 3) for existing submissions.
 *
 * Finds submissions whose feedback JSON does not yet contain inline_suggestions,
 * runs Pass 3 against each draft using the holistic improvements already stored
 * on the row, and writes the result back into the feedback column.
 *
 * Safety:
 * - --dry-run prints counts + cost estimate without calling Claude or writing
 * - --limit N caps how many rows are processed in this run
 * - Sequential with a small pause between calls so we don't hammer the API
 * - Idempotent — rows that already have inline_suggestions are skipped, so
 *   re-running after a crash picks up where it left off
 *
 * Run:
 *   npx tsx scripts/backfill-inline-suggestions.ts --dry-run
 *   npx tsx scripts/backfill-inline-suggestions.ts --limit 5
 *   npx tsx scripts/backfill-inline-suggestions.ts
 *
 * Requires in .env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateInlineSuggestions } from '../lib/generate-inline-suggestions.js';
import { extractTaskVerbs } from '../lib/task-verbs.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length > 0) process.env[key.trim()] = rest.join('=').trim();
  }
} catch { /* .env optional */ }

// --- CLI flags ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
// --retry-empty: also reprocess rows whose inline_suggestions is an empty array.
// Useful after a failed run left rows marked "done but empty" by accident.
const RETRY_EMPTY = args.includes('--retry-empty');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i !== -1 && args[i + 1]) return parseInt(args[i + 1], 10);
  return Infinity;
})();

// Rough cost estimate: ~2k input + ~1.5k output tokens per call on Sonnet 4.6.
// $3/Mtok input + $15/Mtok output ≈ $0.028 per submission.
const EST_COST_PER_ROW_USD = 0.028;
const PAUSE_MS = 400;

interface Row {
  id: string;
  student_id: string;
  task_code: string | null;
  question: string;
  course: string | null;
  draft_text: string;
  feedback: any;
  draft_version: number;
}

async function main() {
  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY must be set.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  console.log('Fetching submissions that need backfilling...');
  const { data, error } = await supabase
    .from('submissions')
    .select('id, student_id, task_code, question, course, draft_text, feedback, draft_version')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Supabase fetch failed:', error.message);
    process.exit(1);
  }

  const all: Row[] = (data || []) as Row[];
  const needsBackfill = all.filter(r => {
    if (!r.feedback || typeof r.feedback !== 'object') return false;
    if (!r.draft_text) return false;
    const existing = r.feedback.inline_suggestions;
    if (Array.isArray(existing)) {
      // Skip already-populated unless --retry-empty was passed and the array is empty.
      if (RETRY_EMPTY && existing.length === 0) return true;
      return false;
    }
    return true;
  });

  console.log(`\nTotal submissions in DB: ${all.length}`);
  console.log(`Already have inline_suggestions: ${all.length - needsBackfill.length}`);
  console.log(`Need backfill: ${needsBackfill.length}${RETRY_EMPTY ? ' (includes rows with empty annotations due to --retry-empty)' : ''}`);

  const toProcess = needsBackfill.slice(0, LIMIT);
  console.log(`Will process this run: ${toProcess.length}${LIMIT !== Infinity ? ` (--limit ${LIMIT})` : ''}`);
  console.log(`Estimated cost: $${(toProcess.length * EST_COST_PER_ROW_USD).toFixed(2)}`);

  if (DRY_RUN) {
    console.log('\n--dry-run set — no Claude calls, no DB writes. Re-run without --dry-run to execute.');
    return;
  }

  if (toProcess.length === 0) {
    console.log('\nNothing to do.');
    return;
  }

  console.log('\nStarting backfill...\n');

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const label = `[${i + 1}/${toProcess.length}] ${row.id.slice(0, 8)} (${row.task_code || 'no-task'} v${row.draft_version})`;

    try {
      const improvementsSummary = Array.isArray(row.feedback?.improvements?.summary)
        ? row.feedback.improvements.summary
        : [];

      if (improvementsSummary.length === 0) {
        // Pass 3 can still run without prior improvements, but coherence is the whole point.
        // Warn but proceed — better annotations than none.
        console.log(`${label} — warning: no improvements in stored feedback, proceeding anyway`);
      }

      const taskVerbs = extractTaskVerbs(row.question || '');
      const discipline = row.course ? getDisciplineForCourse(row.course) : null;
      const taskDescription = row.course
        ? `${row.course}\n\nQuestion:\n${row.question}`
        : `Question:\n${row.question}`;

      const t0 = Date.now();
      const result = await generateInlineSuggestions(anthropic, {
        taskDescription,
        taskVerbs: taskVerbs.length > 0 ? taskVerbs : undefined,
        studentText: row.draft_text,
        holisticImprovements: improvementsSummary,
        courseName: row.course || undefined,
        discipline: discipline || undefined,
      });
      const ms = Date.now() - t0;

      if (!result.ok) {
        console.error(`${label} — Claude call failed: ${result.error} — skipping write`);
        failed++;
      } else {
        const updatedFeedback = { ...row.feedback, inline_suggestions: result.annotations };
        const { error: updateErr } = await supabase
          .from('submissions')
          .update({ feedback: updatedFeedback })
          .eq('id', row.id);

        if (updateErr) {
          console.error(`${label} — DB update failed: ${updateErr.message}`);
          failed++;
        } else {
          console.log(`${label} — ${result.annotations.length} annotations (${ms}ms)`);
          ok++;
        }
      }
    } catch (err: any) {
      console.error(`${label} — exception: ${err?.message || err}`);
      failed++;
    }

    if (i < toProcess.length - 1) await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  const totalS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${totalS}s. Updated: ${ok}, skipped: ${skipped}, failed: ${failed}.`);
  console.log(`Approx spend: $${(ok * EST_COST_PER_ROW_USD).toFixed(2)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
