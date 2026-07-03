# ProofReady Quality Fix Plan — 2026-07

Remediation plan for the issues found in the 2026-07-03 four-agent quality review (skill tagging, differentiation, insights) plus the regression sweep. Companion to `docs/codebase-audit-2026-07-03.md`.

**Status legend:** ⬜ not started · 🔧 in progress · ✅ done
**Effort:** S (<½ day) · M (½–1 day) · L (multi-day)
**Deploy:** whether it needs a DB migration and/or a prod deploy.

---

## Guiding principle: fix the foundation first

The skill database is read by **everything** — differentiation, insights cards, the longitudinal profile, graduated feedback prompts. So the calibration of the *tag* (how work is scored against the taxonomy) is upstream of almost every other quality issue. The plan is therefore sequenced:

1. **Phase 0 — Quick wins**: independent, high-value, low-risk, no design needed.
2. **Phase 1 — Skill calibration**: make the store trustworthy (the foundation).
3. **Phase 2 — Differentiation correctness**: fix the maths path + add the confidence floor.
4. **Phase 3 — Insights hardening**: de-risk the surfaces a skeptical leader attacks.
5. **Phase 4 — Taxonomy refinement**: reduce measurement noise at the source.

Only one issue is an active regression (already fixed: `e20a9ed`). Everything below is pre-existing quality/calibration — nothing is breaking the current pilot, so this can be done deliberately, in priority order, with real verification (the `verify` skill / calibration harness) on each change.

---

## Phase 0 — Quick wins (do first)  ✅ BUILT 2026-07-03

All six done (commits `5bb81d1` skill-rollup trio, `508582e` discipline key, `28ca9d2` fan-out, `ebef63f` mark card). Typecheck clean, math changes unit-verified, frontend render-checked. **NOT yet deployed** — 0.1 (mark card) is held pending Rob's sign-off on the presentation; the rest are ready to ship together.

Small, safe, independently shippable. High trust-per-hour.

### 0.1 — Reframe the "Common Grade Scale" mark-distribution card ⬜
**Problem:** The card labels raw per-task mark percentages as A–E "Common Grade Scale" bands with invented cutoffs (90/75/50/20). NESA's Common Grade Scale is a holistic, standards-referenced *course* grade with no fixed percentages — so this is methodologically indefensible *and* contradicts the app's own load-bearing no-mark/no-band rule. Biggest user-facing trust liability; a NESA-literate HOD objects on sight.
**Fix:** Drop the NESA band labels. Present it as a neutral **"Task-score distribution"** with plain buckets (e.g. 0–49 / 50–74 / 75–89 / 90–100 or quartiles) and an explicit "not a grade or band" note. Keep the dedupe-to-latest-graded-draft logic. Consider hiding it entirely when tasks in scope have wildly different `total_marks` (incomparable pooling).
**Files:** `api/insights-cards.ts` (`bandFor`, `NESA_BANDS`, `computeMarkDistribution`, `computeMarkByFaculty`), `public/insights.html` (renderers + card titles). Also mirror in `api/insights-student.ts` + `insights-detail.ts` band drill-downs.
**Effort:** S · **Deploy:** frontend + API, no migration.

### 0.2 — Fix the discipline-key mismatch (skill data silently orphaned) ⬜
**Problem (confirmed by 2 reviewers):** skill *writes* fall back to `'General'` (writing) / `'Mathematics'` (maths); skill *reads* fall back to `'Other'` (insights cards) / `'General'` (differentiator). For any task whose `course` doesn't resolve via `getDisciplineForCourse`, written skill data lands under one key but is queried under another → silently excluded from the skill matrix/growth/trajectory AND maths differentiation silently disables. Latent for the pilot (all current courses resolve) but a real correctness hole.
**Fix:** Make read + write fallbacks identical. Cleanest: a single shared helper `disciplineForCourse(course, family)` used by every write and read site, with one canonical fallback per family. Add a one-off log for skill rows whose `discipline` isn't an expected taxonomy faculty.
**Files:** `api/generate-feedback.ts`, `generate-maths-feedback.ts`, `submit-for-marking.ts` (writes); `api/insights-cards.ts`, `insights-card-generate.ts`, `insights-student.ts`, `generate-activity.ts` (reads); new helper in `data/nesa-courses.ts` or `lib/`.
**Effort:** S–M · **Deploy:** API, no migration. (Optional backfill to re-key any already-orphaned rows.)

