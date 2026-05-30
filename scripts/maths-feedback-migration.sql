-- Maths feedback v0 — typed-input only.
-- Adds the columns needed to branch the existing essay flow into a separate
-- maths flow on the same task/submission shape.
--
-- Idempotent (safe to re-run).

-- 1. tasks.subject_type — 'essay' (current behaviour) or 'maths' (new branch).
--    Defaults to 'essay' so all existing tasks keep working unchanged.
alter table public.tasks
  add column if not exists subject_type text not null default 'essay';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_subject_type_check'
  ) then
    alter table public.tasks
      add constraint tasks_subject_type_check
      check (subject_type in ('essay', 'maths'));
  end if;
end$$;

-- 2. tasks.marking_guideline — free-text per-step mark allocation that the
--    teacher pastes. Parallel to criteria_text for essays. Required when
--    subject_type='maths' and task_mode='feedback_task' (assessment) — that
--    constraint is enforced in the API, not the DB.
alter table public.tasks
  add column if not exists marking_guideline text;

-- 3. submissions.working_lines — student's structured working as a jsonb
--    array of { math: latex_string, reason: text }. Populated for maths
--    submissions; null for essay submissions (which use draft_text instead).
alter table public.submissions
  add column if not exists working_lines jsonb;

-- 4. submissions.input_mode — 'structured' | 'freeform' | 'talkthrough'.
--    v0 only ships 'structured'. Stored so future modes can be added
--    without another migration.
alter table public.submissions
  add column if not exists input_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'submissions_input_mode_check'
  ) then
    alter table public.submissions
      add constraint submissions_input_mode_check
      check (input_mode is null or input_mode in ('structured', 'freeform', 'talkthrough'));
  end if;
end$$;
