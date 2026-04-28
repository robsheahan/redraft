-- Persist generated class feedback on the task row so it survives page
-- refreshes. The API saves the synthesised JSON here after each successful
-- /api/generate-class-feedback call; task-detail.html re-renders it on load.
-- Run once in Supabase SQL Editor.

alter table public.tasks
  add column if not exists class_feedback jsonb,
  add column if not exists class_feedback_count integer,
  add column if not exists class_feedback_generated_at timestamptz;
