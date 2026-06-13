-- Multi-question in-class exams: a marked_task may carry an ordered list of
-- questions (text or multiple-choice) instead of a single scalar question.
--
-- Design (see docs/multi-question-exam-plan.md):
--   tasks.questions          jsonb array of { id, type, text, marks, attachments[],
--                            (mc: options[], correct_option_id) }. null = legacy
--                            single-question task (tasks.question holds the scalar).
--                            correct_option_id is the answer key — stripped from
--                            every student-facing payload by lib/exam-questions.ts.
--   submissions.answers      jsonb array parallel to questions, each
--                            { question_id, question_text, marks, (text +
--                            over_time_cutoff_index | selected_option_id +
--                            selected_option_text) }. null = legacy single-draft
--                            submission (submissions.draft_text holds the scalar).
--                            A serialized transcript is ALSO written to draft_text
--                            for every downstream reader (same pattern as maths
--                            working_lines), so insights/profile/CSV are unchanged.
--   submissions.question_marks jsonb array of { question_id, mark, source }, where
--                            source ∈ { 'teacher', 'auto' }. MC rows are written
--                            at submit time (answer-key comparison); text rows by
--                            the teacher at marking time. total_mark stays the sum.
--   draft_autosaves.answers  jsonb of in-progress per-question answers, keyed by
--                            question_id, mirroring the submit payload.
--
-- Safe to run multiple times.

alter table public.tasks
  add column if not exists questions jsonb;

alter table public.submissions
  add column if not exists answers jsonb,
  add column if not exists question_marks jsonb;

alter table public.draft_autosaves
  add column if not exists answers jsonb;
