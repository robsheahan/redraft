# ProofReady Codebase Audit — 2026-07-03

Four parallel deep audits (security, backend correctness, frontend, insights subsystem) over the full codebase at commit `9ca724f`, plus a close manual read of the insights generation pipeline. Every finding below was verified against the actual code by the auditing pass that produced it; file:line references are from that read.

## Fix status (branch `fix/audit-2026-07`)

**Fixed** (typecheck clean, 40 files): all six P0s (skill-data loss, quote-safe escaper across 17 pages, role self-promotion, faculty scope leak + cache-key collision, AGS draft-scoring, NRPS roster resilience) and the P1 set (fail-open lock/cap sweep, autosave lock griefing, stale part-id guard, exam re-grade merge, re-grade-blind fingerprint, quick_task consistency, mark-distribution dedupe, attachment path binding, stale-profile lifecycle). Plus P2: decile overlap + honest labelling, recency-biased card sampling, fan-out desync visibility, CSV formula injection, rate-limiter error visibility, task-detail loader guard, `source_task_count` by id, drifted copy.

**Deferred — needs a migration or DB action:**
- **P1-10 skill-rollup race** — atomic fold written as `scripts/skill-profile-atomic-migration.sql`; JS path left in place (switching to an unmigrated RPC would break all skill capture on deploy). Apply the migration, then wire `recordSkillSignals` to the RPC. The P0-1 dedupe already removed the catastrophic data-loss; this only closes a rare lost-observation race.
- The security-audit migrations previously noted as maybe-unrun still apply.

**Deferred — feature-sized, belongs in the insights roadmap (§3), not a bug sweep:**
- **Improvement velocity** still uses verbatim string matching (P2). The right fix is R4 (rebuild on skill deltas), not a patch.
- Full time-window unification across all cards (tasks/classes/synthesis still all-time; UTC year/week boundaries), student-card filter-awareness, decile-over-per-student-means, synthesis corpus cap, archived-class visibility policy — all noted, none done. Address alongside the insights layer rework.

Original findings below, unedited.

---

