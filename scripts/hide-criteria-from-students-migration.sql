-- Hide-criteria-from-students toggle.
-- Per-task flag so a teacher can run exam-style assessments where the rubric
-- shouldn't be visible to students during writing or in AI feedback. The
-- criteria + per-criterion mark breakdown reveal once the teacher has graded
-- the student's submission (see feedback.html / api/me.ts gating).
--
-- Defaults FALSE so existing behaviour is unchanged.

alter table public.tasks
  add column if not exists hide_criteria_from_students boolean not null default false;
