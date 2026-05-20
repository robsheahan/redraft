-- Per-card LLM cache for the leadership insights dashboard.
-- Each Tier-A card (bottom-decile mistakes, verb-depth handling, etc.)
-- gets its own Generate button + its own cached content. A new
-- generation overwrites the previous one for the same (school, card).
--
-- Run once in Supabase SQL Editor. Safe to re-run.

create table if not exists public.school_insights_cards (
  school_id              uuid not null references public.schools(id) on delete cascade,
  card_kind              text not null,
  content                jsonb,
  filters                jsonb not null default '{}',
  source_submission_count integer,
  source_task_count       integer,
  generated_at           timestamptz not null default now(),
  generated_by           uuid references auth.users(id),
  primary key (school_id, card_kind)
);

create index if not exists school_insights_cards_school_idx
  on public.school_insights_cards (school_id);

comment on column public.school_insights_cards.card_kind is
  'Identifier for which insight card this cache row belongs to (e.g. bottom_decile, top_decile, verb_depth_handling, common_gaps, things_done_well).';

comment on column public.school_insights_cards.filters is
  'Faculty/course/class filters applied at generation time. UI surfaces these so leaders know what scope the cached content reflects.';

alter table public.school_insights_cards enable row level security;

drop policy if exists "member reads own school cards" on public.school_insights_cards;
create policy "member reads own school cards"
  on public.school_insights_cards for select
  using (
    exists (
      select 1 from public.school_members m
       where m.school_id = school_insights_cards.school_id
         and m.user_id = auth.uid()
    )
  );
