-- ProofReady skill taxonomy: per-submission signal capture + per-student rollup.
--
-- The "databasing" layer. Every submission is scored against the skill taxonomy
-- (data/skill-taxonomy.ts) at feedback time; the raw read is stored on the
-- submission, and a confidence/recency-weighted rollup accumulates per
-- (student, discipline, dimension). Insights, the longitudinal profile, and the
-- Lesson Builder all read the rollup.
--
-- Run once in Supabase SQL editor. Safe to re-run.

-- 1. Raw per-submission read (kept out of submissions.feedback so it never
--    reaches the student payload; this is system/teacher data).
alter table public.submissions
  add column if not exists skill_assessment jsonb;

comment on column public.submissions.skill_assessment is
  'Per-dimension developmental read captured at feedback time (ProofReady skill taxonomy). Diagnostic, never a mark/band. Not served to students.';

-- 2. Per-student rollup — the queryable engine.
create table if not exists public.student_skill_profile (
  student_id        uuid not null references auth.users(id) on delete cascade,
  discipline        text not null,            -- KLA grouping, e.g. 'English', 'PDHPE', 'Mathematics'
  dimension         text not null,            -- taxonomy key, e.g. 'W3', 'M2'
  level             numeric not null,         -- recency-weighted 1..5 (emerging..extending)
  level_label       text,                     -- nearest label for display
  confidence        numeric not null default 0, -- 0..1, grows with observation_count
  trend             text,                     -- 'improving' | 'stable' | 'regressing' | 'new'
  signal            text,                     -- latest actionable note (strength / failure mode)
  observation_count integer not null default 0,
  taxonomy_version  integer not null default 1,
  updated_at        timestamptz not null default now(),
  primary key (student_id, discipline, dimension)
);

create index if not exists student_skill_profile_student_idx
  on public.student_skill_profile (student_id);

-- RLS: students may read their own skill profile; teachers/leaders read via the
-- service-role API (scope enforced in lib/schools.ts), same posture as
-- student_profile_synthesis. Service role bypasses RLS for writes.
alter table public.student_skill_profile enable row level security;

drop policy if exists "student reads own skill profile" on public.student_skill_profile;
create policy "student reads own skill profile"
  on public.student_skill_profile for select
  using (auth.uid() = student_id);
