-- Scale-readiness indexes.
-- Run once in Supabase SQL Editor (Project → SQL Editor → New query).
-- Idempotent — safe to re-run.
--
-- These indexes target the queries that get hottest under pilot load:
-- 1. Student dashboard lists their own submissions ordered by created_at desc.
-- 2. Teacher views per-task submissions (already covered by submissions_task_idx
--    in the original migration, included here for completeness).

create index if not exists submissions_student_created_idx
  on public.submissions (student_id, created_at desc);

-- Class membership lookups by student happen on every student.html load
create index if not exists class_members_student_class_idx
  on public.class_members (student_id, class_id);

-- Tasks-per-class queries used in /api/class detail and student class view
create index if not exists tasks_class_published_idx
  on public.tasks (class_id, published_at);
