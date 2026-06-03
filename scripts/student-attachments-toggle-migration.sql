-- Per-task toggle: allow students to attach a file to their submission.
--
-- Defaults OFF — the student attach-file control only appears on the submit
-- page when the teacher has turned this on for the task. Teacher task materials
-- (tasks.teacher_attachments) are unaffected.
--
-- Safe to run multiple times.

alter table public.tasks
  add column if not exists allow_student_attachments boolean not null default false;
