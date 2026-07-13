-- api_call_log hygiene: index the global rate-limit check + stop unbounded growth.
--
-- The limiter's global daily gate filters on (endpoint, created_at) but the
-- table only had (user_id, created_at) and (created_at) indexes, so every
-- LLM-backed request index-scanned ALL endpoints' recent rows. And nothing
-- ever deleted old rows — the table (and its indexes) grew forever, slowing
-- the three pre-flight counts that run before every feedback request.
--
-- Run in the Supabase SQL editor.

create index if not exists api_call_log_endpoint_created_idx
  on public.api_call_log (endpoint, created_at desc);

-- Prune: the rate limiter reads at most 24 hours back. The admin dashboard
-- (api/admin-stats.ts) also reads this table for its insights-usage panel —
-- its "last 7 days" numbers need 7 days of rows, and its "all-time" totals
-- become a rolling 30-day window once this runs (acceptable for an internal
-- ops panel; revisit if a true all-time counter is ever needed).
-- pg_cron ships with Supabase.
create extension if not exists pg_cron;

select cron.schedule(
  'prune-api-call-log',
  '17 * * * *', -- hourly, on the :17 to avoid the top-of-hour rush
  $$delete from public.api_call_log where created_at < now() - interval '30 days'$$
);

-- To verify: select * from cron.job;
-- To undo:   select cron.unschedule('prune-api-call-log');
