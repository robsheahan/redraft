/**
 * Backfill the authoritative role into app_metadata (Q2A).
 *
 * Role used to live only in user_metadata, which the user can rewrite from
 * their own browser. The authoritative copy now lives in app_metadata (service
 * role only). This copies each existing user's user_metadata.role →
 * app_metadata.role so the server gates (which read app_metadata.role) keep
 * recognising current teachers/students after deploy.
 *
 * RUN THIS BEFORE DEPLOYING the Q2A code change. The gates fail closed: until a
 * user has app_metadata.role, they're treated as a non-teacher. So a teacher
 * would briefly lose teacher access if the code ships before this backfill.
 *
 * Safety:
 * - --dry-run prints what would change without writing.
 * - Idempotent: users that already have app_metadata.role are skipped, so it's
 *   safe to re-run after an interruption.
 *
 * Run:
 *   npx tsx scripts/backfill-role-to-app-metadata.ts --dry-run
 *   npx tsx scripts/backfill-role-to-app-metadata.ts
 *
 * Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const envFile = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length > 0) process.env[key.trim()] = rest.join('=').trim();
  }
} catch { /* .env optional */ }

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  let page = 1;
  const perPage = 200;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
    const users = data.users;
    if (users.length === 0) break;

    for (const u of users) {
      scanned++;
      const appRole = (u.app_metadata as any)?.role;
      const metaRole = (u.user_metadata as any)?.role;

      if (appRole) { skipped++; continue; }          // already authoritative
      if (metaRole !== 'teacher' && metaRole !== 'student') { skipped++; continue; } // nothing to copy

      if (DRY_RUN) {
        console.log(`would set app_metadata.role='${metaRole}' for ${u.email} (${u.id})`);
        updated++;
        continue;
      }

      const { error: updErr } = await supabase.auth.admin.updateUserById(u.id, {
        app_metadata: { ...(u.app_metadata || {}), role: metaRole },
      });
      if (updErr) {
        console.error(`  FAILED ${u.email}: ${updErr.message}`);
      } else {
        updated++;
        console.log(`  set app_metadata.role='${metaRole}' for ${u.email}`);
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned}, ${DRY_RUN ? 'would update' : 'updated'} ${updated}, skipped ${skipped}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
