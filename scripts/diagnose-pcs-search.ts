import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const envFile = join(process.cwd(), '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
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

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PCS_HOST = 'learningpcs.instructure.com';

function line(label: string, value: string | number) {
  console.log(`  ${label.padEnd(36)} ${value}`);
}
function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// 1. Resolve the PCS platform + school row
section('1. PCS platform / school row');
const { data: platforms, error: platErr } = await sb
  .from('lti_platforms')
  .select('id, client_id, deployment_id, hostname, school_id, school_name, issuer');
if (platErr) { console.error(platErr); process.exit(1); }

const pcsPlatform = platforms?.find(p => p.hostname === PCS_HOST);
if (!pcsPlatform) {
  console.error(`No lti_platforms row with hostname ${PCS_HOST}. All platforms:`);
  console.log(platforms);
  process.exit(1);
}
line('platform_id', pcsPlatform.id);
line('issuer', pcsPlatform.issuer);
line('client_id', pcsPlatform.client_id);
line('deployment_id', pcsPlatform.deployment_id);
line('school_id (FK)', pcsPlatform.school_id || '(none)');
line('school_name (on platform row)', pcsPlatform.school_name || '(none)');

if (!pcsPlatform.school_id) {
  console.error('\nPCS platform has no school_id FK — admin-scope queries cannot resolve it to a school.');
}

const { data: school } = pcsPlatform.school_id
  ? await sb.from('schools').select('id, name, primary_domain, secondary_domains').eq('id', pcsPlatform.school_id).maybeSingle()
  : { data: null };
if (school) {
  line('schools.name', school.name);
  line('schools.primary_domain', school.primary_domain || '(null)');
  line('schools.secondary_domains', JSON.stringify(school.secondary_domains || []));
}

// 2. LTI user mappings on this platform
section('2. lti_user_mappings on PCS platform');
const { data: mappings } = await sb
  .from('lti_user_mappings')
  .select('user_id, email, canvas_user_id, last_seen_at')
  .eq('platform_id', pcsPlatform.id);
line('total mappings', mappings?.length || 0);

const userIds = (mappings || []).map(m => m.user_id).filter(Boolean) as string[];

// Pull auth.users for those mapped users (paginate)
async function fetchUsers(ids: string[]) {
  const out: any[] = [];
  let page = 1;
  while (true) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users || [];
    if (users.length === 0) break;
    out.push(...users);
    if (users.length < 1000) break;
    page++;
    if (page > 20) break;
  }
  return out.filter(u => ids.includes(u.id));
}
const mappedUsers = await fetchUsers(userIds);
const roles = mappedUsers.reduce<Record<string, number>>((acc, u) => {
  const r = u.user_metadata?.role || '(unset)';
  acc[r] = (acc[r] || 0) + 1;
  return acc;
}, {});
line('role breakdown', Object.entries(roles).map(([r, n]) => `${r}=${n}`).join(', ') || '(none)');

// Sample 5 mapped users so Rob can see what's stored
console.log('\n  sample of mapped users:');
for (const u of mappedUsers.slice(0, 8)) {
  const meta = u.user_metadata || {};
  console.log(`    ${u.id.slice(0, 8)}…  role=${meta.role || '-'}  email=${u.email || '(none)'}  display="${meta.display_name || meta.full_name || meta.name || ''}"`);
}

// 3. Classes owned by any PCS teacher
section('3. Classes owned by PCS teachers');
const teacherIds = mappedUsers.filter(u => (u.user_metadata?.role || null) !== 'student').map(u => u.id);
line('PCS teacher count (non-student mapped users)', teacherIds.length);

let classRows: any[] = [];
if (teacherIds.length > 0) {
  const { data } = await sb.from('classes').select('id, name, teacher_id, archived_at').in('teacher_id', teacherIds);
  classRows = data || [];
}
line('classes where teacher_id IN PCS teachers', classRows.length);
const activeClasses = classRows.filter(c => !c.archived_at);
line('… of which active (archived_at IS NULL)', activeClasses.length);

if (classRows.length > 0) {
  console.log('\n  classes:');
  for (const c of classRows.slice(0, 10)) {
    console.log(`    ${c.id.slice(0, 8)}…  teacher=${(c.teacher_id || '').slice(0, 8)}…  name="${c.name}" archived=${c.archived_at ? 'yes' : 'no'}`);
  }
}

// 4. lti_course_mappings on PCS platform
section('4. lti_course_mappings on PCS platform');
const { data: courseMaps } = await sb
  .from('lti_course_mappings')
  .select('canvas_course_id, class_id, lti_lineitems_url')
  .eq('platform_id', pcsPlatform.id);
