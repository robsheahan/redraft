-- Classes redesign — migration.
-- Run once in Supabase SQL Editor (Project → SQL Editor → New query).
-- This is DESTRUCTIVE of existing pilot data (tasks + submissions). Rob confirmed
-- that's OK because the existing rows are test data.

-- =========================================================================
-- 1. Wipe existing task/submission data
-- =========================================================================

delete from public.submissions;
delete from public.tasks;

-- =========================================================================
-- 2. Create classes + class_members tables
-- =========================================================================

create table if not exists public.classes (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  teacher_id   uuid not null,
  name         text not null,
  course       text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists classes_teacher_idx on public.classes (teacher_id);
create index if not exists classes_code_idx on public.classes (code);

create table if not exists public.class_members (
  class_id    uuid not null references public.classes(id) on delete cascade,
  student_id  uuid not null,
  joined_at   timestamptz not null default now(),
  primary key (class_id, student_id)
);

create index if not exists class_members_student_idx on public.class_members (student_id);

-- =========================================================================
-- 3. Drop old RLS policies that reference tasks.code, so we can drop the column.
--    The new versions are recreated in section 6 below against the new schema.
-- =========================================================================

drop policy if exists "teachers read submissions to own tasks" on public.submissions;
drop policy if exists "students insert own submissions"        on public.submissions;

-- =========================================================================
-- 4. Reshape tasks: add class_id + published_at, drop code + class_name
-- =========================================================================

alter table public.tasks add column if not exists class_id uuid references public.classes(id) on delete cascade;
alter table public.tasks add column if not exists published_at timestamptz;
alter table public.tasks drop column if exists class_name;
alter table public.tasks drop column if exists code;

create index if not exists tasks_class_idx on public.tasks (class_id);

-- =========================================================================
-- 4. Reshape submissions: task_code → task_id
-- =========================================================================

alter table public.submissions drop column if exists task_code;
alter table public.submissions add column if not exists task_id uuid references public.tasks(id) on delete cascade;

create index if not exists submissions_task_idx on public.submissions (task_id);

-- =========================================================================
-- 5. Row-Level Security on new tables
-- =========================================================================

alter table public.classes enable row level security;
alter table public.class_members enable row level security;

drop policy if exists "teachers read own classes"   on public.classes;
drop policy if exists "teachers insert own classes" on public.classes;
drop policy if exists "teachers update own classes" on public.classes;
drop policy if exists "teachers delete own classes" on public.classes;
drop policy if exists "members read their classes"  on public.classes;

create policy "teachers read own classes"
  on public.classes for select
  using ( auth.uid() = teacher_id );

create policy "teachers insert own classes"
  on public.classes for insert
  with check ( auth.uid() = teacher_id );

create policy "teachers update own classes"
  on public.classes for update
  using ( auth.uid() = teacher_id )
  with check ( auth.uid() = teacher_id );

create policy "teachers delete own classes"
  on public.classes for delete
  using ( auth.uid() = teacher_id );

-- Students who are members can read the class row
create policy "members read their classes"
  on public.classes for select
  using (
    exists (
      select 1 from public.class_members m
      where m.class_id = classes.id and m.student_id = auth.uid()
    )
  );

drop policy if exists "students read own memberships"   on public.class_members;
drop policy if exists "students insert own membership"  on public.class_members;
drop policy if exists "students delete own membership"  on public.class_members;
drop policy if exists "teachers read memberships in own classes" on public.class_members;
drop policy if exists "teachers delete memberships in own classes" on public.class_members;

create policy "students read own memberships"
  on public.class_members for select
  using ( auth.uid() = student_id );

create policy "students insert own membership"
  on public.class_members for insert
  with check ( auth.uid() = student_id );

create policy "students delete own membership"
  on public.class_members for delete
  using ( auth.uid() = student_id );

create policy "teachers read memberships in own classes"
  on public.class_members for select
  using (
    exists (
      select 1 from public.classes c
      where c.id = class_members.class_id and c.teacher_id = auth.uid()
    )
  );

create policy "teachers delete memberships in own classes"
  on public.class_members for delete
  using (
    exists (
      select 1 from public.classes c
      where c.id = class_members.class_id and c.teacher_id = auth.uid()
    )
  );

-- =========================================================================
-- 6. Update submissions + tasks policies to use new task_id / class_id
-- =========================================================================

drop policy if exists "teachers read submissions to own tasks" on public.submissions;
create policy "teachers read submissions to own tasks"
  on public.submissions for select
  using (
    task_id is not null
    and exists (
      select 1 from public.tasks t
      join public.classes c on c.id = t.class_id
      where t.id = submissions.task_id
        and c.teacher_id = auth.uid()
    )
  );

-- Students can only insert submissions against tasks in classes they're in.
-- Existing "students insert own submissions" policy only checks student_id;
-- tighten it so tasks must be published and student must be a member.
drop policy if exists "students insert own submissions" on public.submissions;
create policy "students insert own submissions"
  on public.submissions for insert
  with check (
    auth.uid() = student_id
    and (
      task_id is null  -- own-task flow (no task_id set)
      or exists (
        select 1 from public.tasks t
        where t.id = submissions.task_id
          and t.published_at is not null
          and exists (
            select 1 from public.class_members m
            where m.class_id = t.class_id and m.student_id = auth.uid()
          )
      )
    )
  );
