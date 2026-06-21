-- Multi-part maths questions (take-home feedback) — see docs/maths-overhaul-plan.md §#2.
--
-- A maths feedback_task may carry an ordered `parts` array (sub-questions
-- (a)(b)(c) of one question), each worked + diagnosed separately. The shared
-- stem stays in tasks.question. Each part may carry an optional, HIDDEN
-- marking_guideline + worked_solution (the per-part analogue of the
-- single-question fields) — stripped from student reads by studentPartsView in
-- lib/maths-parts.ts. Null/absent parts = single-question task (current path).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parts jsonb;

-- Per-part student working for a multi-part submission:
--   [{ part_id, working_lines: [{ math }], input_mode }]
-- Null = single-question submission (uses submissions.working_lines).
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS part_working jsonb;
