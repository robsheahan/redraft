# ProofReady — Full Codebase Audit (v2, consolidated)

**Date:** 2026-06-11 (v1 security pass in the morning; v2 full-stack pass + first fixes in the afternoon)
**Auditor:** Claude (Opus 4.8). v2 covers: Canvas LTI (deepest), API authz, DB/RLS, frontend, LLM pipeline/cost/reliability, code quality/ops.
**Status:** 🟢 **Batches A–C + Q1/Q2 MERGED to `main`** (PR #5, 2026-06-11). All migrations + the role backfill have been run in prod; the code-level fixes go live on the next Vercel deploy of `main`. Done: all LTI hardening, API authz/privacy, M4, P8, P4, P1/H3, P2, P5-cap, **Q2A role→app_metadata (H2), Q2B LTI identity (L1/LTI-12), Q1 signup phase-1 (C1)**. Remaining (all non-blocking follow-ups): Q1 email-verification (phase 2), Q2B opt-in link UX, and the withHandler/CI refactor (in progress — PR #7).

---

## ⚠️ ACTION REQUIRED — ✅ all done (kept as the run log)

1. ✅ `scripts/lti-hardening-migration.sql` — run + verified live (anon RPC now 401s, `lti_dl_sessions` RLS returns `[]`).
2. ✅ `scripts/submissions-update-hardening-migration.sql` (M4) — run.
3. ✅ `scripts/submission-idempotency-migration.sql` (P8) — run.
4. ✅ `scripts/backfill-role-to-app-metadata.ts` (Q2A) — run: 78 users, all roles copied into `app_metadata` (re-run confirms 0 remaining). The teacher gates now resolve correctly once deployed.
5. `scripts/drop-lti-find-user-by-email.sql` (Q2B) — optional cleanup, not yet run (RPC already locked down by LTI-9).
6. **Deploy:** PR #5 is merged to `main`. **Verify the Vercel auto-deploy landed (or run `vercel --prod`)** — the code-level fixes only take effect once `main` is deployed. Smoke test: a teacher can still create a task / generate criteria (exercises the new `app_metadata.role` gate).

---

## Fixes applied today (working tree)

| Fix | Files |
|---|---|
| **LTI-9** RPC `lti_find_user_by_email` publicly executable → `REVOKE` migration written; also patched into `lti-migration.sql` for fresh setups | `scripts/lti-hardening-migration.sql` (new), `scripts/lti-migration.sql` |
| **L2** `lti_dl_sessions` missing RLS → enable line in the same hotfix migration + `lti-migration.sql` §6 | same |
| **LTI-10** Reflected HTML (XSS) on `/lti/login` + `/lti/launch` error paths → responses forced to `text/plain` | `api/lti/login.ts`, `api/lti/launch.ts` |

`npx tsc --noEmit` clean after changes.

---

## Overall posture

Unchanged from v1, sharpened by v2:

> Identity and role are trusted from **email + self-assertion**, and every API route uses the **service-role key (bypasses RLS)** — all authz lives in code, so any missing check has no DB safety net. This matters most as you go from one pilot school to multi-school.

v2 adds a second systemic theme:

> **Untrusted student text shares prompts with authoritative content** (marking guidelines, teacher notes) with no "treat as data" hardening anywhere, and the model outputs it influences (skill_assessment) feed a **permanent** store (`student_skill_profile`) that drives Lesson Builder differentiation and teacher insights.

---

## Canvas / LTI node (the priority surface)

**Verdict: structurally sound; the two worst edges were fixed today.** Verified solid in v2: platform lookup keyed by **issuer + client_id (+ deployment_id)** so Canvas Cloud's shared issuer is multi-tenant-safe; deep-link sessions are random-UUID tokens, auth-bound to the launching user, expiry-checked, single-use; DeepLinkingResponse JWT carries spec-correct iss/aud/deployment_id/nonce; service-token cache keyed per platform+scopes; AGS `userId` sourced from our stored mapping, spec-correct Score payload; JWKS endpoint exposes public key only; NRPS pagination handled; `classes.code` is UNIQUE.

### v1 findings — v2 status

| # | Sev | Status | Issue |
|---|-----|--------|-------|
| L1 | **High** (multi-school) | ✅ FIXED (Q2B) | Cross-tenant identity via email (`lti_find_user_by_email` linking + magic-link login by email). Must fix **before school #2**. → Open Question 2. |
| L2 | High | ✅ **FIXED today** (run the SQL) | `lti_dl_sessions` RLS. |
| L3 | Medium | ✅ FIXED (Batch B) | `consumeNonce` read-then-write race (`lib/lti/nonce.ts:15-31`). Atomic CAS fix in Batch C. |
| L4 | Medium | ✅ FIXED (Batch B) | `redirect_uri` = unvalidated `target_link_uri` (`api/lti/login.ts`). Allowlist fix in Batch C. |
| L5 | Low | ✅ FIXED (Batch B) | `algorithms: ['RS256']` not pinned (`lib/lti/jwt.ts:70-73`). |
| L6 | Low→**Info** | downgraded | The deployment_id used for lookup comes from the same signed token that is then verified, so the missing post-verify assert is belt-and-braces only. Multi-value `aud` picks `aud[0]` for lookup — brittle (fails closed), not exploitable. |
| L7 | Low | ✅ FIXED (Batch B) | Expired `lti_nonces` never purged. |
| L8 | Info | ✅ FIXED (Batch B) | `createLineItem` dead code (grep-verified no callers). |

### New v2 findings

| # | Sev | Status | Issue |
|---|-----|--------|-------|
| LTI-9 | **Critical** | ✅ **FIXED today** (run the SQL) | **`lti_find_user_by_email` RPC publicly executable.** SECURITY DEFINER fn in `public` schema; Postgres grants EXECUTE to PUBLIC by default and the migration never revoked it. Verified live: anon key → `POST /rest/v1/rpc/lti_find_user_by_email` → HTTP 200. Returned any user's id + **full `raw_user_meta_data`** (role, display name, graduation year) for any email — user enumeration + PII disclosure. |
| LTI-10 | **High** | ✅ **FIXED today** | **Reflected HTML on unauthenticated `/lti/login`** — `res.send(string)` in @vercel/node defaults to `Content-Type: text/html` (verified in the package source), and `login.ts` echoed `iss`/`client_id` query params into the 403 body; served on the proofready.app origin (via the `/lti/*` rewrite) where the Supabase session lives in localStorage. `launch.ts` echoed the token's email claim similarly (lower risk — needs a signed token). Both handlers now force `text/plain`. |
| LTI-11 | **Medium** | ✅ FIXED (Batch B) | **NRPS roster sync fires after the response.** `syncRoster(...).catch(...)` is not awaited (`api/lti/launch.ts:140-144`) and the handler redirects immediately. On Vercel serverless, post-response work is frozen/killed — large roster syncs can silently die partway AND the `.catch → captureError` may never run. Fix: `await` it before the redirect (with a time budget), or move to `waitUntil` (`@vercel/functions`). |
| LTI-12 | Low | ✅ FIXED (Q2B) | **First-launch createUser race not converged.** Two concurrent launches for a brand-new user both miss the mapping and the email lookup; both call `admin.createUser` — the loser gets "already registered" and **throws → 500** (`lib/lti/user-provision.ts:54-59`). The 23505 convergence exists for the mapping insert but not for createUser. Fix: on "already registered", re-run the email lookup and converge. |
| LTI-13 | Low | open | **Role-mapping choices worth a deliberate decision** (`lib/lti/roles.ts`): institution-level `Administrator` → teacher in any course they launch; `TeachingAssistant` → full teacher (incl. marking + insights); `Observer` (parents) → a normal **student** account that can submit work. Also: a launch never updates an existing user's role (good), but a self-signed-up "teacher" keeps teacher on LTI launch. |
| LTI-14 | Info | open | **State is not browser-bound.** state+nonce are DB-validated, single-use, 10-min TTL — but nothing ties the completing browser to the initiating one (no cookie; largely unachievable in Canvas iframes with third-party-cookie blocking). Residual login-CSRF risk is inherent to LTI form_post; accept and document. |
| LTI-15 | Info | open | **AGS portability:** `${lineItemUrl}/scores` breaks if a platform's line-item URL carries a query string (fine on Canvas; Moodle etc. use query params). Insert `/scores` before the query string when you outgrow Canvas. |
| LTI-16 | Info | open | **Co-teacher UX dead-end:** teacher B launching a course already mapped to teacher A's class is redirected to `class-detail.html` for a class they don't own → 403s. Decide a co-teacher story before a school hits it. |

**LTI observability** (from the ops review): every early `4xx` rejection in login/launch returns to the Canvas iframe with no log line and no Sentry event. One `console.warn('[lti] reject', reason, ...)` per early return is the difference between a 5-minute and a 5-hour pilot incident.

---

## Cross-cutting (v1) — v2 status

- **C1 — `api/signup.ts` unauthenticated, unthrottled, pre-confirmed, body-supplied role.** 🟡 PARTIAL (Q1 phase 1): body role removed (new accounts unroled until authenticated set-role) + global daily signup cap. Email verification (phase 2) + per-IP/captcha deferred.
- **H1 — `generate-feedback` never 401s a null user.** ✅ FIXED (Batch B). Was worse than v1 stated: anon callers skip the draft caps and per-user limits entirely; only the global 5000/day cap applies, and that resets daily (`api/generate-feedback.ts:100`, branches at `:198`/`:242`). Highest-priority one-line fix.
- **H2 — self-assignable `user_metadata.role`.** ✅ FIXED (Q2A): authoritative role moved to `app_metadata` (service-role only); gates read authoritativeRole(); backfill script must run before deploy. (Upload rate limit already added in Batch B.)
- **H3 — prompt injection.** ✅ FIXED (Batch C, P1/H3): wrapUntrusted() + system rule end-to-end. See P1 row.
- **M1 — email-domain school scoping / search leaks class names.** CONFIRMED, open.
- **M2 — student email into prompts/summaries.** ✅ FIXED (Batch B). Was at (`insights-card-generate.ts:806`; same pattern `insights-student.ts:136`).
- **M3 — raw `error.message` to clients.** CONFIRMED (~25 sites). Fold into the `withHandler` refactor.
- **M4 — `submissions` student UPDATE not column-restricted.** ✅ FIXED (Batch C): dropped the over-broad student UPDATE policy (no client flow updates submissions directly — all writes go through service-role API routes) and revoked the table UPDATE privilege from anon/authenticated. `scripts/submissions-update-hardening-migration.sql` (must be RUN in Supabase) + patched into `rls-policies.sql` for fresh setups.
- Low (v1): global rate-limit fails open (intentional, leave); `listUsers` truncation (open); `.env.example` incomplete (open — actual count: documents 3 of ~13 vars); dead code `lib/extract-json.ts` (confirmed unreferenced).
- **STALE:** v1's "three pre-existing TS errors in insights-synthesis.ts" — **fixed**; `tsc --noEmit` is clean. PROJECT_OVERVIEW.md "Known issues" needs updating.

### RLS reality check (v2)

`rls-policies.sql` is partially superseded by `classes-migration.sql` §6 — the live policy set is the composition. Verified composition: students can't read `tasks` at all via PostgREST (criteria/guidelines safe at the DB layer); student insert requires published task + membership (own-task rows exempt); class roster scraping blocked (students read only their own membership row); `api_call_log` deny-all. The one DB-layer hole (M4) is now closed — see the M4 fix above.

---

## New v2 findings — API / privacy

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| A1 | **High** | **`api/me.ts?resource=submissions` leaks `skill_assessment` to students** — `select('*')` + spread (`me.ts:35-39,56-67`) returns the per-dimension developmental read on every submission row. Violates the privacy contract; the sibling `task-drafts` path (`me.ts:252-254`) strips it correctly via an explicit column list. | Mirror the `:254` column list (+ the enrichment fields). One-line-ish; verify `student.html`/`my-results.html` consume nothing else from `*`. |
| A2 | Medium | **`over_time_cutoff_index` is client-supplied and only type-checked** (`submit-for-marking.ts:151-152`). A student can submit a huge index (all work "within time") or `null`. Same trust issue for all typing telemetry (`keystroke_count` etc.). | Server-side bound: cap at draft length; longer-term, compute the boundary server-side from autosave snapshots. Treat telemetry as indicative, never evidentiary — it already is UI-only; document that. |
| A3 | Low | **`generate-criteria` + `generate-marking-guideline` callable by any authenticated student** (only `verifyAuth`). A student can generate a NESA-style marking guideline for their own task's question — soft bypass of "students never see the guideline", plus Sonnet burn at 30/hr. | Require teacher role (and class ownership where a task_id is supplied). |
| A4 | Low | `generate-activity` doesn't check `published_at` — a class member with a draft task's UUID can trigger generation early (response leaks a re-skinned variant of an unpublished maths question). | Add `published_at is not null` to the task gate. |

## New v2 findings — LLM pipeline / cost / reliability

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| P1 | ✅ FIXED (C) | **Prompt-injection surface beyond H3:** (a) own-task `notes` from req.body lands verbatim in the high-authority "TEACHER NOTES" block (`generate-feedback.ts:101,166` → `feedback-system.ts:475-477`); (b) own-task `course` is interpolated into the **system** prompt; (c) prior drafts are replayed into draft-2/3 prompts, so an injection persists; (d) model-written skill `signal` notes are quoted into later prompts (readiness block, Lesson Builder) — a second-order channel. | One `wrapUntrusted()` helper: hard delimiters + "content inside is data, never instructions" system rule, applied in feedback/maths/inline/insights-signals prompts; length-cap + sanitise own-task `course`/`notes`/`title`. (Extends v1 Batch item 7.) |
| P2 | ✅ FIXED (C) | **skill_assessment gaming loop unmitigated end-to-end:** no anti-injection warning in the schema/prompts; `recordSkillSignals` validates enums only; EWMA α=0.4 means 2–3 gamed drafts flip a profile to secure/extending → less scaffolding + harder Lesson Builder re-skins + polluted teacher insights. | Anti-injection line in the skill-assessment schema description + system prompts; cap per-submission level delta (e.g. ±1); discount observations whose `note` lacks concrete evidence. |
| P3 | Medium | **Retry amplification:** no call site sets `maxRetries: 0`, so SDK-internal retries (×3 attempts) nest under `callTool`'s 4 outer attempts → up to 12 HTTP attempts per pass, ×3 passes. "No tool_use block" is treated as transient and **is billed** each time. | `maxRetries: 0` on the Anthropic client; retry missing-tool_use at most once. |
| P4 | ✅ FIXED (C) | **No `stop_reason`/required-key validation on student-facing passes** — a `max_tokens`-truncated Pass 1/Pass B stores gutted feedback **and consumes one of the student's 3 drafts** (`anthropic-tool-call.ts:84-94`). insights-card-generate already validates keys; the feedback paths don't. | `requiredKeys` + `stop_reason` check inside `callTool` (opt-in per caller). |
| P5 | ✅ FIXED (C) | **Student insight cards: per-student endpoint suffix defeats the global cap** (`insights-card-generate.ts:720-732`) — `globalPerDay: 400` is effectively *per student*, and student cards are uncached. The most expensive genuinely-uncapped authenticated path. | Second shared-key global check; add per-student fingerprint caching. |
| P6 | Medium | **`[object Object]` ×3 per student in class-feedback prompts** (`generate-class-feedback.ts:106-109`) — `task_verb_check`/`overall`/`top_priority` are `{summary, detail}` objects. The class synthesis runs on strengths/improvements only. Also no per-student/total size cap on that prompt. | `.summary` + `.slice()` caps. |
| P7 | Medium | **`maxDuration: 300` covers only 2 of ~8 LLM endpoints** (`vercel.json:3-6`). `generate-maths-feedback` (two *sequential* Sonnet passes; inserts only after Pass C) dies mid-flight on the default timeout — Pass B spend wasted, submission lost. Same exposure: `generate-activity`, `insights-card-generate`, `insights-synthesis`, `student-profile`, `structure-maths-working`. | Add explicit `functions` entries for every Claude-backed endpoint. |
| P8 | ✅ FIXED (C) | **No idempotency on submission insert** — draft_version is read-then-insert with no unique constraint; a double-click = two drafts + 6 Sonnet calls (`generate-feedback.ts:219-241,470`; `submit-for-marking.ts:93-97`). | Unique index `(student_id, task_id, draft_version)` (+ own_task variant) + conflict handling. |
| P9 | Medium | **Maths Pass C failure silently consumes a draft** with empty holistic feedback (`generate-maths-feedback.ts:218-236`); essay Pass 2/3 failures likewise store partial feedback as a counted draft. Also: **essay submission insert error is unchecked** (`generate-feedback.ts:470` — maths checks it). | Check the insert; mark degraded results and exempt them from the 3-draft count. |
| P10 | Low | Own-task `question`/`criteria_text`/`notes`/`title` length-unbounded into Sonnet prompts (only `draft` is capped). | Per-field caps (question 5k, criteria 10k, notes 2k, title 200). |
| P11 | Low | Missing `graduation_year` defaults to **Stage 6** — a Year 8 student with no metadata gets HSC-calibrated feedback + splits the prompt cache (`generate-feedback.ts:311-317`). | Derive stage from task/class, fall back to user metadata. |
| P12 | Low | `task_activities` never invalidated when a task's question is edited after students opened it — maths feedback then evaluates against the stale re-skin. | Delete/flag `task_activities` rows on question edit; warn the teacher. |
| P13 | Low | Maths `line_annotations[].line_index` not upper-bounded server-side (essay quotes are fully validated). | Clamp/drop out-of-range indices. |
| P14 | Info | Sonnet on floating alias `claude-sonnet-4-6` (17×) vs Haiku snapshot-pinned; `generate-criteria` + `generate-marking-guideline` bypass `callTool` (no usage logging, no cache); insight fingerprints blind to course edits + in-place regens (24h TTL backstops); resubmission prompts replay all prior drafts (draft 3 ≈ 3× input cost — intentional, noted). | `lib/config.ts` model constants; route the two endpoints through `callTool`. |

## Code quality / ops (highest-value items)

Full detail lives in the review output; the ranked list:

1. **`withHandler` wrapper** (CORS + method + auth + try/catch + Sentry + generic error body) applied to all 35 handlers — fixes the 17-handlers-with-no-try/catch gap, the 19-handlers-no-Sentry gap, and M3 in one refactor; deletes ~150 boilerplate lines.
2. **`api/health.ts`** returning `{ok, sha: VERCEL_GIT_COMMIT_SHA}` — directly mitigates the flaky-auto-deploy problem.
3. **CI**: `skipLibCheck: true` (kills 3 node_modules-only tsc errors), `typecheck`/`test` scripts, 20-line GitHub Action. There is currently **no CI at all**.
4. **Complete `.env.example`** (13 vars; missing incl. `LTI_PRIVATE_KEY(_HEX)`, `LTI_KEY_ID`, `SITE_ORIGIN`, `RESEND_API_KEY`, `SENTRY_DSN`, `ADMIN_USER_IDS`, `SUPABASE_ANON_KEY`, `SUPABASE_SITE_URL`).
5. **maxDuration for all LLM endpoints** (= P7).
6. **LTI rejection logging** (see LTI observability above).
7. **`lib/config.ts`** — model ids (17 hardcoded), `MAX_DRAFTS` (defined twice), rate-limit table (26 hand-typed values across 13 files).
8. **Offline tests**: LTI launch round-trip with fake JWKS; rate-limit counting units; rubric-parser fixtures.
9. **Dead code + docs drift, one commit**: `lib/extract-json.ts`, `data/hms-stage6.ts`, `data/pdhpe-stage6.ts`, `public/proofready-banner.svg`, `demo-screenshots/walkthrough.html`; PROJECT_OVERVIEW fixes (stale TS-errors bullet, `/handout` rewrite line, tsconfig description, env vars, test/ section); `.gitignore` += `demo-screenshots/*.m4a`.
10. **Shared frontend helpers**: `escapeHtml`/`fmtDate`/`showToast`/`showError` into `js/app.js`; exam-timer module shared by submit/submit-maths (currently copy-pasted pairs).

Dependency notes: `jose` 5→6 worth scheduling (LTI surface); Sentry 8→10 defer; supabase-js minor bumps free.

---

## Updated fix plan

**Batch A — done 2026-06-11 (morning):** LTI-9, LTI-10, L2 (SQL written; **you must run it**).

**Batch B — ✅ DONE 2026-06-11 (in tree, uncommitted):**
1. ✅ H1: 401 on null user in `generate-feedback.ts` (maths endpoints already had it). Per-user rate limits now always apply.
2. ✅ A1: explicit column list in `me.ts` returnSubmissions (mirrors task-drafts + own_task/task identity fields; student.html verified as the only consumer).
3. ✅ L3 atomic nonce (CAS UPDATE … WHERE consumed_at IS NULL); L7 opportunistic purge of day-old expired nonces on consume; L5 `algorithms: ['RS256']` pinned; L4 target_link_uri allowlist (https + proofready.app/\*.proofready.app/request-host + the 4 registered LTI paths).
4. ✅ LTI-11: roster sync via `waitUntil` (`@vercel/functions` added); `[lti] login/launch reject` console.warn on every early 4xx in login.ts + launch.ts.
5. ✅ P7: vercel.json `functions` entries for all 12 Claude-backed endpoints (incl. task.ts rubric parse + submit-for-marking signals). P3: `maxRetries: 0` on all 15 Anthropic client sites; missing-tool_use now retried at most once in callTool.
6. ✅ M2: email fallback removed from `studentName` in insights-card-generate.ts + insights-student.ts. Headers block in vercel.json (nosniff, HSTS, Referrer-Policy, Permissions-Policy, CSP `frame-ancestors 'self' https://*.instructure.com` — full script-src CSP deferred, would break inline-script pages). Attachment upload rate limit (60/user/hr, 2000 global/day).
7. ✅ A3: teacher-gate on generate-criteria + generate-marking-guideline (user_metadata role — upgrade with Q2). A4: published_at gate in generate-activity.
8. ✅ P6: `.summary` extraction + per-field caps in class-feedback prompt. P9: essay submission insert error now checked (mirrors maths).
9. ✅ L8 createLineItem removed; deleted lib/extract-json.ts, data/hms-stage6.ts, data/pdhpe-stage6.ts, demo-screenshots/walkthrough.html; .gitignore += demo-screenshots/*.m4a; PROJECT_OVERVIEW drift fixed (TS-errors bullet, /handout → handout.pdf, tsconfig description, full env-var list, test/ section). **Kept `public/proofready-banner.svg`** — it's the vector banner asset referenced in pitch/dany-brand-brief.md, not dead code.

**Batch C — needs ~an hour each, do before school #2:**
- ✅ **P1+H3 DONE** (working tree, uncommitted at time of writing → committed on `security/audit-batch-ab-2026-06-11`): `lib/prompt-safety.ts` `wrapUntrusted()` + `UNTRUSTED_CONTENT_RULE` applied end-to-end — essay (Pass 1 + Pass 2, incl. own-task brief/criteria/notes relabel + field caps P10 + course-label sanitise), maths (per-line/holistic/structure-working + replayed diagnostic), inline (draft + replayed improvements), insights-signals (draft), Lesson Builder + readiness `signal` sanitised. Forged-fence attack verified neutralised; stray `%` in maths preserved.
- ✅ **P2 DONE**: anti-gaming line in the skill_assessment schema; evidence-weighted EWMA (model confidence + note-substance floor scale the step); hard ±1 per-submission level cap. Verified: 5 gamed drafts reach ~3.4 not ~4.8. (lib/skill-profile.ts, data/skill-taxonomy.ts)
- ✅ **M4 DONE**: dropped the over-broad student UPDATE policy + revoked table UPDATE from anon/authenticated (no client flow updates submissions directly). SQL must be run in Supabase.
- ✅ **P8 DONE**: partial unique indexes on (student_id, task_id/own_task_id, draft_version) + 23505 treated as benign duplicate in all 3 insert sites (SQL must be run in Supabase). ✅ **P4 DONE**: callTool requiredKeys/stop_reason guard — a truncated student-facing pass rejects (essay/maths-PassB abort with no draft consumed; maths-PassC degrades to line annotations) instead of persisting gutted feedback. ✅ **P5 cap DONE**: shared-key global circuit breaker (insights-card-student:global, 1500/day, userId=null) caps total student-card spend — the per-student key no longer gives each student its own 400/day bucket. ✅ **P5 caching DONE**: per-student fingerprint cache `student_insights_cards` (keyed student+kind+scope; deny-all RLS), mirroring the cohort cards — a re-click with no new work returns the card free, skipping the rate limit + spend. SQL must be run in Supabase.
- `withHandler` refactor + health endpoint + CI (quality items 1–3).

**Open questions — RESOLVED (decisions in `SECURITY-Q1-Q2-DESIGN.md`, implemented):**
- **Q1 Signup model (C1):** decided "harden now, verify later". Phase 1 done (drop body role + global daily cap). Phase 2 (email verification) deferred until self-signup opens beyond invited pilots.
- **Q2A Role model (H2):** ✅ authoritative role → `app_metadata`. **Run `scripts/backfill-role-to-app-metadata.ts` before deploy.**
- **Q2B LTI identity (L1):** ✅ B1 — identity keyed on `(platform, canvas_user_id)`; no email auto-linking; createUser race converges; genuine email collisions get a clean 409. Remaining UX follow-up: the self-service "link my Canvas account" flow (a feature, not a vuln).

**Deferred:** M1 search-scope fix (independent piece can go in Batch B), M3 via withHandler, listUsers pagination, LTI-13 role-mapping decisions, LTI-15/16 portability + co-teacher story, P11–P13, frontend helper consolidation, jose 6.

---

## Verified solid (consolidated — don't re-litigate)

- v1 list still holds: no secrets in git/client (anon key only); deps current-enough with no advisories; LTI signature/nonce/state verification correct; output escaping via `e()` textContent helper everywhere (v2 re-verified the recently-added paths: Lesson Builder banner, feedback JSON-decode/self-check, mark-submission save bar, attachment names, deep-link picker); ownership checks on all v1-listed endpoints; student↔student RLS isolation; no `USING(true)`; forced tool-use everywhere (no free-text JSON.parse).
- v2 additions: multi-tenant platform lookup (issuer+client_id); deep-link session auth-binding; AGS payload + userId sourcing; service-token cache keying; NRPS pagination; attachment path construction + download authz; tasks unreadable by students via PostgREST; roster-scrape blocked by class_members RLS; `recordSkillSignals` enum/range validation; inline-annotation quote validation; Sentry `sendDefaultPii: false` with no draft text in context; profile-synthesis privacy strip (minor caveat P1d); cohort prompts name-free; readiness block correctly in the user prompt (cache-safe); error-shape discipline (`{error}` + correct status codes everywhere); PROJECT_OVERVIEW endpoint list accurate.