line('course mappings', courseMaps?.length || 0);
line('outbound assignment-ready courses', (courseMaps || []).filter(m => !!m.lti_lineitems_url).length);
for (const m of (courseMaps || []).slice(0, 8)) {
  console.log(`    canvas_course=${m.canvas_course_id}  class=${(m.class_id || '').slice(0, 8)}…  assignments=${m.lti_lineitems_url ? 'ready' : 'needs teacher relaunch'}`);
}

// 5. class_members for those classes
section('5. class_members in PCS-owned classes');
const classIds = activeClasses.map(c => c.id);
let memberCount = 0;
let distinctStudents = 0;
let members: Array<{ student_id: string; class_id: string }> = [];
if (classIds.length > 0) {
  const { data } = await sb.from('class_members').select('student_id, class_id').in('class_id', classIds);
  members = (data || []) as Array<{ student_id: string; class_id: string }>;
  memberCount = members?.length || 0;
  distinctStudents = new Set((members || []).map(m => m.student_id)).size;
}
line('class_members rows', memberCount);
line('distinct student_ids', distinctStudents);
if (classRows.length > 0) {
  console.log('\n  membership by mapped Canvas course:');
  for (const mapping of (courseMaps || [])) {
    const klass = classRows.find(c => c.id === mapping.class_id);
    const count = members.filter(m => m.class_id === mapping.class_id).length;
    console.log(`    ${String(count).padStart(3)} students  canvas_course=${mapping.canvas_course_id}  class="${klass?.name || mapping.class_id}"`);
  }
}

const memberUserIds = new Set(members.map(m => m.student_id));
const mappedStudentIds = new Set(mappedUsers
  .filter(u => (u.user_metadata?.role || null) === 'student')
  .map(u => u.id));
const mappedOutsideCurrentClasses = [...mappedStudentIds].filter(id => !memberUserIds.has(id));
line('mapped students outside current classes', mappedOutsideCurrentClasses.length);

// 6. Submissions in those classes
section('6. Submissions in PCS-owned classes');
if (classIds.length > 0) {
  const { data: tasks } = await sb.from('tasks').select('id').in('class_id', classIds);
  const taskIds = (tasks || []).map(t => t.id);
  line('tasks', taskIds.length);
  if (taskIds.length > 0) {
    const { data: subs } = await sb.from('submissions').select('id, student_id, graded_at, submitted_for_marking').in('task_id', taskIds);
    line('submissions', subs?.length || 0);
    line('… graded', (subs || []).filter(s => s.graded_at).length);
    line('… submitted_for_marking', (subs || []).filter(s => s.submitted_for_marking).length);
  }
}

// 7. Diagnosis
section('7. Diagnosis');
if (mappedUsers.length === 0) {
  console.log('  Nobody has LTI-launched PCS yet. Search will be empty for everyone.');
} else if (teacherIds.length === 0) {
  console.log('  PCS has mapped users but none are non-student — no one can own classes.');
} else if (classRows.length === 0) {
  console.log('  PCS teachers exist but have NO classes. The roster-sync NRPS path needs a class to attach members to,');
  console.log('  and admin-scope search builds students from class_members, so search will be empty.');
  console.log('  Path forward: a PCS teacher needs to LTI-launch a Canvas course context (creates classes row via');
  console.log('  provisionClass) — or create a class via the normal UI. NRPS won\'t fire without a teacher launch.');
} else if (memberCount === 0) {
  console.log('  Classes exist but class_members is empty. NRPS roster sync either hasn\'t run or skipped everyone');
  console.log('  for missing emails. Check Canvas dev-key privacy level = "public".');
} else if (mappedOutsideCurrentClasses.length > 0) {
  console.log(`  PARTIAL ROSTER WARNING: ${mappedOutsideCurrentClasses.length} mapped students are not enrolled in any current PCS class.`);
  console.log('  This is consistent with historical roster syncs being interrupted after account mapping but before class enrolment.');
  console.log('  Have each owning teacher launch ProofReady from Canvas course navigation again, wait briefly, then rerun this diagnostic.');
  console.log('  The current waitUntil-based sync is idempotent and should attach existing mapped students without duplicating accounts.');
} else {
  console.log(`  Looks healthy: ${classIds.length} active classes, ${distinctStudents} students in scope.`);
  console.log('  Search should return these students. If it still doesn\'t, log the API response in DevTools.');
}
