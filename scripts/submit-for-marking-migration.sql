-- Submit-for-marking — gives students a way to submit a final version
-- without burning AI feedback budget. Once submitted, the task is locked
-- for that student (same lock as graded_at).

alter table public.submissions
  add column if not exists submitted_for_marking boolean not null default false;

create index if not exists submissions_submitted_for_marking_idx
  on public.submissions (task_id, student_id)
  where submitted_for_marking = true;
