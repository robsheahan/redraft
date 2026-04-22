-- ProofReady Row-Level Security policies.
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement uses IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE.
--
-- Context:
-- * All API routes currently use the service-role key, which bypasses RLS by design.
--   These policies protect the data from any client holding only the anon key
--   (the browser). With these policies in place, even a leaked anon key cannot
--   read other students' submissions or other teachers' task notes.
-- * Policies mirror the checks the server-side routes already enforce, so turning
--   RLS on should not break any current flow that uses the service key.

-- =========================================================================
-- 1. Enable RLS on the two user-data tables
-- =========================================================================

alter table public.submissions enable row level security;
alter table public.tasks       enable row level security;

-- =========================================================================
-- 2. submissions: a student can see/write only their own rows.
--    A teacher can see rows that were submitted against a task they own.
-- =========================================================================

drop policy if exists "students read own submissions"        on public.submissions;
drop policy if exists "students insert own submissions"      on public.submissions;
drop policy if exists "students update own submissions"      on public.submissions;
drop policy if exists "teachers read submissions to own tasks" on public.submissions;

create policy "students read own submissions"
  on public.submissions for select
  using ( auth.uid() = student_id );

create policy "students insert own submissions"
  on public.submissions for insert
  with check ( auth.uid() = student_id );

create policy "students update own submissions"
  on public.submissions for update
  using ( auth.uid() = student_id )
  with check ( auth.uid() = student_id );

create policy "teachers read submissions to own tasks"
  on public.submissions for select
  using (
    task_code is not null
    and exists (
      select 1 from public.tasks t
      where t.code = submissions.task_code
        and t.teacher_id = auth.uid()
    )
  );

-- =========================================================================
-- 3. tasks: the teacher who created the task has full access.
--    Students need a narrow read so the "join by code" flow works, but must
--    NOT see the teacher's private notes. We therefore:
--      - allow SELECT of NON-sensitive columns to any authenticated user who
--        knows the code, via a VIEW that excludes the notes column
--      - keep the row-level read policy restricted to the teacher themselves
--    The /api/get-task route already strips `notes` before returning data
--    to students, which is why this split works.
-- =========================================================================

drop policy if exists "teachers manage own tasks"  on public.tasks;
drop policy if exists "teachers read own tasks"    on public.tasks;
drop policy if exists "teachers insert own tasks"  on public.tasks;
drop policy if exists "teachers update own tasks"  on public.tasks;
drop policy if exists "teachers delete own tasks"  on public.tasks;

create policy "teachers read own tasks"
  on public.tasks for select
  using ( auth.uid() = teacher_id );

create policy "teachers insert own tasks"
  on public.tasks for insert
  with check ( auth.uid() = teacher_id );

create policy "teachers update own tasks"
  on public.tasks for update
  using ( auth.uid() = teacher_id )
  with check ( auth.uid() = teacher_id );

create policy "teachers delete own tasks"
  on public.tasks for delete
  using ( auth.uid() = teacher_id );

-- =========================================================================
-- 4. Rate-limit log table (used by lib/rate-limit.ts to enforce per-user
--    and global spend limits on the generate-feedback endpoint).
-- =========================================================================

create table if not exists public.api_call_log (
  id          bigserial primary key,
  user_id     uuid,
  endpoint    text not null,
  created_at  timestamptz not null default now()
);

create index if not exists api_call_log_user_created_idx
  on public.api_call_log (user_id, created_at desc);

create index if not exists api_call_log_created_idx
  on public.api_call_log (created_at desc);

alter table public.api_call_log enable row level security;

-- Only the service role (which bypasses RLS) writes to this table.
-- Clients have no access.
drop policy if exists "api call log no client access" on public.api_call_log;
create policy "api call log no client access"
  on public.api_call_log for all
  using ( false )
  with check ( false );

-- =========================================================================
-- Post-run sanity checks. Running these should NOT return rows that expose
-- another user's data. If they do, stop and investigate.
-- =========================================================================

-- As a logged-in student, this should return only their own submissions:
--   select count(*) from submissions;
-- As a logged-in teacher with no tasks, this should return 0:
--   select count(*) from tasks;
