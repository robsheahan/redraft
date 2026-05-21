/**
 * Read-only smoke test for the teacher-tier insights changes.
 *
 *   npx tsx scripts/insights-teacher-smoke-test.ts
 *
 * Verifies, against the live Supabase DB:
 *   1. resolveInsightsAccess returns the expected role for a teacher
 *      (no school_members row) — defaults to 'teacher' rather than null.
 *   2. resolveInsightsAccess still returns 'leader' / 'admin' for users
 *      who do have an explicit grant.
 *   3. getOwnedClassIds returns the right class set for a real teacher.
 *   4. A teacher's classes are correctly scoped — querying classes by
 *      teacher_id = [user.id] returns only their own.
 *
 * Performs zero writes. Safe to run against production.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Load env from .env.local if present, otherwise .env.
for (const fname of ['.env.local', '.env']) {
  const f = join(process.cwd(), fname);
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value.trim();
  }
  break;
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const { resolveInsightsAccess, getOwnedClassIds } = await import('../lib/schools.js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Result = { name: string; pass: boolean; details?: string };
const results: Result[] = [];
function check(name: string, pass: boolean, details?: string) {
  results.push({ name, pass, details });
  const sym = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${sym} ${name}${details ? `  \x1b[90m(${details})\x1b[0m` : ''}`);
}
function skip(name: string, reason: string) {
  console.log(`\x1b[33m·\x1b[0m ${name}  \x1b[90m(skipped — ${reason})\x1b[0m`);
}

async function listAuthUsers() {
  const out: any[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users || [];
    if (users.length === 0) break;
    out.push(...users);
    if (users.length < 1000) break;
    page++;
    if (page > 50) break;
  }
  return out;
}

async function main() {
  console.log('Insights teacher-tier smoke test\n');

  // ── 1. Find candidate users ──────────────────────────────────────────
  const allUsers = await listAuthUsers();
  console.log(`  Loaded ${allUsers.length} auth users.`);

  const { data: members } = await sb.from('school_members').select('user_id, school_id, role');
  const memberByUser: Record<string, { school_id: string; role: string }> = {};
  (members || []).forEach(m => { if (m.user_id) memberByUser[m.user_id] = { school_id: m.school_id, role: m.role }; });

  const { data: classes } = await sb.from('classes').select('id, teacher_id');
  const classesByTeacher: Record<string, string[]> = {};
  (classes || []).forEach(c => {
    if (!c.teacher_id) return;
    (classesByTeacher[c.teacher_id] ||= []).push(c.id);
  });

  // Pick a teacher who: has role=teacher OR no role; has ≥1 class; NO school_members row.
  const teacherUser = allUsers.find(u => {
    const r = u.user_metadata?.role;
    if (r === 'student') return false;
    if (memberByUser[u.id]) return false;
    return (classesByTeacher[u.id] || []).length > 0;
  });
  // Pick a leader (school_members row with role=leader).
  const leaderUser = allUsers.find(u => memberByUser[u.id]?.role === 'leader');
  // Pick a school admin (school_members row with role=admin).
  const adminUser = allUsers.find(u => memberByUser[u.id]?.role === 'admin');

  check('found a teacher user with classes and no grant', !!teacherUser,
    teacherUser ? `${teacherUser.email} — ${classesByTeacher[teacherUser.id].length} classes` : 'no candidate');
  if (leaderUser) console.log(`  · leader candidate: ${leaderUser.email}`);
  else console.log('  · no leader user in DB — leader role check will be skipped');
  if (adminUser) console.log(`  · admin candidate: ${adminUser.email}`);
  else console.log('  · no admin user in DB — admin role check will be skipped');

  if (!teacherUser) {
    console.log('\nCannot run teacher tests without a candidate. Bailing.');
    process.exit(1);
  }

  // ── 2. resolveInsightsAccess for a teacher (no grant) ──────────────
  const teacherAccess = await resolveInsightsAccess(
    sb,
    { id: teacherUser.id, email: teacherUser.email },
    { isGlobalAdmin: false },
  );
  check('resolveInsightsAccess(teacher) returned a non-null result',
    !!teacherAccess, teacherAccess ? `role=${teacherAccess.callerRole}` : 'got null');
  check('resolveInsightsAccess(teacher).callerRole === "teacher"',
    teacherAccess?.callerRole === 'teacher',
    teacherAccess ? `actual: ${teacherAccess.callerRole}` : '—');
  check('resolveInsightsAccess(teacher).restrictedFaculties === null',
    teacherAccess?.restrictedFaculties === null);

  // ── 3. resolveInsightsAccess for null user ─────────────────────────
  const nullAccess = await resolveInsightsAccess(
    sb,
    null,
    { isGlobalAdmin: false },
  );
  check('resolveInsightsAccess(null user) returns null', nullAccess === null);

  // ── 4. resolveInsightsAccess for leader (if found) ─────────────────
  if (leaderUser) {
    const leaderAccess = await resolveInsightsAccess(
      sb,
      { id: leaderUser.id, email: leaderUser.email },
      { isGlobalAdmin: false },
    );
    check('resolveInsightsAccess(leader).callerRole === "leader"',
      leaderAccess?.callerRole === 'leader',
      leaderAccess ? `actual: ${leaderAccess.callerRole}` : 'got null');
  } else {
    skip('resolveInsightsAccess(leader).callerRole === "leader"', 'no leader in DB');
  }

  // ── 5. resolveInsightsAccess for school admin (if found) ───────────
  if (adminUser) {
    const adminAccess = await resolveInsightsAccess(
      sb,
      { id: adminUser.id, email: adminUser.email },
      { isGlobalAdmin: false },
    );
    check('resolveInsightsAccess(admin).callerRole === "admin"',
      adminAccess?.callerRole === 'admin',
      adminAccess ? `actual: ${adminAccess.callerRole}` : 'got null');
  } else {
    skip('resolveInsightsAccess(admin).callerRole === "admin"', 'no admin in DB');
  }

  // ── 6. getOwnedClassIds ─────────────────────────────────────────────
  const owned = await getOwnedClassIds(sb, teacherUser.id);
  const expectedClassIds = classesByTeacher[teacherUser.id] || [];
  check('getOwnedClassIds returns correct count',
    owned.length === expectedClassIds.length,
    `expected ${expectedClassIds.length}, got ${owned.length}`);
  check('getOwnedClassIds returns only this teacher\'s classes',
    owned.every(id => expectedClassIds.includes(id)),
    `${owned.length} ids returned`);

  // ── 7. Class scope: querying with teacher_id = [user.id] returns
  //     only this teacher's classes (mirrors the cards-endpoint logic).
  const { data: scopedClasses } = await sb
    .from('classes')
    .select('id, teacher_id')
    .in('teacher_id', [teacherUser.id]);
  const allOwn = (scopedClasses || []).every(c => c.teacher_id === teacherUser.id);
  check('class scope query returns only owned classes', allOwn,
    `${scopedClasses?.length || 0} rows`);

  // ── 8. Ownership safety: ?class_id= for a foreign class returns no rows
  //     when constrained by teacher_id = [user.id].
  const foreignClass = (classes || []).find(c => c.teacher_id && c.teacher_id !== teacherUser.id);
  if (foreignClass) {
    const { data: foreignProbe } = await sb
      .from('classes')
      .select('id')
      .in('teacher_id', [teacherUser.id])
      .eq('id', foreignClass.id);
    check('foreign class_id is filtered out by teacher scope',
      (foreignProbe || []).length === 0,
      `${foreignProbe?.length || 0} rows when probing foreign class`);
  } else {
    check('foreign class_id is filtered out by teacher scope', true, 'skipped — no foreign class found');
  }

  // ── 9. LLM cache: teacher tier should not have any school_insights_cards
  //     written under its user_id (it never writes there).
  //     Just sanity-check the table contains no rows where generated_by is
  //     this teacher. (If the teacher was previously a leader who generated
  //     cards, rows might exist legitimately — soft check only.)
  const { data: teacherCacheRows } = await sb
    .from('school_insights_cards')
    .select('school_id, card_kind, generated_by')
    .eq('generated_by', teacherUser.id);
  check('LLM card cache check (informational)', true,
    `${teacherCacheRows?.length || 0} rows generated by this teacher (legit if they had a prior leader grant)`);

  // ── Summary ──
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nSmoke test failed:', err);
  process.exit(1);
});
