-- Per-student insight-card cache (audit P5, caching half).
--
-- Student cards (student_top_mistakes / stretch_goals / strengths / summary)
-- were uncached — every Generate click was a full Sonnet call even when nothing
-- about the student had changed. The shared-key spend cap already bounds total
-- cost; this table removes the redundant spend by caching per
-- (student, kind, scope) with a corpus fingerprint, mirroring the cohort-card
-- cache (teacher_insights_cards / school_insights_cards).
--
-- scope_key encodes the caller's in-scope class set for this student, so two
-- callers with the same scope share a row and different scopes coexist (no
-- thrash). fingerprint is the in-scope submission corpus signature: a re-click
-- with no new drafts/marks returns the cached card for free; a new draft or
-- mark flips it and the next Generate re-runs.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.student_insights_cards (
  student_id              uuid not null references auth.users(id) on delete cascade,
  card_kind               text not null,
  scope_key               text not null,
  content                 jsonb not null,
  fingerprint             text not null,
  source_submission_count integer,
  source_task_count       integer,
  generated_at            timestamptz not null default now(),
  generated_by            uuid,
  primary key (student_id, card_kind, scope_key)
);

create index if not exists student_insights_cards_student_idx
  on public.student_insights_cards (student_id);

comment on column public.student_insights_cards.scope_key is
  'Stable hash of the caller''s in-scope class set for this student. Different scopes get different cache rows.';
comment on column public.student_insights_cards.fingerprint is
  'Signature of the student''s in-scope submission corpus. Cache served only when the live fingerprint matches.';

-- RLS: written/read by the API via the service-role client only. Unlike the
-- teacher cache, there is NO self-read policy — these cards are the teacher's
-- developmental read OF the student and must never be readable by that student.
-- Enable RLS with no policy ⇒ deny-all for anon/authenticated; service role
-- bypasses.
alter table public.student_insights_cards enable row level security;
