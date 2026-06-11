-- Cleanup: drop the now-unused lti_find_user_by_email RPC (audit L1/Q2B).
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Context: LTI provisioning used to fall back to looking a launch's email up in
-- auth.users and attaching to any matching account. That cross-tenant linking
-- is removed (identity is now keyed strictly on (platform_id, canvas_user_id)),
-- so this SECURITY DEFINER function has no callers. It was already locked down
-- by the LTI-9 hotfix (execute revoked from anon/authenticated); dropping it
-- removes the latent surface entirely.
--
-- Not urgent (it's already unreachable by clients), but tidy.

drop function if exists public.lti_find_user_by_email(text);
