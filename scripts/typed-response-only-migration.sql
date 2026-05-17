-- Typed-only mode + writing-environment rebuild.
-- Run once in Supabase SQL Editor. Idempotent (re-runnable safely).

-- 1. Tasks: per-task typed-only flag. Defaults TRUE so new tasks enforce typing
--    unless the teacher opts out. Existing tasks pick up the default; if you
--    want to leave the pilot's in-flight tasks paste-allowed, run an UPDATE
--    after this migration to set them to false.

alter table public.tasks
  add column if not exists typed_response_only boolean not null default true;

-- 2. Submissions: typing telemetry captured client-side, persisted on save.

alter table public.submissions
  add column if not exists keystroke_count            integer,
  add column if not exists paste_attempts_blocked     integer,
  add column if not exists typing_session_count       integer,
  add column if not exists total_typing_time_ms       integer,
  add column if not exists time_to_first_keystroke_ms integer;

-- 3. Draft autosaves: persistent in-progress state. One row per
--    (student, task). Cleared when the student submits a draft for feedback.

create table if not exists public.draft_autosaves (
  student_id   uuid not null references auth.users(id) on delete cascade,
  task_id      uuid not null references public.tasks(id) on delete cascade,
  draft_text   text not null default '',
  telemetry    jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (student_id, task_id)
);

create index if not exists draft_autosaves_task_idx
  on public.draft_autosaves (task_id);

alter table public.draft_autosaves enable row level security;

drop policy if exists "students read own autosaves"   on public.draft_autosaves;
drop policy if exists "students insert own autosaves" on public.draft_autosaves;
drop policy if exists "students update own autosaves" on public.draft_autosaves;
drop policy if exists "students delete own autosaves" on public.draft_autosaves;

create policy "students read own autosaves"
  on public.draft_autosaves for select
  using (auth.uid() = student_id);

create policy "students insert own autosaves"
  on public.draft_autosaves for insert
  with check (auth.uid() = student_id);

create policy "students update own autosaves"
  on public.draft_autosaves for update
  using (auth.uid() = student_id)
  with check (auth.uid() = student_id);

create policy "students delete own autosaves"
  on public.draft_autosaves for delete
  using (auth.uid() = student_id);
