-- Own-task identity + sorting fields
--
-- Student-created "own tasks" historically lived as submissions with task_id = NULL,
-- grouped in the UI by identical question text and capped only by a daily call limit.
-- These columns give an own task a STABLE identity so it supports the same 3-draft
-- iterative model as a teacher task, plus a student-only title and an optional class
-- tag used purely for sorting in "Your own tasks" (never shared with the teacher).
--
-- Drafts of one own task are looked up by (student_id, own_task_id); the daily
-- "distinct own tasks started" count scans recent draft-1 rows by student.
--
-- Safe to run multiple times.

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS own_task_id uuid,
  ADD COLUMN IF NOT EXISTS own_task_title text,
  ADD COLUMN IF NOT EXISTS own_task_class_id uuid REFERENCES classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS own_task_criteria_text text;

CREATE INDEX IF NOT EXISTS idx_submissions_own_task
  ON submissions (student_id, own_task_id)
  WHERE own_task_id IS NOT NULL;
