-- Student academic profile (longitudinal) — cache table only.
-- Run once in Supabase SQL editor. Safe to re-run.
--
-- Concept:
--   A student's profile is an LLM-synthesised summary of their history of marked
--   submissions. It's generated on demand and cached in this table. The cache is
--   invalidated (row deleted) whenever new marking data arrives for the student,
--   so the next read regenerates fresh.
--
--   There is no separate "snapshot" or "skill taxonomy" table — the underlying
--   submissions already carry rich structured signals (feedback.improvements[],
--   feedback.strengths[], task_verb_check, criterion_marks, teacher_annotations)
--   that the synthesis pass reads directly. Recency-weighting and pattern
--   extraction happen inside the LLM prompt, not via a separate aggregation layer.
--
-- Privacy: rows contain LLM-synthesised text only — no raw draft quotes. Safe to
-- surface to any teacher who currently teaches the student.

create table if not exists public.student_profile_synthesis (
  student_id                      uuid not null references auth.users(id) on delete cascade,
  narrative                       text,            -- 4–6 sentence growth narrative (no quoted drafts)
  headline_strength               text,            -- one-line: most consistent strength
  headline_priority               text,            -- one-line: most useful next step
  metrics                         jsonb,           -- { mark_trend, improvement_themes, strength_themes, recent_mark_avg, … }
  submission_count_at_generation  int  not null default 0,
  generated_at                    timestamptz not null default now(),
  primary key (student_id)
);

create index if not exists student_profile_synthesis_generated_idx
  on public.student_profile_synthesis (generated_at);

-- RLS: students can read their own profile via authenticated client.
-- Teachers read via the API (service-role); access is enforced in lib/schools.ts
-- by requiring the student to be in one of the caller's in-scope classes.
alter table public.student_profile_synthesis enable row level security;

drop policy if exists "student reads own profile" on public.student_profile_synthesis;
create policy "student reads own profile"
  on public.student_profile_synthesis for select
  using (auth.uid() = student_id);
