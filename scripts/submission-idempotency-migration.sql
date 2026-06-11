-- P8 — idempotency on submission inserts.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- draft_version was read-then-inserted with no unique constraint, so a rapid
-- double-submit (double-click on "Get feedback" / "Submit for marking") could
-- create two rows at the same draft_version — and burn a second round of Sonnet
-- calls. These partial unique indexes make the DB reject the duplicate row; the
-- handlers now treat the 23505 unique-violation as a benign duplicate (the
-- student still gets their feedback; no second row, no 500).

-- Teacher-task drafts: one row per (student, task, draft_version).
create unique index if not exists submissions_task_draft_uniq
  on public.submissions (student_id, task_id, draft_version)
  where task_id is not null;

-- Own-task drafts: one row per (student, own_task, draft_version).
create unique index if not exists submissions_own_task_draft_uniq
  on public.submissions (student_id, own_task_id, draft_version)
  where own_task_id is not null;

-- ---------------------------------------------------------------------------
-- If either CREATE fails with "could not create unique index … duplicate key",
-- pre-existing duplicates exist. Find them:
--   select student_id, task_id, draft_version, count(*)
--     from public.submissions where task_id is not null
--     group by 1,2,3 having count(*) > 1;
-- then delete the surplus, keeping the earliest row per group:
--   delete from public.submissions s using (
--     select id, row_number() over (
--       partition by student_id, task_id, draft_version order by created_at, id
--     ) as rn
--     from public.submissions where task_id is not null
--   ) d
--   where s.id = d.id and d.rn > 1;
-- (repeat for own_task_id), then re-run the CREATE statements.
-- ---------------------------------------------------------------------------
