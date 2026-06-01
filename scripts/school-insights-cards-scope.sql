-- Scope-key the school (leader/admin) cohort-card cache.
--
-- The cache was keyed by (school_id, card_kind): exactly one row per card kind
-- per school. With multiple faculty-scoped leaders plus an executive, their
-- differently-scoped cards collided on that single slot and overwrote each
-- other, so the same card was regenerated once per distinct scope per week.
--
-- This adds scope_key (the active filters) to the primary key so each scope
-- keeps its own card, and fingerprint (the in-scope corpus signature) so a
-- re-generate with no new submissions/marks is served from cache for free.
-- Mirrors teacher_insights_cards.
--
-- Existing rows pre-date scope_key, so they are dropped (cache repopulates on
-- next generate). Run once in Supabase SQL editor. Safe to re-run.

alter table public.school_insights_cards
  add column if not exists scope_key text not null default '',
  add column if not exists fingerprint text not null default '';

-- Clear legacy rows that have no scope_key (they would never be read again).
delete from public.school_insights_cards where scope_key = '';

alter table public.school_insights_cards
  drop constraint if exists school_insights_cards_pkey;

alter table public.school_insights_cards
  add constraint school_insights_cards_pkey
  primary key (school_id, card_kind, scope_key);

comment on column public.school_insights_cards.scope_key is
  'Stable string of the filters applied at generation time (class_id/faculty/course/year_level/time_window). Different scopes get their own cache row instead of overwriting one shared slot.';

comment on column public.school_insights_cards.fingerprint is
  'Signature of the in-scope submission corpus (count|latest_created|graded_count|mark_sum|latest_graded). A cached card is served only when the live fingerprint matches.';
