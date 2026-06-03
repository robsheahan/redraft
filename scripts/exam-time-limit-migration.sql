-- In-class exam: an optional time limit on a task.
--
-- The new-task page now splits "Assessment task" into "Take-home assessment"
-- (task_mode = feedback_task — criteria + live feedback, no time limit) and
-- "In-class exam" (task_mode = marked_task — no criteria, submit-for-marking
-- only, optional time limit). The time limit is store-and-display only — shown
-- to students on the task; not enforced (the teacher supervises in class).
--
-- marked_task is already permitted by the tasks.task_mode CHECK constraint, so
-- only the time-limit column is new. Safe to run multiple times.

alter table public.tasks
  add column if not exists time_limit_minutes integer;
