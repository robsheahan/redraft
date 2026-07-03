-- Skill observation source (quality fix 1.1).
--
-- Records which model produced each skill read: 'sonnet' (full AI feedback on
-- assessment tasks) or 'haiku' (the silent pass on quick/exam tasks — the bulk
-- of submissions, but a briefer, less-nuanced read). The rollup already
-- discounts Haiku reads; storing the source here makes the history auditable and
-- lets future work (confidence-as-agreement) weight by source too.
--
-- Nullable + no backfill: existing rows predate the distinction. The write path
-- is best-effort — if this column is missing, the observation insert is skipped
-- (history only) and the rollup is unaffected — so applying this is safe at any
-- time and unblocks the source being persisted going forward.

alter table skill_observations add column if not exists source text;
