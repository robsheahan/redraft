-- Student profile invalidation: mark-stale instead of delete.
--
-- Previously every grading / feedback / submission event DELETED the student
-- profile row, and the next read regenerated it from scratch. That had two
-- costs:
--   1. class_profile_summary reads only cached profiles and surfaces missing
--      students as "needs more data", so a freshly-marked cohort silently
--      dropped out of the class summary until each student was viewed
--      individually (each view = one Sonnet regeneration).
--   2. A profile invalidated purely by a re-grade (no new submission) was
--      regenerated on next read even though the longitudinal narrative barely
--      moves.
--
-- Now invalidation flips stale = true and keeps the last-known-good row. The
-- read path regenerates when there are new submissions since generation, or
-- when a stale row is older than a short window; otherwise it serves the
-- cached copy. class_profile_summary keeps using the (possibly stale) row.
--
-- Run once in Supabase SQL editor. Safe to re-run.

alter table public.student_profile_synthesis
  add column if not exists stale boolean not null default false;

comment on column public.student_profile_synthesis.stale is
  'Set true by grading/feedback/submission events. The read path decides whether a stale row is regenerated (new submissions, or older than the refresh window) or served as last-known-good.';
