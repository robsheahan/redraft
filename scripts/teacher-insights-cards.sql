-- Per-teacher cohort-card cache.
--
-- The school-keyed school_insights_cards table cannot hold teacher-tier cards:
-- a teacher card is scoped to their own class(es), so it would collide with
-- the school view card for the same (school, kind). Historically the teacher
-- tier therefore bypassed the cache entirely and regenerated on every click,
-- a full Sonnet call each time, even when nothing in the cohort had changed.
--
-- This table caches teacher-tier cards keyed by (teacher, kind, scope). A
-- fingerprint over the in-scope submission corpus (count + latest activity +
-- mark signature) decides freshness: re-clicking Generate with no new
-- submissions or marks returns the cached card for free. The fingerprint flips
-- whenever a new draft lands or a mark changes, so the card never goes stale on
-- real activity.
--
-- Run once in Supabase SQL editor. Safe to re-run.

create table if not exists public.teacher_insights_cards (
  teacher_id              uuid not null references auth.users(id) on delete cascade,
  card_kind               text not null,
  scope_key               text not null,
  content                 jsonb not null,
  fingerprint             text not null,
  source_submission_count integer,
  source_task_count       integer,
  generated_at            timestamptz not null default now(),
  primary key (teacher_id, card_kind, scope_key)
);

create index if not exists teacher_insights_cards_teacher_idx
  on public.teacher_insights_cards (teacher_id);

comment on column public.teacher_insights_cards.scope_key is
  'Stable string of the filters applied at generation time (class_id/faculty/course/year_level/time_window). Different scopes get different cache rows.';

comment on column public.teacher_insights_cards.fingerprint is
  'Signature of the in-scope submission corpus (count|latest_created|graded_count|mark_sum|latest_graded). Cache is served only when the live fingerprint matches.';

-- RLS: written and read by the API via the service-role client (scope already
-- enforced by teacher_id = caller). A teacher may also read their own rows
-- directly under an authenticated client.
alter table public.teacher_insights_cards enable row level security;

drop policy if exists "teacher reads own cards" on public.teacher_insights_cards;
create policy "teacher reads own cards"
  on public.teacher_insights_cards for select
  using (auth.uid() = teacher_id);
