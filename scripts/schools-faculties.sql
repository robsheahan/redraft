-- Adds per-faculty scoping to leadership grants.
-- Run once in Supabase SQL Editor. Safe to re-run.
--
-- `faculties` is the list of NSW KLAs (English, Mathematics, Science, HSIE,
-- PDHPE, TAS, Creative Arts, Languages, VET) a leader is allowed to see
-- insights for. An empty array means "no restriction" — i.e. full access
-- to every faculty. Admins are unrestricted regardless of this value.

alter table public.school_members
  add column if not exists faculties text[] not null default '{}';

comment on column public.school_members.faculties is
  'Subset of NSW KLAs this leader can view. Empty array = all faculties (unrestricted). Ignored for role=admin (admins see everything).';