Contents:
1. [Priority findings](#1-priority-findings) (P0 → P2)
2. [Module map](#2-module-map) — how to segment the codebase for future work
3. [The insights layer](#3-the-insights-layer) — how it works today, and recommendations
4. [What's in good shape](#4-whats-in-good-shape)

---

## 1. Priority findings

### P0 — fix first (data integrity, security boundary, pilot-visible)

**P0-1. The skill database silently loses ALL multi-part maths data.**
`api/generate-maths-feedback.ts:347` merges per-part skill reads with a raw `flatMap`. When two parts assess the same dimension (near-certain — e.g. M2 on parts (a) and (b)), `recordSkillSignals`' upsert contains duplicate conflict keys and Postgres rejects the whole statement (error 21000). The throw is swallowed by `.catch(captureError)`, so **the entire skill rollup for that submission is dropped — every dimension, silently**. The essay multi-question path already has the fix (`aggregateSkillAssessments` in `lib/multi-question-feedback.ts`); the maths path never got it. Since the skill database is the strategic asset, this is the single most important fix in this audit.
*Fix: pass the merged array through `aggregateSkillAssessments` (already exported), and/or dedupe by dimension inside `recordSkillSignals` so no caller can ever trip it.*

**P0-2. Stored XSS from a student's maths working into the teacher's session.**
The shared `e()` escaper escapes `<` `>` `&` but **not quotes** — safe in text position, unsafe inside attributes. Student-controlled MathLive strings are interpolated into `data-tex="…"` on `mark-submission-maths.html:347`, `feedback-maths.html:322,446`, `submit-maths.html:778`. A value like `" onmouseover="…` escapes the attribute and executes when the **teacher** opens the marking page. Same class (lower controllability): class/faculty names into `title=`/`data-drill-*` on `insights.html:2455`, and unvalidated LLM `category` into class names (`feedback.html:1210`, `mark-submission.html:914`).
*Fix: make the one shared escape helper quote-safe (add `"` → `&quot;`, `'` → `&#39;`) on every page — closes the whole class at once.*

**P0-3. Any student can self-promote to teacher.**
`api/set-role.ts:14-24,61-64` writes `app_metadata.role` with no first-time-only lock and no transition guard, despite the comment claiming it's onboarding-only. An authenticated student calling `POST /api/set-role {"role":"teacher"}` becomes a teacher everywhere the server checks `authoritativeRole()` — can create classes, harvest classmates' submissions once they join, and inject content into leadership synthesis. Every "teacher-only" gate is currently not a real boundary.
*Fix: allow a role write only when `app_metadata.role` is unset; require an out-of-band signal (LTI Instructor role, admin grant, staff-domain verification) for teacher status thereafter.*

**P0-4. Faculty-restricted leaders' LLM cards are built from — and cache-collide with — whole-school data.**
`applyFacultyScope` (`lib/insights-filters.ts:93-109`) only pins the faculty filter when the leader has **exactly one** faculty. A leader restricted to `[English, Maths]` gets an unfiltered corpus: their `common_gaps`/decile cards include feedback text from KLAs the school withheld. Worse, `scopeKeyForFilters` encodes only the filters, not the caller's restriction — so the restricted leader and an unrestricted executive share the same `school_insights_cards` row, each potentially served the other's card.
*Fix: apply `restrictedFaculties` as a hard corpus filter in `insights-card-generate.ts` (as `insights-cards.ts:171` already does), and fold the sorted restriction list into the scope key in both generate and read paths.*

**P0-5. Every AI draft posts 100% "FullyGraded" to the Canvas gradebook.**
`lib/lti/ags.ts` defaults `scoreGiven ?? 1, scoreMaximum ?? 1, gradingProgress: 'FullyGraded'`, and the feedback endpoints call it with only a comment. On an LTI-linked assignment with real points, a student shows full marks in Canvas for submitting draft 1 — parent- and student-visible during the PCS pilot. Also: clearing a grade skips passback (stale LMS score), and `${lineItemUrl}/scores` breaks if the URL carries a query string (Moodle does — relevant to multi-state).
*Fix: drafts should post `activityProgress: 'Submitted'`, `gradingProgress: 'Pending'`, no score; insert `/scores` before the query string; pass back grade-cleared state.*

**P0-6. One problematic roster member kills the whole NRPS class sync.**
`lib/lti/nrps.ts` has no per-member try/catch. One student whose email belongs to a pre-existing self-signup account throws `LtiAccountLinkRequiredError` and aborts the loop — everyone after them is never provisioned, the teacher just sees a partially-populated class, and the only trace is Sentry. The likeliest LTI incident for the pilot. (`body.members` is also used unguarded.)
*Fix: try/catch per member, count and report skips, default `members` to `[]`.*

### P1 — correctness bugs to schedule next

**P1-1. Silent 1000-row truncation on every insights query.** No insights query paginates or sets `ORDER BY` (`insights-cards.ts:126`, `insights-card-generate.ts:416-445`, `insights-student.ts:118`, `schools.ts:333` class_members, etc.); PostgREST caps at 1000 rows, so at scale (300 students × 4 drafts) every card computes over an *arbitrary, nondeterministic* subset — wrong stats, fingerprint flapping (cache misses / false hits), and scope checks that can 404 legitimate students. *Fix: `.range()` pagination loops like `listAllAuthUsers`, or server-side aggregates.*

**P1-2. Fail-open pattern sweep (one shared fix).** Lock checks in all three feedback endpoints + `submit-for-marking` use `.maybeSingle()` without `.limit(1)`, so **two matching rows return null and the lock silently vanishes** (reachable: teacher grades two draft rows). Prior-drafts query errors are ignored, skipping the 3-draft cap and daily caps and burning full Sonnet spend on unpersistable inserts. The `started` count queries in `task.ts` ignore errors (lock bypass on transient failure). *Fix: `.limit(1).maybeSingle()`, treat query errors as fail-closed, everywhere.*

**P1-3. `draft-autosave` PUT validates nothing → task-lock griefing.** No task-existence, published, or class-membership check (`api/draft-autosave.ts:36-58`), and any autosave row flips `started=true`, permanently freezing the task's content for the teacher. Any authenticated user with a task UUID can lock a task the moment it's published. *Fix: require membership + published task + non-empty content.*

**P1-4. Multi-part maths: stale part ids consume a draft for empty feedback.** If submitted `part_id`s don't match authored parts (teacher edited pre-start, stale tab), every part takes the blank branch — zero LLM calls, empty feedback, yet the submission inserts and costs 1 of 3 drafts (`generate-maths-feedback.ts:292-339`). The essay path guards this; maths doesn't. *Fix: 400 unless ≥1 submitted part matches.*

**P1-5. Exam re-grade discards earlier teacher marks.** `mergeExamGrade` (`lib/exam-submission.ts:114-138`) rebuilds teacher rows solely from the current payload — a partial re-grade deletes marks for every other question and passes the lower total to the LMS. Same pattern task-wide: omitted `criterion_marks`/`teacher_comment`/annotations are overwritten with null. *Fix: treat omitted as unchanged; merge stored rows.*

**P1-6. Cache fingerprint blind to re-grades.** `graded_at` is set only on first grade, and `markSum` is the only regrade signal — moderation changes that sum to zero (12→10 and 8→10) leave decile cards "fresh" for 24h with wrong decile membership (`lib/insights-filters.ts:142-161`). *Fix: bump a `mark_updated_at` on every grade write, or hash `(id, total_mark, graded_at)` tuples.*

**P1-7. `quick_task` handled inconsistently across the three band computations.** School mark-distribution card excludes it; the student view (`insights-student.ts:100`) and the drill-down (`insights-detail.ts:101`) never select `task_mode` and include it — so the student page contradicts the school page and card totals ≠ drill-down rows. *Fix: select `task_mode`, skip quick_task in both.*

**P1-8. Mark distribution counts every graded draft; deciles dedupe to latest.** A student graded on v1 and v2 contributes two bands to the A–E chart while the LLM decile card sees one — two cards on the same page describe different populations, and heavy drafters are over-weighted (`insights-cards.ts:457-491`). *Fix: dedupe to latest graded draft per (student, task).*

**P1-9. Attachment paths never bound to their owner.** The download authoriser trusts the row's attachment list, but that list is written verbatim from the client — a student can list any bucket path in their own submission and get a signed URL for it (`api/attachment.ts:89-135`). Currently mitigated only by path-UUID secrecy. *Fix: enforce that the path's owner folder matches `submission.student_id` / `task.teacher_id` at download (or store) time.*

**P1-10. Skill rollup read-modify-write race.** Two concurrent submissions both read the same `before` state and the last upsert wins — observations permanently lost from level/count/confidence (`lib/skill-profile.ts:103-150`). Low concurrency but errors accumulate forever in the spine table. *Fix: fold the EWMA in a Postgres function (`on conflict do update set …`).*

**P1-11. Stale-profile lifecycle misses deletions.** Task/class deletes remove submissions without flipping `stale`, and regen only triggers on `currentCount > countAtGeneration` — a profile describing deleted work is served indefinitely (`lib/student-profile.ts:176-181`). *Fix: `!==` comparison; flip `stale` in delete paths.*

### P2 — quality and robustness

- **Decile cards mislabel at small n** — with 5 graded subs the "bottom 10%" is actually the bottom 60%, top and bottom cards can share a submission, and deciles are per-submission not per-student (one weak student with 5 tasks can *be* the bottom decile). Raise floors, compute over per-student means, make the prompt state the true fraction. (`insights-card-generate.ts:514-527`)
- **Inconsistent time windows on one dashboard** — submissions windowed, tasks/classes/synthesis all-time; faculty engagement can show 40 tasks / 0 submissions; year boundary and week buckets computed in UTC (~11h off NSW). (`insights-cards.ts`, `insights-synthesis.ts`)
- **Arbitrary LLM-card sampling** — `slice(0, 60)` in undefined DB order; cohorts >60 synthesise from an effectively random, often oldest, subset. Sort by recency and stratify. (`insights-card-generate.ts:530`)
- **`common_gaps` → `things_done_well` fan-out can desync** — none of the four cache upserts checks its error; the "can never contradict" contract breaks silently. Direct `kind=things_done_well` also still regenerates strengths without gaps context. (`insights-card-generate.ts:630-693`)
- **Improvement velocity is verbatim string matching** — regenerated LLM feedback rarely repeats titles, so `addressed_rate` inflates toward 100% and every rephrase lands in `top_regressions`. (See recommendation §3.4 — the skill data solves this properly.) (`insights-student.ts:264-279`)
- **CSV formula injection** — student draft text starting `=`/`+`/`-`/`@` executes in the teacher's spreadsheet. Prefix-guard those cells. (`api/task-csv.ts`)
- **`task-detail.html` loader has no try/catch** — spinner forever on network failure; sibling pages all handle this. (`task-detail.html:537`)
- **Rate limiter**: check-then-insert race; the insert error is never inspected (limiting silently disables itself if inserts start failing); tokens charged before cheap validations (capped students burn their 10/hr on guaranteed 400s).
- **Maths discipline fallback split** — `submit-for-marking.ts:223` falls back to `'General'`, `generate-maths-feedback.ts:473` to `'Mathematics'`; discipline-filtered readers see half the picture.
- **`submit-for-marking` shape gaps** — no `published_at` check; an essay draft can be submitted to a maths task (then scored on M1–M6 by the silent pass).
- **Second-order prompt-injection fencing gap** — cohort/synthesis prompts interpolate model-written feedback text without `wrapUntrusted`; upstream fencing holds, but the leadership layer re-feeds free text unlabelled. Defence-in-depth: fence it or restrict to structured arrays.
- **Typing telemetry is client-trusted** — the integrity numbers teachers see are fabricatable by a scripted client. Caveat in the UI as advisory; clamp/derive server-side where possible.
- Smaller items: cross-tab autosave last-write-wins; closed-tab exam expiry not flagged as over-time; `source_task_count` dedupes by title; student cards ignore active page filters; restricted leaders can regenerate whole-school synthesis (and its corpus is unbounded); multi-school members resolve to an arbitrary school; `student-profile` 429s instead of serving stale; archived classes inconsistently visible in insights only; drifted draft-count copy between `student.html`/`class-view.html`; `email_confirm: true` on signup (known, parked).

---

## 2. Module map

Twelve working modules. Each is a coherent unit you can point a session at ("let's work on Module 8") with its own files, contracts, and audit hot-spots.

| # | Module | Key files | Audit hot-spots |
|---|--------|-----------|-----------------|
| 1 | **Platform core** — request plumbing, AI client, guards | `lib/with-handler.ts`, `lib/auth.ts`, `lib/cors.ts`, `lib/rate-limit.ts`, `lib/sentry.ts`, `lib/anthropic-tool-call.ts`, `vercel.json` | rate-limiter race + dead error path; SDK timeout > Vercel 300s |
| 2 | **Identity & onboarding** | `api/signup.ts`, `api/set-role.ts`, `api/request-password-reset.ts`, `public/auth.html`, `choose-role.html`, `profile.html`, `reset.html` | P0-3 self-promotion; parked email verification |
| 3 | **Classes & enrolment** | `api/class.ts`, `public/new-class.html`, `class-detail.html`, `class-view.html`, join codes | class delete doesn't flip profile stale |
| 4 | **Task authoring & lifecycle** | `api/task.ts`, `api/generate-criteria.ts`, `lib/parse-rubric-with-ai.ts`, `lib/rubric-detect.ts`, `lib/feedback-questions.ts`, `api/attachment.ts`, `public/new-task.html`, `task-detail.html`, uniform lock | P1-3 lock griefing; update-path validation gaps; attachment path binding (P1-9) |
| 5 | **Student drafting & submission** | `public/submit.html`, `submit-maths.html`, `api/draft-autosave.ts`, `api/submit-for-marking.ts`, own tasks, exam timing/telemetry | fail-open lock checks (P1-2); telemetry trust; exam edge cases |
| 6 | **Essay feedback engine** | `api/generate-feedback.ts`, `api/generate-multi-feedback.ts`, `lib/multi-question-feedback.ts`, `lib/generate-inline-suggestions.ts`, `prompts/feedback-system.ts`, `prompts/multi-question-feedback-system.ts`, `data/nesa-*`, `data/subject-glossaries.ts`, `test/calibrate-feedback.ts` | draft-cap fail-open (P1-2) |
| 7 | **Maths feedback engine** | `api/generate-maths-feedback.ts`, `api/structure-maths-working.ts`, `api/transcribe-maths-*.ts`, `api/generate-marking-guideline.ts`, `lib/maths-verify.ts`, `lib/maths-parts.ts`, `prompts/maths-system.ts`, `data/stage-4-5-reference.ts` | P0-1 skill loss; P1-4 stale part ids; discipline fallback split |
| 8 | **Skill database** (the strategic asset) | `data/skill-taxonomy.ts`, `lib/skill-profile.ts`, `lib/insights-signals-feedback.ts`, `prompts/insights-signals-system.ts` | P0-1 (write side), P1-10 race; **no insights reader — see §3** |
| 9 | **Teacher marking & markbook** | `api/submission-grade.ts`, `api/task-submissions.ts`, `api/task-csv.ts`, `lib/exam-submission.ts`, `public/mark-submission*.html`, `teacher-markbook.html`, `my-results.html`, `feedback*.html`, `js/rubric.js` | P0-2 XSS; P1-5 re-grade data loss; CSV injection |
| 10 | **Insights & analytics** | `api/insights-*.ts`, `api/student-profile.ts`, `lib/student-profile.ts`, `lib/insights-filters.ts`, `lib/schools.ts`, `lib/feedback-tools.ts` (card tools), `public/insights.html` | P0-4 scope leak; P1-1 truncation; P1-6/7/8; most P2 items |
| 11 | **Lesson Differentiator** | `api/generate-activity.ts`, `prompts/lesson-builder-system.ts`, `task_activities` | re-skin risk (known); the only current skill-DB reader |
| 12 | **LTI / Canvas** | `api/lti/*`, `lib/lti/*`, `scripts/lti-migration.sql` | P0-5 AGS scores; P0-6 roster sync; launch maxDuration |

(Plus static marketing/policy pages — `deck.html`, `pitch/`, `compliance/privacy/terms` — not audited as code.)

**Suggested work order by module risk:** 7 & 8 (P0-1 + races — protect the data asset) → 9 & 2 (XSS + role) → 12 (before more pilot usage) → 10 (correctness pass, then the §3 roadmap) → 4 & 5 (fail-open sweep).

---

## 3. The insights layer

### 3.1 How it works today (verified data flow)

Three sources feed everything:
1. **Feedback jsonb on submissions** — prose arrays (`improvements`, `what_youve_done_well`, `top_priority`) written by Sonnet (feedback tasks) or Haiku (silent pass on marked/quick tasks — indistinguishable downstream).
2. **Marks** — `total_mark / tasks.total_marks`.
3. **The skill database** — `submissions.skill_assessment` (per-submission, per-dimension level 1–5 + note) rolled into `student_skill_profile` (EWMA level, confidence, trend per student × dimension).

The cards:
- **Deterministic SQL cards** (`insights-cards.ts`): KPIs, activity sparkline, faculty/class engagement, mark distribution (A≥90/B≥75/C≥50/D≥20/E), marking progress, teacher activity, maths error categories. No cache, computed per request.
- **LLM cohort cards** (`insights-card-generate.ts`): bottom/top decile, common gaps + strengths (one consistent call), Sonnet over up-to-60 submissions' feedback **prose**, cached per (owner, kind, scope) with corpus fingerprint + 24h TTL.
- **LLM student cards** (×4): same pattern over one student's latest-draft-per-task corpus, all-time.
- **Longitudinal student profile** (`lib/student-profile.ts`): Sonnet narrative from feedback prose + marks + teacher comments (quotes stripped), cached with a stale flag.
- **Class baseline** (`class_profile_summary`): Sonnet over cached student profiles. **School synthesis**: Sonnet over all-time `class_feedback` rollups.

### 3.2 The structural finding

> **Nothing in the insights layer reads the skill database.** `student_skill_profile` and `submissions.skill_assessment` are read by exactly one feature: the Lesson Differentiator. Even the longitudinal student-profile synthesis doesn't receive them.

Every insight staff see is either raw-mark arithmetic or **an LLM re-deriving patterns from feedback prose** — expensive, rate-limited, unquantified ("students struggle with evidence" — how many? which ones? trending which way?), non-comparable across time (two generations of the same card can disagree from sampling alone), and floor-gated. Meanwhile the product's stated moat — months of consistently-rated, per-dimension skill data — sits unqueried. You are paying Sonnet to approximate, from prose, information you already hold as structured numbers.

### 3.3 Recommendations

> **R1 — BUILT 2026-07-03.** The cohort skill matrix (**Skill breakdown** card) now ships: `lib/skill-matrix.ts` (`computeSkillMatrix`, pure/unit-tested) → `api/insights-cards.ts` (scoped by enrolled students × in-scope disciplines) → `renderSkillMatrix` in `public/insights.html`, on both the teacher and leader/admin grids. Per-dimension level distribution + median + net-trend + confidence + spine rollup + focus dimension. Deterministic, free, no-band. R2–R6 below remain open.

**R1. Build the deterministic skill layer — the cohort skill matrix.** *(Highest leverage.)*
A class × dimension heatmap straight from `student_skill_profile`: for each of W1–W7 / M1–M6, the distribution of students across emerging→extending, the class median, trend arrows, confidence shading. Instant, free, no rate limit, no floor beyond confidence, quantified ("14 of 22 students at *developing* or below on W4 Use of evidence, trend flat"), and identical on every load. Teacher tier scopes to their classes; leader/admin aggregates by faculty/year with a school baseline column. This single card turns the taxonomy from invisible plumbing into the visible product, and it's what makes ProofReady's insights *defensible* — an LLM summary of feedback prose is replicable by anyone; a term of consistent per-dimension measurement is not. The spine tier (4 capabilities) gives leaders a cross-KLA view no prose synthesis can.

> **R2 — BUILT 2026-07-03.** The `skill_observations` history log now ships (`scripts/skill-observations-migration.sql`), written alongside the rollup by `recordSkillObservations` (`lib/skill-profile.ts`, submission id threaded through all four write paths) and backfillable via `npm run backfill-skill-observations`. The cohort **Skill growth** card (`lib/skill-history.ts` `computeSkillGrowth` → `renderSkillGrowth` in `insights.html`, both grids) shows within-student growth per dimension over the dashboard window. **Two migrations to run before this works: `skill-observations-migration.sql`, then the backfill.** **R2b — BUILT 2026-07-03**: per-student **Skill trajectory** card (sparklines of each dimension's level over time) on the individual student view — `computeStudentSkillJourney` in `lib/skill-history.ts` → `renderSkillTrajectory` in `insights.html`. R3–R6 below still open.

**R2. Add a skill observation history and show growth over time.**
The rollup is a snapshot; history exists only inside per-submission jsonb. Add a thin `skill_observations` table (student, dimension, level, confidence-weight, submission_id, created_at) written alongside the rollup — backfillable from `submissions.skill_assessment`. Then: dimension trend lines per student, "most-improved dimensions this term" cohort cards, and term-over-term class growth. *Growth in developmental levels is the report schools actually want* — and it's mark-free, so it strengthens rather than strains the no-band rule. This is also the retention story: the longer a school stays, the more valuable the history.

**R3. Feed the skill profile into every LLM synthesis.**
The student profile, student cards, and cohort cards should receive the structured skill rollup (levels, trends, confidence) *alongside* the prose. It anchors the narrative ("their Use of evidence has moved from emerging to consolidating over five submissions"), reduces run-to-run variance, and shrinks the prompt (structured lines are cheaper than 60 prose blocks). The prose stays for colour; the numbers carry the claims.

**R4. Rebuild improvement velocity on skill deltas, not string matching.**
The current "addressed/persistent/regressed" card compares verbatim improvement titles across drafts — regenerated LLM text rarely repeats strings, so the numbers are noise (P2 finding). Per-dimension `skill_assessment` deltas between drafts of the same task measure the same thing robustly: dimension went up = addressed, flat = persistent, down = regressed. Same card, real numbers, no LLM call.

**R5. Quantify LLM-card claims and close the insight → action loop.**
Every gap/strength a cohort card asserts should carry a count and (for the authorised teacher) the affected students — the skill data makes this checkable rather than vibes. Then make each gap actionable: click a gap → the students behind it → one button: *"Create a Lesson Differentiator task targeting W4."* Insights currently terminate in reading; the flywheel (feedback → profile → differentiated task → more feedback) only spins if the insights page can start it. This is also the demo moment for leadership: identify a school-wide gap and dispatch targeted work in two clicks.

**R6. Fix corpus sampling and label provenance.**
Recency-sort and stratify the LLM-card corpus (per class/task caps so one big class doesn't dominate); tag Haiku-sourced vs Sonnet-sourced feedback in the prompt so the model can weight quality; and print sample provenance on every card face — "based on 43 submissions across 6 tasks, past 12 months, 3 below confidence threshold." An experienced teacher hedges on thin evidence; the cards should too. It's also the cheapest trust-builder with sceptical staff.

**R7. Sequence the correctness fixes first.**
R1–R6 all read scoped data through the same queries the audit flagged — fix P0-4 (faculty scope), P1-1 (truncation), P1-6/7/8 (fingerprint, quick_task, draft double-count) before building on top, and P0-1/P1-10 (write-side loss + race) so the skill data the new layer showcases is actually complete.

**Suggested build order:** P0 fixes → R1 (cohort skill matrix, ~the biggest visible win per unit of work) → R2 (history table + backfill) → R4 (velocity rebuild, quick) → R3 (prompt enrichment) → R5 (action loop) → R6 (polish).

---

## 4. What's in good shape

Worth saying plainly — the audits went looking for trouble and much of the foundation held:

- **LTI 1.3 is genuinely well built**: atomic single-use nonces, JWKS verification with pinned issuer/audience/alg, allowlisted redirect targets, consent-based account linking, idempotent provisioning that converges on unique-violation races.
- **Handler-level authorization is consistently enforced** across task/submission/insight reads, with student-facing reveals (worked solutions, MC keys, hidden criteria, skill assessments) stripped server-side until appropriate.
- **Prompt-injection hardening is real where the raw draft enters the model**: `wrapUntrusted` fencing, untrusted-content rules, sanitised replayed signals, length caps, verbatim-quote verification on inline annotations.
- **Text-position XSS escaping is disciplined** across all pages (the quote gap in P0-2 notwithstanding) — the annotation renderers escape per-segment rather than splicing raw HTML.
- **Idempotency and failure-tier design**: partial unique indexes with benign 23505 handling, load-bearing passes fail the request before consuming a draft while cosmetic passes soft-fail, `Promise.allSettled` on side effects with `waitUntil` where redirects can't wait.
- **Cost discipline**: prompt caching on static system prompts, rate limits on every Claude endpoint, fingerprinted card caches that make unchanged regenerations free.
