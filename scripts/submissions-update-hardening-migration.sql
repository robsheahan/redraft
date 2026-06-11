-- M4 — submissions UPDATE hardening (grade integrity).
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- THE HOLE: the "students update own submissions" RLS policy
--   (rls-policies.sql) was `using/with check (auth.uid() = student_id)` with NO
--   column restriction. Any holder of the public anon key, authenticated as a
--   student, could UPDATE *any* column of their own submission rows via
--   PostgREST — including teacher-owned grading fields: total_mark, graded_at,
--   graded_by, feedback, teacher_comment, criterion_marks, teacher_annotations,
--   skill_assessment. Forged marks would surface in the teacher markbook and in
--   school insights.
--
-- WHY REMOVING IT IS SAFE: no client flow updates submissions directly. Every
--   submission write (draft save with feedback, submit-for-marking, teacher
--   marking) goes through a service-role API route, which bypasses RLS. The
--   browser only ever READS submissions and autosaves drafts to the separate
--   draft_autosaves table. So students/teachers need no direct UPDATE grant.

-- 1. Drop the over-broad student UPDATE policy. With RLS enabled and no
--    permitting UPDATE policy, anon/authenticated cannot UPDATE any submission
--    row. service_role bypasses RLS, so the API is unaffected.
drop policy if exists "students update own submissions" on public.submissions;

-- 2. Defence in depth at the privilege layer: even if a permissive UPDATE
--    policy were re-added by mistake later, the client roles still lack the
--    UPDATE privilege. service_role keeps its own grant.
revoke update on public.submissions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verify (run these after; both should confirm the lockdown):
--   -- no UPDATE policy on submissions remains:
--   select policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename = 'submissions';
--   -- anon/authenticated have no UPDATE privilege on submissions:
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'submissions'
--       and privilege_type = 'UPDATE';
-- ---------------------------------------------------------------------------
