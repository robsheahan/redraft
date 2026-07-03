-- Skill observation history (insights R2).
--
-- student_skill_profile is a SNAPSHOT — one recency-weighted level per
-- (student, discipline, dimension). The per-submission history it was folded
-- from lives only inside submissions.skill_assessment jsonb, which is awkward to
-- query for trends. This table is the thin, append-only event log: one row per
-- (submission, dimension) at the moment it was assessed, so we can chart growth
-- over time — per-student trajectories and cohort "most-improved this term".
--
-- Written alongside the rollup by lib/skill-profile.ts (recordSkillObservations),
-- and backfillable from existing submissions.skill_assessment via
-- scripts/backfill-skill-observations.ts. The write is best-effort and isolated:
-- if this table is missing or an insert fails, the rollup still succeeds — only
-- history is skipped (same graceful-degradation contract as the rest of the
-- skill-capture path).

create table if not exists skill_observations (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid references submissions(id) on delete cascade,
  task_id          uuid,
  student_id       uuid not null,
  discipline       text not null,
  family           text not null,           -- 'writing' | 'maths'
  dimension        text not null,           -- W1..W7 / M1..M6
  level            numeric not null,         -- the OBSERVED level for this submission (1..5), not the rollup
  level_label      text,
  confidence       text,                     -- low | medium | high (model's per-observation confidence)
  evidence_weight  numeric,                  -- weight this observation carried into the EWMA
  observed_at      timestamptz not null default now(),
  taxonomy_version int not null default 1,
  created_at       timestamptz not null default now()
);

-- One observation per (submission, dimension) — makes the live write and the
-- backfill idempotent (re-runs and retries no-op via ON CONFLICT DO NOTHING).
-- NOTE: a FULL (non-partial) unique index, deliberately. A partial index
-- (`where submission_id is not null`) cannot serve as an ON CONFLICT arbiter
-- unless the statement repeats the predicate, which the Supabase client does not
-- emit — it fails with "no unique or exclusion constraint matching the ON
-- CONFLICT specification". submission_id is always set on inserted rows (the
-- observation write and the backfill both require it), and NULLs are distinct in
-- a unique index anyway, so a full index is both correct and ON-CONFLICT-usable.
create unique index if not exists skill_observations_submission_dim
  on skill_observations (submission_id, dimension);

-- Read paths: per-student trajectory, and cohort growth by discipline.
create index if not exists skill_observations_student_dim_time
  on skill_observations (student_id, dimension, observed_at);
create index if not exists skill_observations_disc_dim_time
  on skill_observations (discipline, dimension, observed_at);

-- Service-role only (same as student_skill_profile): no RLS policies, the API
-- authorises every read/write. If RLS is enabled project-wide, add a
-- deny-by-default and let the service key bypass it.
