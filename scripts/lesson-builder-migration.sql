-- Lesson Builder: per-student differentiated activities derived from one main task.
--
-- A teacher publishes a task "with Lesson Builder" (tasks.lesson_builder = true).
-- Each enrolled student then gets a version of the activity attuned to their
-- skill profile — generated lazily the first time they open the task and locked
-- thereafter. Students with no profile data get the main activity unchanged
-- (is_differentiated = false, no LLM call). The learning goal / criteria /
-- outcomes are identical for everyone; only the support layer differs.
--
-- Safe to run multiple times.

alter table public.tasks
  add column if not exists lesson_builder boolean not null default false;

create table if not exists public.task_activities (
  task_id                 uuid not null references public.tasks(id) on delete cascade,
  student_id              uuid not null references auth.users(id) on delete cascade,
  -- { question, scaffolding, focus, teacher_note }
  activity                jsonb not null,
  -- false = the student got the main activity unchanged (no profile data yet)
  is_differentiated       boolean not null default false,
  -- how developed the profile was when this variant was generated (transparency)
  source_submission_count integer not null default 0,
  taxonomy_version        integer not null default 1,
  generated_at            timestamptz not null default now(),
  primary key (task_id, student_id)
);
create index if not exists task_activities_task_idx on public.task_activities (task_id);

-- API writes/reads use the service key (bypasses RLS); these policies are
-- defence-in-depth for any direct client access.
alter table public.task_activities enable row level security;

drop policy if exists "student reads own activity" on public.task_activities;
create policy "student reads own activity" on public.task_activities
  for select using (auth.uid() = student_id);

drop policy if exists "teacher reads activities for own tasks" on public.task_activities;
create policy "teacher reads activities for own tasks" on public.task_activities
  for select using (
    exists (select 1 from public.tasks t where t.id = task_id and t.teacher_id = auth.uid())
  );
