-- Schools + leadership membership.
-- Run once in Supabase SQL Editor. Safe to re-run.
--
-- Adds a generic `schools` table that links email-domain / LTI-platform
-- identity to a school, plus a `school_members` table for explicit
-- admin / leader role grants. The leadership insights dashboard scopes
-- its synthesis by the school the caller belongs to.

-- =========================================================================
-- 1. Schools
-- =========================================================================

create table if not exists public.schools (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  primary_domain   text,
  -- Pilots may bring multiple email domains (staff vs students), so
  -- secondary_domains is an array of additional matchable suffixes.
  secondary_domains text[] not null default '{}',
  -- Cached cross-faculty synthesis (jsonb). Populated by
  -- /api/insights-synthesis. Includes meta + content sections.
  insights_cache            jsonb,
  insights_cache_task_count integer,
  insights_cache_generated_at timestamptz,
  created_at       timestamptz not null default now()
);

create unique index if not exists schools_primary_domain_idx
  on public.schools (primary_domain)
  where primary_domain is not null;

-- =========================================================================
-- 2. School membership (explicit leadership grants only)
-- =========================================================================

-- Regular teacher/student membership is INFERRED from email domain / LTI
-- mapping at query time. This table only stores explicit admin and leader
-- roles for the insights dashboard.
create table if not exists public.school_members (
  school_id   uuid not null references public.schools(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin', 'leader')),
  created_at  timestamptz not null default now(),
  primary key (school_id, user_id)
);

create index if not exists school_members_user_idx
  on public.school_members (user_id);

create index if not exists school_members_school_role_idx
  on public.school_members (school_id, role);

-- =========================================================================
-- 3. Link lti_platforms to schools
-- =========================================================================

alter table public.lti_platforms
  add column if not exists school_id uuid references public.schools(id);

create index if not exists lti_platforms_school_idx
  on public.lti_platforms (school_id);

-- =========================================================================
-- 4. Backfill: one school per existing lti_platforms.school_name
-- =========================================================================

-- Create a school row for every distinct school_name on lti_platforms
-- that doesn't already have one linked.
insert into public.schools (name)
select distinct p.school_name
  from public.lti_platforms p
 where p.school_id is null
   and not exists (
     select 1 from public.schools s where s.name = p.school_name
   );

-- Link the platforms to those schools.
update public.lti_platforms p
   set school_id = s.id
  from public.schools s
 where p.school_id is null
   and p.school_name = s.name;

-- =========================================================================
-- 5. RLS (defence-in-depth; API uses service-role and bypasses)
-- =========================================================================

alter table public.schools        enable row level security;
alter table public.school_members enable row level security;

drop policy if exists "member reads own school" on public.schools;
create policy "member reads own school"
  on public.schools for select
  using (
    exists (
      select 1 from public.school_members m
       where m.school_id = schools.id and m.user_id = auth.uid()
    )
  );

drop policy if exists "user reads own membership" on public.school_members;
create policy "user reads own membership"
  on public.school_members for select
  using (auth.uid() = user_id);
