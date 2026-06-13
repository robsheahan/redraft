-- Task instructions: an optional student-facing instructions block for a task,
-- shown above the question(s) on the submission page (e.g. time allowed, which
-- sections to answer, materials permitted). Distinct from `question` (the prompt)
-- and `notes` (the teacher's private notes, never shown to students).
--
-- Safe to run multiple times.

alter table public.tasks
  add column if not exists instructions text;