### 0.3 — Fix `aggregateSkillAssessments` confidence (upward leak) ⬜
**Problem:** For multi-part maths / multi-question essays it pairs the **averaged** level across parts with the **max** confidence across parts. A skill weakly shown on two parts and strongly on one yields a diluted level carrying the strongest part's confidence → that confidence drives `effAlpha` in the rollup, folding a watered-down level in at full weight. Upward calibration leak on every multi-part submission.
**Fix:** Pair the averaged level with an **evidence-weighted mean** confidence (or weight each part's level by its own confidence before averaging).
**Files:** `lib/multi-question-feedback.ts` (`aggregateSkillAssessments`).
**Effort:** S · **Deploy:** API, no migration. Verify with a unit test.

### 0.4 — Seed/weight the first skill observation ⬜
**Problem:** A brand-new dimension is initialised as `newLevel = obs` with no evidence-weight and no ±1 clamp (the anti-gaming clamp only applies once a prior exists). One thin/low-confidence `extending` read sets the stored level to `5.0` outright, then takes several damped submissions to correct.
**Fix:** Seed the first observation toward a neutral prior (e.g. blend `obs` with `consolidating` by evidence weight), so a single thin read can't peg the extremes.
**Files:** `lib/skill-profile.ts` (the `else { newLevel = obs }` branch).
**Effort:** S · **Deploy:** API, no migration. Unit-test the rollup.

### 0.5 — Close the `things_done_well` fan-out desync hole ⬜
**Problem:** `common_gaps` generates gaps+strengths in one consistent call and fans strengths into `things_done_well` (so they can't contradict). But `things_done_well` still has its own standalone generation path that, if invoked, overwrites the fanned-out strengths without the gaps context — silently desyncing the pair.
**Fix:** Remove the standalone `things_done_well` generation path (or alias it to run `common_gaps` and re-fan).
**Files:** `api/insights-card-generate.ts` (`KIND_CONFIG.things_done_well`, handler).
**Effort:** S · **Deploy:** API, no migration.

### 0.6 — Recompute `trend` from the history slope ⬜
**Problem:** `trend` compares the raw new observation against the pre-update smoothed level — it's the sign of the latest *residual*, not a trajectory, and oscillates submission-to-submission. It's surfaced to the graduated-prompt model and (indirectly) to teachers as "improving/regressing."
**Fix:** Compute `trend` from the slope of the recent `skill_observations` history (which now exists) instead of the latest residual.
**Files:** `lib/skill-profile.ts` (trend calc); reads `skill_observations`.
**Effort:** S–M · **Deploy:** API, no migration.

---

## Phase 1 — Skill calibration (the foundation)

Make the tag trustworthy. Everything downstream improves once these land. Sequence within the phase matters: 1.1 and 1.2 are the highest leverage.

### 1.1 — Discount the Haiku silent pass in the rollup ⬜  ★ highest leverage
**Problem:** Quick/exam tasks (explicitly "the bulk of submissions") are scored by the cheap Haiku pass and written into `student_skill_profile` at **identical weight** to nuanced Sonnet reads. The store is dominated by the cheapest, least-guided reads treated as equal evidence.
**Fix:** Thread a `source` ('sonnet' | 'haiku') into `recordSkillSignals`/`recordSkillObservations` and multiply `evidenceWeight` by a source factor (e.g. Haiku → 0.5). Optionally cap what a Haiku-only history can reach (e.g. can't exceed `consolidating` without one Sonnet corroboration). Store the source on `skill_observations` for auditability.
**Files:** `lib/skill-profile.ts` (evidence weight + record signature), `api/submit-for-marking.ts` (pass source='haiku'), `generate-*.ts` (source='sonnet'). Optional migration: `skill_observations.source` column.
**Effort:** M · **Deploy:** API; optional migration for the `source` column.

### 1.2 — Give the skill read real prompt guidance ⬜
**Problem:** The skill-rating instruction lives *only* in the tool-schema array-description — the weakest form of instruction-following — and the **writing branch of the Haiku silent pass never mentions the skill dimensions at all**. The Sonnet holistic prompts are 250+ lines about student-facing feedback with the skill read tacked on as a tool field.
**Fix:** Add a short explicit skill-rating block to `prompts/feedback-system.ts`, `prompts/maths-system.ts`, and **especially** the writing branch of `prompts/insights-signals-system.ts`: restate "rate only what the task exercised," "thin evidence → lower level + low confidence," the anti-gaming rule, and one worked `secure` vs `consolidating` example. Add M6 (interpretation/application) to the maths silent-pass dimension list.
**Files:** `prompts/feedback-system.ts`, `prompts/maths-system.ts`, `prompts/insights-signals-system.ts`.
**Effort:** M · **Deploy:** API, no migration. Verify with `npm run calibrate-feedback` + spot checks.

### 1.3 — Make confidence mean certainty, not volume ⬜
**Problem:** `confidence = min(1, count / CONFIDENCE_FULL_AT)` — pure function of observation *count*. Pins to 100% after 5 observations regardless of how contradictory the reads were, and that confidence then drives graduated-prompt support-*stripping*. A student who reached "secure" via 5 over-generous reads is treated as certainly-secure and has support removed.
**Fix:** Blend count with **agreement** — track the variance of recent observations (the `skill_observations` log has per-obs levels) and reduce confidence when reads disagree. Cap the volume component below 1.0 so it can't peg on count alone.
**Files:** `lib/skill-profile.ts` (confidence calc); reads `skill_observations`.
**Effort:** M · **Deploy:** API, no migration.

### 1.4 — Reconcile the skill store with teacher marks ⬜
**Problem:** The teacher's awarded grade — the only ground-truth signal in the system — never touches the skill store. `submission-grade.ts` writes no skill signal. The store is a closed loop of model self-assessment that can drift arbitrarily from the mark the teacher gave the same work.
**Fix:** On grade write, fold a coarse reconciling signal into the profile: when the awarded mark is well below (or above) the model's implied level for that submission, nudge the relevant dimensions' level/confidence toward the mark. Keep it coarse (marks aren't per-dimension) — a gentle anchor, not a rewrite.
**Files:** `api/submission-grade.ts`, `lib/skill-profile.ts` (a `reconcileWithMark` helper).
**Effort:** M–L (needs a design decision on how a scalar mark maps to per-dimension nudges) · **Deploy:** API, no migration.

---

## Phase 2 — Differentiation correctness

Fixes the maths re-skin path (latent — no maths skill data in the pilot yet, but broken before it's used) and turns "confidence-aware" from prompt aspiration into behaviour.

### 2.1 — Thread the re-skinned question through `submit-for-marking` ⬜
**Problem (BUG 1 + BUG 2):** Lesson-Differentiator tasks are always quick tasks, which submit via `submit-for-marking` — NOT `generate-maths-feedback`. The re-skin-aware handling ("evaluate against the version they actually answered") lives only in the unreachable path. So `submit-for-marking` (a) stores `submission.question = task.question` (the original) and (b) feeds the *original* question + the student's *re-skinned* working to the Haiku skill read. Result: the teacher marks against a question the student didn't answer, and the skill read judges working against the wrong numbers → systematic under-read → a self-reinforcing "push it easier" corruption loop.
**Fix:** In `submit-for-marking`, for a `lesson_builder` maths task, look up the locked `task_activities.activity.question` for the student and use it as both the stored `submission.question` and the `generateInsightsSignals` question. Render `activity.question` in the teacher's maths marking "support given" block.
**Files:** `api/submit-for-marking.ts`, `public/mark-submission-maths.html`.
**Effort:** M · **Deploy:** API + frontend, no migration.

### 2.2 — Add a server-side confidence floor to differentiation ⬜
**Problem:** `generate-activity.ts` differentiates (and **locks**) off `observation_count > 0` — a single observation. Combined with the unclamped first-observation (0.4), an outlier first read (a hard question, an OCR glitch) can peg a student's differentiation and lock it. "Confidence-aware" (rule 4) is a soft instruction to the model with nothing enforcing it.
**Fix:** Require `observation_count >= 2` (or a minimum rollup confidence) before differentiating/locking; below that, deliver the main activity (don't lock, so it re-evaluates later). Pairs naturally with 0.4 (first-obs seed) and 1.3 (confidence-as-agreement).
**Files:** `api/generate-activity.ts` (the `rows.filter(... observation_count > 0)` gate).
**Effort:** S · **Deploy:** API, no migration.

### 2.3 — Add a tone backstop + empty-activity guard ⬜
**Problem:** `student_focus` is rendered raw to the student; the writing path has no verifier and the maths verifier checks correctness only, not tone. A single deficit-framed sentence ("because your evidence is weak…") would reach the student with zero guardrail. Separately, an all-empty activity still renders a labelled "Your focus" box with nothing in it.
**Fix:** A lightweight check that rejects/rewrites a `student_focus` containing deficit markers (level/band words, "because you", "weak", "struggle") before display; and if all support fields are empty, store `is_differentiated:false` (deliver the main activity, no empty banner).
**Files:** `api/generate-activity.ts`, optionally `prompts/lesson-builder-system.ts` (fold a tone check into the maths verifier).
**Effort:** S–M · **Deploy:** API, no migration.

### 2.4 — Feed the maths verifier the intended method ⬜
**Problem:** The re-skin verifier sees only the two questions, not the intended method / `worked_solution`. A numbers-only re-skin that turns a factorisable quadratic into a non-factorising one can still pass "solvable" + "same method (solve a quadratic)" while silently breaking the intended pedagogy (factorising practice).
**Fix:** Pass the base question's `worked_solution` (when present) to the verifier so it judges *method preserved*, and tighten the `method_matches` guidance to reject factorable→non-factorable style drift.
**Files:** `api/generate-activity.ts`, `prompts/lesson-builder-system.ts` (verifier prompt).
**Effort:** S · **Deploy:** API, no migration.

### 2.5 — Aggregate the signal note + task-relevant dimension selection ⬜ (polish)
**Problem:** The differentiator replays only the single latest `signal` note per dimension (overwritten each observation), and may target the profile's globally-lowest dimension even when this specific question doesn't exercise it.
**Fix:** Summarise recent notes from `skill_observations`; nudge the prompt to prefer a dimension the current question actually exercises.
**Files:** `lib/skill-profile.ts` (read), `prompts/lesson-builder-system.ts`.
**Effort:** M · **Deploy:** API, no migration. Lower priority.

---

## Phase 3 — Insights hardening

De-risk the surfaces a skeptical HOD/principal would attack (beyond 0.1).

### 3.1 — De-risk the decile cards ⬜
**Problem:** Force "exactly 3 dominant patterns" + a `prevalence_note` (fabricated prevalence the model was never given, self-contradicting "no numeric claims" alongside "half of the cohort") from as few as 3–6 submissions; and they don't get the Haiku/Sonnet provenance tags `common_gaps` got.
**Fix:** Raise the graded floor so the slice is ≥6–8; let the tool return 1–3 patterns (`minItems:1`, not "exactly 3"); replace `prevalence_note` free-text with a bounded enum tied to the sample ("in most of the reviewed sample" / "in several"); add the same source-tagging `common_gaps` uses.
**Files:** `api/insights-card-generate.ts` (`buildImprovementsPrompt`, floor), `lib/feedback-tools.ts` (`BOTTOM_DECILE_TOOL`/`TOP_DECILE_TOOL`).
**Effort:** M · **Deploy:** API, no migration.

### 3.2 — Smooth/floor the growth + movement cards ⬜
**Problem:** They diff **raw single-submission observations** (not the EWMA), so with `MOVE_THRESHOLD = 0.25` almost any wobble reads as "improved," and a headline mover or a per-student "slipped" flag can rest on 2 data points. The per-student trajectory's `current_label` (latest raw obs) can also disagree with the anchored LLM card (smoothed rollup) on the same page.
**Fix:** Diff the smoothed values (EWMA endpoints) or require ≥3 observations per student before a delta counts; raise `MOVE_THRESHOLD` to ~0.5 for headline movers and the "slipped" flag. Reconcile the trajectory's current-level label with the rollup. Keep the honest UI provenance.
**Files:** `lib/skill-history.ts` (`computeSkillGrowth`, `computeStudentSkillJourney`, thresholds).
**Effort:** M · **Deploy:** API, no migration. Unit-test.

### 3.3 — Anchor the leadership synthesis ⬜
**Problem:** It's a rollup-of-rollups — two LLM hops (per-task `class_feedback` → school synthesis) with no deterministic anchor, in front of the most senior audience. And a single-task faculty gets a full "faculty pattern" treatment.
**Fix:** Feed it the deterministic cohort skill matrix (as the cohort cards now get via R3) so at least one claim rests on numbers; raise the faculty-inclusion floor above one task, or force an explicit per-faculty n and caveat.
**Files:** `api/insights-synthesis.ts`, `lib/feedback-tools.ts` (`SCHOOL_INSIGHTS_TOOL`).
**Effort:** M · **Deploy:** API, no migration.

### 3.4 — Surface confidence in the cohort skill block (anti over-anchoring) ⬜
**Problem:** `formatCohortSkillMatrix` (fed to `common_gaps`) hides confidence, while telling the model "do NOT surface a gap the distribution contradicts" — so a *thin* distribution can steamroll a real prose gap. The student block already includes confidence; the cohort one should too.
**Fix:** Add `avg_confidence` / thin-evidence counts per dimension to `formatCohortSkillMatrix`, and soften the "do not contradict" instruction when the distribution is thin.
**Files:** `lib/skill-prompt.ts`.
**Effort:** S · **Deploy:** API, no migration.

### 3.5 — Fingerprint feedback/skill content; smaller caveats ⬜
**Problem:** The cohort-card cache fingerprint hashes ids/marks/timestamps but **not feedback content or skill data** — a same-mark feedback or skill regeneration won't refresh a cohort card. Plus: `class_profile_summary` describes "the cohort" from whoever happens to have a cached profile (a non-random subsample) with no representativeness caveat; the profile privacy doc overstates the guarantee (forwards `teacher_comment` verbatim).
**Fix:** Fold a feedback/skill signature into `cohortFingerprint`. Add a representativeness caveat to the `class_profile_summary` prompt. Either tighten the profile privacy wording or scan/strip `teacher_comment`.
**Files:** `lib/insights-filters.ts`, `api/insights-card-generate.ts`, `lib/student-profile.ts`.
**Effort:** S–M · **Deploy:** API, no migration.

---

## Phase 4 — Taxonomy refinement (reduce noise at source)

### 4.1 — Operationalise confusable dimension boundaries ⬜
**Problem:** W4 "Use of evidence" vs W5 "Integration of evidence"; W6 vs W7 (overlap on "flow"); M3 "Reasoning" vs M6 "Interpretation" (both "why", both roll up to `reasoning`); M4 "Notation" vs M5 "Communication of working". Good prose guidance, but no operational boundary — an LLM (especially Haiku) smears evidence across the pair, adding noise to two rows.
**Fix:** Add one-line "rate X not Y when…" disambiguators to each confusable dimension's `guidance` string. No taxonomy-version bump needed (guidance text, not keys).
**Files:** `data/skill-taxonomy.ts`.
**Effort:** S · **Deploy:** API, no migration.

### 4.2 — Reconsider the maths `evidence` spine mapping ⬜
**Problem:** The spine promises a cross-subject "whole-student view," but writing `evidence` = W4/W5 (selecting/integrating evidence) while maths `evidence` = M2 **Procedural accuracy** — apples to oranges. A student's maths "Evidence & Support" score is really just arithmetic accuracy, so the cross-subject spine rollup is misleading.
**Fix:** Either remap M2 to a more defensible spine, add a maths dimension under `evidence`, or explicitly scope the spine rollup as within-family only (don't compare maths-evidence to writing-evidence). Decide deliberately — this touches the `TAXONOMY_VERSION` contract if keys/spine change.
**Files:** `data/skill-taxonomy.ts`, `lib/skill-matrix.ts` (spine rollup rendering).
**Effort:** M (design decision) · **Deploy:** possible taxonomy-version implications.

---

## Suggested sequencing

| Order | Items | Why |
|---|---|---|
| 1 | **0.1, 0.2, 0.3, 0.4, 0.5, 0.6** | Quick wins — trust + correctness, low risk, mostly independent. 0.1 (Common Grade Scale) is the biggest visible win; 0.2 (discipline mismatch) prevents silent data loss. |
| 2 | **1.1, 1.2** | The two highest-leverage calibration fixes — discount Haiku + guide the read. Improves every downstream reader. |
| 3 | **1.3, 1.4** | Confidence-as-agreement + teacher-mark reconciliation — the deeper calibration. |
| 4 | **2.1, 2.2, 2.3, 2.4** | Differentiation correctness — fix the maths path + real confidence floor. |
| 5 | **3.1–3.5** | Insights hardening. |
| 6 | **4.1, 4.2** | Taxonomy refinement. |

Each change gets: a focused implementation, a unit test where there's math (0.3, 0.4, 0.6, 3.2), a `calibrate-feedback` run where prompts change (1.2), and — critically — an eyeball on real data before trusting it (the whole store is model self-assessment; the numbers need a human sanity-check, which no automated test replaces).

## Verification note

None of the calibration changes can be fully validated by typecheck or unit tests — they change how a model rates work, which only shows up on real submissions. The right validation loop: make the change → run it on a handful of real, teacher-marked submissions → compare the tag against the teacher's judgment. Phase 1.4 (teacher-mark reconciliation) is partly *building* that loop into the product.
