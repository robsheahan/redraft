-- Task modes — adds the lightweight task flow alongside the existing
-- student-facing feedback flow. Three modes, derived server-side from the
-- (student_feedback_enabled, criteria_present) inputs on task creation:
--
--   feedback_task  — current behaviour. 3-pass AI feedback shown to student.
--                    Criteria required. Up to 3 drafts per student.
--   marked_task    — silent AI pass (Haiku, insights signals only).
--                    Criteria required. Single submission. Goes into mark
--                    distribution. Student sees no feedback.
--   quick_task     — silent AI pass. No criteria. Single submission. Does NOT
--                    go into mark distribution. Feeds LLM cohort cards only.
--                    Teacher can mark with a number OR "mark as complete".
--
-- All existing tasks default to feedback_task so behaviour is unchanged.
-- Safe to re-run.

alter table public.tasks
  add column if not exists task_mode text not null default 'feedback_task';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_task_mode_check'
  ) then
    alter table public.tasks
      add constraint tasks_task_mode_check
      check (task_mode in ('feedback_task', 'marked_task', 'quick_task'));
  end if;
end $$;

create index if not exists tasks_task_mode_idx on public.tasks (task_mode);

-- Whether a quick_task is marked by a number (false, default) or simply ticked
-- "complete" (true). Only consulted by the marking UI when task_mode = quick_task;
-- safe to leave as-is on other modes.
alter table public.tasks
  add column if not exists completion_only boolean not null default false;

-- completion_status is only used for quick_task submissions that the teacher
-- "marks as complete" without giving a numeric mark. NULL for every other
-- case (including normally-marked quick_task submissions, which use total_mark).
alter table public.submissions
  add column if not exists completion_status text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'submissions_completion_status_check'
  ) then
    alter table public.submissions
      add constraint submissions_completion_status_check
      check (completion_status is null or completion_status = 'completed');
  end if;
end $$;
