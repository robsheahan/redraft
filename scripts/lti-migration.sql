-- LTI 1.3 integration tables.
-- Run once in Supabase SQL Editor.
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT.

-- =========================================================================
-- 1. Platforms (one row per Canvas instance we're integrated with)
-- =========================================================================

create table if not exists public.lti_platforms (
  id                uuid primary key default gen_random_uuid(),
  school_name       text not null,
  issuer            text not null,
  client_id         text not null,
  deployment_id     text not null,
  hostname          text not null,
  jwks_url          text not null,
  auth_login_url    text not null,
  auth_token_url    text not null,
  created_at        timestamptz not null default now(),
  unique (issuer, client_id, deployment_id)
);

create index if not exists lti_platforms_issuer_idx
  on public.lti_platforms (issuer, client_id);

-- =========================================================================
-- 2. Nonces (replay protection for the OIDC handshake)
-- =========================================================================

create table if not exists public.lti_nonces (
  nonce         text primary key,
  state         text not null,
  platform_id   uuid not null references public.lti_platforms(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '10 minutes'),
  consumed_at   timestamptz
);

create index if not exists lti_nonces_state_idx on public.lti_nonces (state);
create index if not exists lti_nonces_expires_idx on public.lti_nonces (expires_at);

-- =========================================================================
-- 3. User mappings (Canvas user_id → auth.users.id)
-- =========================================================================

create table if not exists public.lti_user_mappings (
  id              uuid primary key default gen_random_uuid(),
  platform_id     uuid not null references public.lti_platforms(id) on delete cascade,
  canvas_user_id  text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  email           text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (platform_id, canvas_user_id)
);

create index if not exists lti_user_mappings_user_idx
  on public.lti_user_mappings (user_id);

-- =========================================================================
-- 4. Course mappings (Canvas course_id → classes.id)
-- =========================================================================

create table if not exists public.lti_course_mappings (
  id                uuid primary key default gen_random_uuid(),
  platform_id       uuid not null references public.lti_platforms(id) on delete cascade,
  canvas_course_id  text not null,
  class_id          uuid not null references public.classes(id) on delete cascade,
  created_at        timestamptz not null default now(),
  unique (platform_id, canvas_course_id)
);

create index if not exists lti_course_mappings_class_idx
  on public.lti_course_mappings (class_id);

-- =========================================================================
-- 4b. Deep-linking sessions (short-lived state between launch and picker)
-- =========================================================================

create table if not exists public.lti_dl_sessions (
  token                 text primary key,
  platform_id           uuid not null references public.lti_platforms(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  class_id              uuid references public.classes(id) on delete cascade,
  deep_linking_settings jsonb not null,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null default (now() + interval '1 hour')
);

create index if not exists lti_dl_sessions_user_idx
  on public.lti_dl_sessions (user_id);

-- =========================================================================
-- 5. Per-task LTI metadata (for deep linking + AGS line items)
-- =========================================================================

alter table public.tasks add column if not exists lti_platform_id        uuid references public.lti_platforms(id);
alter table public.tasks add column if not exists lti_resource_link_id   text;
alter table public.tasks add column if not exists lti_line_item_url      text;
alter table public.tasks add column if not exists lti_ags_lineitems_url  text;

create index if not exists tasks_lti_resource_link_idx
  on public.tasks (lti_platform_id, lti_resource_link_id);

-- =========================================================================
-- 6. Enable RLS (defence-in-depth; the API uses service-role and bypasses)
-- =========================================================================

alter table public.lti_platforms        enable row level security;
alter table public.lti_nonces           enable row level security;
alter table public.lti_user_mappings    enable row level security;
alter table public.lti_course_mappings  enable row level security;

drop policy if exists "user reads own lti mapping" on public.lti_user_mappings;
create policy "user reads own lti mapping"
  on public.lti_user_mappings for select
  using (auth.uid() = user_id);

-- =========================================================================
-- 6b. RPC: look up auth.users by email (no auth schema exposure needed)
-- =========================================================================

create or replace function public.lti_find_user_by_email(p_email text)
returns table(id uuid, raw_user_meta_data jsonb)
language sql
security definer
set search_path = auth, public
as $$
  select id, raw_user_meta_data
    from auth.users
   where email ilike p_email
   limit 1;
$$;

grant execute on function public.lti_find_user_by_email(text) to service_role;

-- =========================================================================
-- 7. Seed: Penrith Christian School (PCS) — Canvas Cloud
-- =========================================================================

insert into public.lti_platforms (
  school_name, issuer, client_id, deployment_id, hostname,
  jwks_url, auth_login_url, auth_token_url
) values (
  'Penrith Christian School',
  'https://canvas.instructure.com',
  '277420000000000006',
  '238:4918899f387deeb8c2a566f759e392996b5535f4',
  'learningpcs.instructure.com',
  'https://sso.canvaslms.com/api/lti/security/jwks',
  'https://sso.canvaslms.com/api/lti/authorize_redirect',
  'https://sso.canvaslms.com/login/oauth2/token'
) on conflict (issuer, client_id, deployment_id) do update
  set school_name = excluded.school_name;
