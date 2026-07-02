-- Atomic skill-rollup fold (audit P1-10).
--
-- lib/skill-profile.ts currently does a read-modify-write of student_skill_profile
-- in JS: read the current row, compute the EWMA in Node, upsert. Two concurrent
-- submissions for the same student (e.g. an essay draft and a maths submit landing
-- together, or a retried request) both read the same "before" state and the last
-- upsert wins — one observation's contribution to level / observation_count /
-- confidence is lost permanently. Low per-student concurrency, but this table is
-- the product's compounding spine, so the error never washes out.
--
-- This function performs the fold inside a single statement so the read and write
-- can't interleave. It takes the SAME evidence-weighted-EWMA + ±1 clamp the JS
-- uses, so the numbers are identical — only the atomicity changes.
--
-- STATUS: ready to apply. Until it is applied AND lib/skill-profile.ts is switched
-- to call it (recordSkillSignals → supabase.rpc('apply_skill_signal', …) per
-- dimension), the JS path remains in effect. Apply first, then switch, so skill
-- capture never breaks against a missing function.

create or replace function apply_skill_signal(
  p_student_id   uuid,
  p_discipline   text,
  p_dimension    text,
  p_obs_level    numeric,   -- LEVEL_VALUE[level], 1..5
  p_eff_alpha    numeric,   -- ALPHA * evidenceWeight(confidence, note), already computed by the caller
  p_max_delta    numeric,   -- MAX_LEVEL_DELTA (1)
  p_confidence_full_at int, -- CONFIDENCE_FULL_AT (5)
  p_level_label  text,      -- nearestLabel(newLevel) computed by caller after the fold? see note
  p_signal       text,
  p_taxonomy_version text
) returns void
language plpgsql
as $$
declare
  v_before_level numeric;
  v_before_count int;
  v_new_level    numeric;
  v_count        int;
  v_trend        text;
begin
  select level, observation_count into v_before_level, v_before_count
    from student_skill_profile
   where student_id = p_student_id and discipline = p_discipline and dimension = p_dimension
   for update;

  if v_before_level is null then
    v_new_level := p_obs_level;
    v_count := 1;
    v_trend := 'new';
  else
    v_new_level := p_eff_alpha * p_obs_level + (1 - p_eff_alpha) * v_before_level;
    -- ±1 clamp around the prior stored level
    v_new_level := greatest(v_before_level - p_max_delta, least(v_before_level + p_max_delta, v_new_level));
    v_count := v_before_count + 1;
    if p_obs_level > v_before_level + 0.25 then v_trend := 'improving';
    elsif p_obs_level < v_before_level - 0.25 then v_trend := 'regressing';
    else v_trend := 'stable';
    end if;
  end if;

  insert into student_skill_profile
    (student_id, discipline, dimension, level, level_label, confidence, trend, signal, observation_count, taxonomy_version, updated_at)
  values
    (p_student_id, p_discipline, p_dimension,
     round(v_new_level, 2), p_level_label,
     least(1.0, v_count::numeric / p_confidence_full_at),
     v_trend, p_signal, v_count, p_taxonomy_version, now())
  on conflict (student_id, discipline, dimension) do update set
     level = excluded.level,
     level_label = excluded.level_label,
     confidence = excluded.confidence,
     trend = excluded.trend,
     signal = excluded.signal,
     observation_count = excluded.observation_count,
     taxonomy_version = excluded.taxonomy_version,
     updated_at = excluded.updated_at;
end;
$$;

-- Note on level_label: nearestLabel depends on the POST-fold level, which is only
-- known inside this function. Prefer moving the label derivation into SQL (a small
-- CASE on round(v_new_level)) so the caller doesn't need it; the parameter above is
-- a placeholder for the minimal-change port. Decide when wiring recordSkillSignals.
