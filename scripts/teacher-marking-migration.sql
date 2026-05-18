-- Teacher marking — adds grading columns to submissions and a partial index
-- for the "is this submission graded?" check.
-- Idempotent. Run in Supabase SQL Editor.

alter table public.submissions
  add column if not exists criterion_marks      jsonb,
  add column if not exists total_mark           numeric,
  add column if not exists teacher_comment      text,
  add column if not exists teacher_annotations  jsonb,
  add column if not exists graded_at            timestamptz,
  add column if not exists graded_by            uuid references auth.users(id);

create index if not exists submissions_graded_idx
  on public.submissions (task_id, student_id)
  where graded_at is not null;
