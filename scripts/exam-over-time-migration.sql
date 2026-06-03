-- In-class exam: mark work submitted after the time limit.
--
-- For a timed in-class exam (task_mode = marked_task with time_limit_minutes),
-- the student's timer starts on first keystroke. The boundary between work done
-- within the limit and after it is captured client-side and stored here as a
-- single index into the final submission:
--   - essay submissions: a CHARACTER index into draft_text
--   - maths submissions: a LINE index into working_lines
-- The marking screen is subject-specific, so the interpretation is unambiguous.
-- null = no limit / the deadline was never reached (nothing to mark).
--
-- Safe to run multiple times.

alter table public.submissions
  add column if not exists over_time_cutoff_index integer;
