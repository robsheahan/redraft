-- LTI account-link requests (audit Q2B follow-up — the opt-in link flow).
--
-- After Q2B, an LTI launch whose email already belongs to a different account
-- (self-signup / another platform) is NOT auto-linked — we won't trust a
-- platform-asserted email as proof of identity. Instead the launch records a
-- short-lived link request and redirects the user to a page where, once signed
-- into the existing account, they can consent to linking their Canvas identity.
--
-- A row authorises creating ONE lti_user_mappings entry, and only when the
-- signed-in user's email matches the launch email. Single-use + 30-min expiry.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.lti_link_requests (
  token           text primary key,
  platform_id     uuid not null references public.lti_platforms(id) on delete cascade,
  canvas_user_id  text not null,
  email           text not null,
  display_name    text,
  role            text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 minutes'),
  consumed_at     timestamptz
);

create index if not exists lti_link_requests_expires_idx
  on public.lti_link_requests (expires_at);

-- RLS: written/read by the API via the service-role client only (the page calls
-- authed API routes, not the table directly). Deny-all; service role bypasses.
alter table public.lti_link_requests enable row level security;
