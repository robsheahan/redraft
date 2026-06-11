-- LTI hardening hotfix (2026-06-11 audit).
-- Run once in Supabase SQL Editor. Safe to re-run.

-- 1. lti_find_user_by_email is SECURITY DEFINER and was created without
--    revoking the default PUBLIC execute grant, so anyone holding the public
--    anon key could call it via PostgREST (/rest/v1/rpc/...) to look up any
--    user's id + raw_user_meta_data by email. Service-role keeps access;
--    everyone else loses it.
revoke execute on function public.lti_find_user_by_email(text) from public, anon, authenticated;

-- 2. lti_dl_sessions was the only LTI table without row level security
--    (its four siblings enable it in lti-migration.sql §6). No policies are
--    added: deny-all, service-role bypasses.
alter table public.lti_dl_sessions enable row level security;
