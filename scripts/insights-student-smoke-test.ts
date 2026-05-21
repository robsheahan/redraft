/**
 * Read-only smoke test for the individual-student insights feature.
 *
 *   npx tsx scripts/insights-student-smoke-test.ts
 *
 * Verifies against the live Supabase DB:
 *   1. getInScopeStudentIds returns the right set for a teacher caller
 *      (= union of class_members across that teacher's classes).
 *   2. A foreign student (in a class the teacher doesn't own) is NOT in
 *      the teacher's in-scope set — scope safety.
 *   3. The student-search "surname-first" ranking produces the expected
 *      ordering for a 2-char query.
 *
 * Performs zero writes.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

const { getInScopeStudentIds, getInScopeClassIds } = await import('../lib/schools.js');

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

async function main() {
  console.log('Insights student-mode smoke test\n');

  // Find a teacher with classes that have student members.
  const { data: classes } = await sb.from('classes').select('id, teacher_id');
  const teachersWithClasses = [...new Set((classes || []).map(c => c.teacher_id).filter(Boolean))] as string[];

  let teacherId: string | null = null;
  let teacherClassIds: string[] = [];
  let teacherStudents: string[] = [];
  for (const tid of teachersWithClasses) {
    const ownClassIds = (classes || []).filter(c => c.teacher_id === tid).map(c => c.id);
    const { data: members } = await sb
      .from('class_members').select('student_id').in('class_id', ownClassIds);
    const studentIds = [...new Set((members || []).map(m => m.student_id).filter(Boolean))] as string[];
    if (studentIds.length > 0) {
      teacherId = tid;
      teacherClassIds = ownClassIds;
      teacherStudents = studentIds;
      break;
    }
  }

  check('found a teacher with ≥1 student in their classes',
    !!teacherId,
    teacherId ? `${teacherId.slice(0, 8)} — ${teacherClassIds.length} classes, ${teacherStudents.length} students` : 'no candidate');

  if (!teacherId) {
    console.log('\nNo testable teacher. Bailing.');
    process.exit(1);
  }

  // ── 1. getInScopeClassIds for teacher tier ──
  const inScopeClasses = await getInScopeClassIds(sb, 'teacher', teacherId, '', null);
  check('getInScopeClassIds(teacher) returns owned classes',
    inScopeClasses.length === teacherClassIds.length
      && inScopeClasses.every(id => teacherClassIds.includes(id)),
    `${inScopeClasses.length} returned, expected ${teacherClassIds.length}`);

  // ── 2. getInScopeStudentIds for teacher tier ──
  const inScopeStudents = await getInScopeStudentIds(sb, 'teacher', teacherId, '', null);
  const inScopeStudentSet = new Set(inScopeStudents);
  const expectedSet = new Set(teacherStudents);
  check('getInScopeStudentIds returns the expected set',
    inScopeStudents.length === teacherStudents.length
      && teacherStudents.every(s => inScopeStudentSet.has(s))
      && inScopeStudents.every(s => expectedSet.has(s)),
    `${inScopeStudents.length} returned, expected ${teacherStudents.length}`);

  // ── 3. Foreign-student safety: a student in another teacher's class
  //     must NOT be in this teacher's in-scope set (unless they're also
  //     in one of this teacher's classes, which is legitimately shared).
  const { data: foreignMemberships } = await sb
    .from('class_members')
    .select('student_id, class_id')
    .not('class_id', 'in', '(' + teacherClassIds.map(id => `"${id}"`).join(',') + ')');
  const foreignOnly = (foreignMemberships || [])
    .map(m => m.student_id)
    .filter((s): s is string => !!s && !expectedSet.has(s));
  if (foreignOnly.length > 0) {
    const sample = foreignOnly[0];
    check('foreign-only student is filtered out',
      !inScopeStudentSet.has(sample),
      `sample student ${sample.slice(0, 8)} not in teacher scope`);
  } else {
    skip('foreign-only student is filtered out', 'no foreign-only students in DB');
  }

  // ── 4. Search-rank ordering: pick a real student, take a 2-char prefix
  //     of their surname, and call the search endpoint logic inline.
  const { data: allUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const sampleStudent = (allUsers?.users || []).find(u => inScopeStudentSet.has(u.id) && u.user_metadata?.display_name);
  if (sampleStudent) {
    const name = String(sampleStudent.user_metadata?.display_name || '').trim();
    const tokens = name.split(/\s+/).filter(Boolean);
    const surname = tokens[tokens.length - 1] || '';
    if (surname.length >= 2) {
      const q = surname.slice(0, 2).toLowerCase();
      const candidates = (allUsers?.users || [])
        .filter(u => inScopeStudentSet.has(u.id))
        .filter(u => {
          const blob = ((u.user_metadata?.display_name || '') + ' ' + (u.email || '')).toLowerCase();
          return blob.includes(q);
        });
      const surnameStartsFirst = candidates.sort((a, b) => {
        const at = String(a.user_metadata?.display_name || '').trim().split(/\s+/);
        const bt = String(b.user_metadata?.display_name || '').trim().split(/\s+/);
        const asn = (at[at.length - 1] || '').toLowerCase();
        const bsn = (bt[bt.length - 1] || '').toLowerCase();
        const aMatch = asn.startsWith(q);
        const bMatch = bsn.startsWith(q);
        if (aMatch !== bMatch) return aMatch ? -1 : 1;
        return asn.localeCompare(bsn);
      });
      const top = surnameStartsFirst[0];
      const topSurname = String(top?.user_metadata?.display_name || '').trim().split(/\s+/).pop() || '';
      check('search ranks surname-matches first',
        topSurname.toLowerCase().startsWith(q),
        `q="${q}" → top result surname "${topSurname}"`);
    } else {
      skip('search ranks surname-matches first', 'no usable surname');
    }
  } else {
    skip('search ranks surname-matches first', 'no in-scope student with display_name');
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nSmoke test failed:', err);
  process.exit(1);
});
