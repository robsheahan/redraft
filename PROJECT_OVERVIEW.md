# ProofReady — Project Overview

A NESA-aligned formative-feedback tool for NSW HSC student drafts. Teachers create classes and tasks, students submit drafts, and AI returns criteria-anchored feedback in the voice of an experienced HSC marker. Built by Rob Sheahan (a NSW PDHPE teacher) and shipped as a Canvas LTI 1.3 pilot starting with Penrith Christian School. Repo: `robsheahan/redraft`. Domain: `proofready.app`.

## Central design question

Every build decision is evaluated against one question:

> **"How can we get the most accurate possible feedback to mimic that of a professional, experienced teacher?"**

Concretely: no mark/band predictions, no content rewriting, marker-voice prompts calibrated against NESA Notes from the Marking Centre 2021–2024, three-pass feedback architecture (holistic + criterion-by-criterion + inline annotations), strict subject-aware glossary and verb-depth checks.

## Stack

- **Hosting:** Vercel (Pro plan, 300s function timeout). Production routes `/api/*` through `api.proofready.app` (Cloudflare DNS-only — bypasses Cloudflare's 100s edge proxy timeout).
- **Frontend:** Vanilla JS + HTML in `public/`. No framework, no build step. Supabase JS SDK loaded from CDN.
- **Backend:** TypeScript serverless handlers in `api/` using `@vercel/node`.
- **Database / auth:** Supabase (Sydney region, project ref `jcxcbqsxshlwwvxlyyfd`). NOT to be confused with Citrafort's separate Supabase project (`kjueriejebawtccuqxid`) — different app.
- **AI:** Anthropic Claude Sonnet 4.6 via `@anthropic-ai/sdk`. Three parallel passes per submission; tool-call schemas for structured outputs.
- **Email:** Resend (outbound, custom proofready.app domain). Cloudflare Email Routing for inbound `help@`.
- **Auth providers:** Supabase email/password + Google OAuth + Canvas LTI 1.3 launch.
- **Observability:** Sentry (browser + Node.js projects).

## Domains & routing

- `proofready.app` — frontend static pages
- `api.proofready.app` — Cloudflare DNS-only CNAME → Vercel, used for all `/api/*` calls (lets long Anthropic calls run past 100s)
- `/lti/*` — rewritten to `/api/lti/*` in `vercel.json` so Canvas can call our pre-registered LTI URLs without the `/api/` prefix

## Roles & access tiers

There are two independent role systems:

**`user_metadata.role`** (per user, set on signup):
- `teacher` — can create classes/tasks, mark submissions, see insights
- `student` — can join classes, submit drafts, view their own feedback + markbook

**Insights access tier** (per user, derived in `lib/schools.ts`):
- `teacher` (default) — every authenticated teacher; sees class-level insights for their own classes. No `school_members` row needed.
- `leader` (granted) — explicit `school_members` row, role=`leader`; sees school-wide insights, optionally faculty-scoped via the `faculties[]` array.
- `admin` (granted) — explicit `school_members` row, role=`admin`; full school view + access management.
- **Global admin** — `ADMIN_USER_IDS` / `ADMIN_EMAILS` env var; can `?school_id=…` override into any school.

## Data model (Supabase)

- `auth.users` — Supabase auth, with `user_metadata.role` ∈ {teacher, student}, `display_name`, optional `graduation_year` (used for student year-level filter).
- `classes` — `id`, `code` (6-char join code), `teacher_id`, `name`, `course`, `created_at`, `archived_at`.
- `class_members` — `class_id`, `student_id`, `joined_at`. Composite PK.
- `tasks` — `id`, `class_id`, `title`, `question`, `course`, `task_type`, `total_marks`, `due_date`, `outcomes` (jsonb), `criteria` (jsonb), `criteria_text`, `notes`, `published_at`, `created_at`, `class_feedback` + `class_feedback_count` + `class_feedback_generated_at` (cached class-level synthesis), `typed_response_only` (boolean, default true). LTI columns: `lti_platform_id`, `lti_resource_link_id`, `lti_line_item_url`, `lti_ags_lineitems_url`.
- `submissions` — `id`, `student_id`, `task_id`, `question`, `course`, `draft_text`, `feedback` (jsonb), `draft_version`, `created_at`. Capped at 3 drafts per student per task. Typing telemetry: `keystroke_count`, `paste_attempts_blocked`, `typing_session_count`, `total_typing_time_ms`, `time_to_first_keystroke_ms`. Teacher grading: `criterion_marks` (jsonb), `total_mark`, `teacher_comment`, `teacher_annotations` (jsonb — array of `{quote, comment, category, start, end}` with categories `praise`/`improve`/`note`), `graded_at`, `graded_by`. Final-submission flag: `submitted_for_marking` (boolean).
- `draft_autosaves` — `student_id`, `task_id`, `draft_text`, `telemetry` (jsonb), `updated_at`. Composite PK. Persistent in-progress drafts. Cleared on successful submission.
- `api_call_log` — rate-limit + spend tracking. `user_id`, `endpoint`, `created_at`.
- `schools` — `id`, `name`, `primary_domain`, `secondary_domains` (text[]), `insights_cache` (jsonb), `insights_cache_task_count`, `insights_cache_generated_at`.
- `school_members` — `school_id`, `user_id`, `role` ∈ {`admin`, `leader`}, `faculties` (text[], leaders only).
- `school_insights_cards` — per-school per-kind LLM card cache. `(school_id, card_kind)` PK. Student-kind cards are NOT cached here.
- `lti_platforms` — one row per Canvas instance (issuer, client_id, deployment_id, hostname, JWKS + auth URLs, school_name, school_id).
- `lti_nonces` — short-lived OIDC handshake nonces.
- `lti_user_mappings` — Canvas user_id ↔ auth.users.id, per platform.
- `lti_course_mappings` — Canvas course_id ↔ classes.id, per platform.
- `lti_dl_sessions` — short-lived deep-linking sessions.

## Core flows

### Teacher onboarding
1. Sign up email/password OR Google OAuth OR Canvas LTI launch.
2. First login → `choose-role.html` → picks `teacher` or `student`.
3. Lands on `teacher.html` (or `student.html`).

### Class + task lifecycle
1. Teacher creates a class on `new-class.html` (auto-generates 6-char join code).
2. Composes a task on `new-task.html` — question, criteria (rubric or band-style), outcomes, total marks, due date. `typed_response_only` toggle defaults ON.
3. Saves as draft OR publishes. Students see only published tasks.
4. Shares the join code (or, for LTI-linked classes, students auto-enrol via NRPS on teacher launch).

### Student submission
1. Joins a class with the code on `student.html`, or auto-enrolled via LTI.
2. Opens `submit.html` for a task.
3. Writes draft in the textarea. When `typed_response_only`: paste/drop blocked with a toast, mobile screens show "open on laptop" guard, autosaves every ~1.5s to `draft_autosaves`, typing telemetry captured.
4. Two submit paths:
   - **Get AI feedback** — runs `/api/generate-feedback` (three Claude passes). Counts toward the 3-draft cap.
   - **Submit for marking** — runs `/api/submit-for-marking` (no Claude call, locks the task for this student).
5. Locked state shows once any submission has `graded_at` OR `submitted_for_marking = true`.

### Three-pass AI feedback (`api/generate-feedback.ts`)
Three parallel Anthropic calls via `Promise.allSettled`. Wall-clock = max(pass1, pass2, pass3), not sum.

- **Pass 1 — Holistic** (`prompts/feedback-system.ts`): load-bearing. Builds a system prompt injecting NESA glossary, performance bands, marking principles, SOLO taxonomy, verb-depth map, common pitfalls, discipline-specific persona, marker-voice reference (NESA Notes), subject-specific terminology. Strict no-band/no-rewrite rules. Returns `improvements`, `what_youve_done_well`, `top_priority`, `task_verb_check`.
- **Pass 2 — Criterion-by-criterion**: skipped if no criteria provided. Per-criterion verdict + recommendation.
- **Pass 3 — Inline annotations** (`lib/generate-inline-suggestions.ts`): returns annotations anchored to verbatim quote substrings of the draft (the model is told to mark up like a teacher's pen). Each annotation's quote is validated to exist in the draft.

Rate-limited 10/hr per user, 5000/day global.

### Teacher marking (`mark-submission.html` → `submission-grade.ts`)
- Two-column layout. Student draft on the left with text-selection annotation tool (select text → "+ Annotate" → category + comment). Rubric mark entry on the right.
- Per-criterion inputs for criterion-list rubrics, single overall input for band-style.
- On save: writes `criterion_marks`, `total_mark`, `teacher_comment`, `teacher_annotations`, `graded_at`, `graded_by`. Clears the matching `draft_autosaves` row. Fires AGS passback to Canvas SpeedGrader if the task is LTI-linked.

### Student results view
- `my-results.html` — student "markbook". Summary strip (classes, tasks, marked, overall average), one card per class with class average, then per-task rows with status (not submitted / due soon / overdue / submitted / submitted late / marked) and mark.
- `feedback.html` — single submission's feedback. Adds a "Marked by your teacher" tab when `graded_at` is set, with per-criterion rubric breakdown in graded mode, teacher comment, and teacher annotations in blue/purple (differentiated from AI annotations).

## LTI 1.3 (Canvas)

First pilot: **Penrith Christian School** (`learningpcs.instructure.com`, client_id `277420000000000006`, deployment `238:4918899f387deeb8c2a566f759e392996b5535f4`). Seeded into `lti_platforms` via `scripts/lti-migration.sql`.

Endpoints (exposed at `/lti/*` via the `vercel.json` rewrite):
- `/lti/jwks` — public JWK Canvas uses to verify our DeepLinkingResponse JWTs
- `/lti/login` — OIDC initiation
- `/lti/launch` — main launch handler. Verifies platform id_token against Canvas JWKS, validates nonce, provisions user + class, kicks off async NRPS roster sync for teacher launches, redirects to magic-link session URL.
- `/lti/deep-link` — deep linking picker session info + signed response

Supports: OIDC initiation, resource link launch, deep linking, NRPS roster sync, AGS grade passback (completion + final mark). Issuer in config = `https://canvas.instructure.com` (generic Canvas Cloud value, not the school's hostname). JWKS/auth/token endpoints point to `sso.canvaslms.com`. Self-hosted Canvas instances would use the school's own domain.

Env: `LTI_PRIVATE_KEY` (RSA-2048 PEM, PKCS#8), `LTI_KEY_ID` (UUID kid), `SITE_ORIGIN`.

## Insights system

The largest subsystem outside the core feedback flow. Three-tier access (teacher / leader / admin), two views (cohort / individual student), eight LLM card kinds + six SQL-derived cards.

### Two views

**Cohort view** — default when no `student_id` filter set. The cards depend on tier:
- Teacher (class scope): mark distribution + improvement velocity + keyword struggles (verb_depth LLM) + top 3 mistakes (common_gaps LLM) + stretch goals (top_decile LLM, quartile mode) + 3 things done well (things_done_well LLM)
- Leader/admin (school scope): activity sparkline, faculty engagement, mark distribution, mark by faculty, marking progress, teacher activity, per-criterion lows, improvement velocity, keyword struggles, plus all five Tier-A LLM cards (bottom_decile, top_decile, verb_depth, common_gaps, things_done_well)

**Individual student view** — triggered by selecting a student from the search box. Available to all tiers. Five metric cards + a hero summary card:
1. Hero: **Student summary** (LLM, span 12) — 4–6 sentence report-style narrative + headline strength + headline priority + tone note
2. **Mark distribution** (span 6) — A–E band counts + per-task list (this student only)
3. **Improvement velocity** (span 6) — their own draft-to-draft priority shifts: addressed / persistent / regressed themes
4. **Top 3 mistakes** (LLM, span 6) — recurring patterns in their improvement feedback
5. **Stretch goals** (LLM, span 6) — personalised next steps
6. **3 things done well** (LLM, span 12) — consistent strengths

### Scope rules (enforced server-side)

In `lib/schools.ts`:
- `resolveInsightsAccess(supabase, user, opts)` → `{ schoolId, schoolName, callerRole, restrictedFaculties }`. Returns null only for unauthenticated callers.
- `getOwnedClassIds(supabase, userId)` — classes where teacher_id = userId.
- `getInScopeClassIds(supabase, role, userId, schoolId, restrictedFaculties)` — teacher = own; leader = school × faculty filter; admin = all school.
- `getInScopeStudentIds(supabase, role, userId, schoolId, restrictedFaculties)` — distinct student_ids across in-scope classes.

A teacher passing `?class_id=` for a class they don't own naturally returns zero rows (the classes query is constrained by `teacher_id IN [user.id]`). A student outside a teacher's class is filtered out by the same constraint — verified by the smoke test in `scripts/insights-student-smoke-test.ts`.

### LLM card caching

- Cohort cards for leader/admin tier: cached in `school_insights_cards` keyed by `(school_id, card_kind)`. Stored with the filter context used at generation time. UI shows a "stale scope" banner if active filters don't match.
- Teacher tier cohort cards: cache bypassed entirely — class scope would corrupt the school-keyed cache. Each click regenerates fresh; rate-limit caps spend.
- Student cards (all four kinds): no cache. Regenerated fresh each click. In-memory client-side state holds the result for re-renders without re-fetching.

Rate limit: 5/hr per user per card kind for cohort; 8/hr per student per kind on student cards (bucket key includes a short student_id prefix so spamming one student doesn't lock out others).

### Floors

- Cohort decile cards (top/bottom): ≥5 graded submissions (teacher tier uses ≥4, quartile slice).
- Teacher-tier cohort LLM cards: ≥10 submissions with feedback.
- Student LLM cards: ≥3 submissions with feedback (below that, the card shows "Not enough data yet" with the current count).

### Student search

`/api/insights-students-search?q=…` — substring match on `display_name` + `email`, case-insensitive, scope-restricted to `getInScopeStudentIds`. Returns up to 10 results, surname-prefix matches ranked first. Used by an autocomplete input on the insights page (120ms debounce, 1-char minimum, "Searching…" placeholder shown immediately).

## API endpoints

### Feedback + submissions
- `POST /api/generate-feedback` — Three-pass Claude feedback. Auth-required. Rate-limited.
- `POST /api/generate-class-feedback` — Teacher-only synthesis across a class's submissions for one task. Persists to `tasks.class_feedback`.
- `GET /api/task` / `POST` / `PUT` / `DELETE` — Task CRUD. Class teacher only.
- `GET /api/task-submissions` — All submissions for one task, enriched with student names. Teacher only.
- `GET /api/task-csv` — CSV export of submissions for a task.
- `GET /api/class` / `POST` — Class CRUD + join-by-code.
- `GET /api/me` — Current user's profile + role + classes. Subpaths: `?resource=submissions`, `?resource=task-drafts&task_id=…`, `?resource=results`.
- `GET /api/draft-autosave` / `PUT` — In-progress drafts.
- `POST /api/submit-for-marking` — Final non-AI submission. Locks the task.
- `PUT /api/submission-grade` — Teacher marking. Writes rubric marks + annotations + fires AGS passback.
- `POST /api/signup` — Custom signup with display_name + email_confirm bypass.
- `POST /api/request-password-reset` — Resend-powered reset email.
- `POST /api/set-role` — Sets `user_metadata.role`.
- `POST /api/contact` — Contact form → forwards to help@.

### Insights
- `GET /api/insights-cards` — Cohort cards (school or class scope based on caller role + filters).
- `GET /api/insights-student?student_id=…` — Single-student card data. Verifies caller scope.
- `GET /api/insights-students-search?q=…` — Typeahead student search.
- `GET /api/insights-detail?kind=teachers|classes|tasks|submissions&…` — KPI drill-downs.
- `GET /api/insights-synthesis` / `POST` — School-wide LLM synthesis (leader/admin only). Cached on `schools.insights_cache`.
- `POST /api/insights-card-generate` — Generate one Tier-A LLM card. Body: `{ kind, school_id?, faculty?, course?, class_id?, year_level?, student_id? }`. Kinds:
  - Cohort: `bottom_decile`, `top_decile`, `verb_depth`, `common_gaps`, `things_done_well`
  - Student: `student_top_mistakes`, `student_stretch_goals`, `student_strengths`, `student_summary`
- `GET /api/admin-stats` — Internal admin dashboard data. Gated by `ADMIN_USER_IDS`/`ADMIN_EMAILS`.

### LTI 1.3
- `GET /lti/jwks` — public JWK
- `GET/POST /lti/login` — OIDC initiation
- `POST /lti/launch` — main launch
- `GET/POST /lti/deep-link` — deep linking picker + signed response

## File overview

### `api/`
Feedback: `generate-feedback.ts`, `generate-class-feedback.ts`
Submissions: `submit-for-marking.ts`, `submission-grade.ts`, `task-submissions.ts`, `task-csv.ts`, `task.ts`, `draft-autosave.ts`
Auth: `signup.ts`, `request-password-reset.ts`, `set-role.ts`
Classes + user: `class.ts`, `me.ts`
Insights: `insights-cards.ts`, `insights-student.ts`, `insights-students-search.ts`, `insights-detail.ts`, `insights-synthesis.ts`, `insights-card-generate.ts`
Admin: `admin-stats.ts`
Contact: `contact.ts`
LTI: `api/lti/*` — `jwks.ts`, `login.ts`, `launch.ts`, `deep-link.ts`

### `lib/`
- `auth.ts` — `getSupabase()`, `verifyAuth(req)`
- `cors.ts` — `applyCors()` for api.proofready.app
- `extract-json.ts` — `extractFirstJsonObject(text)` — robustly pulls balanced JSON from a model response
- `generate-inline-suggestions.ts` — Pass 3 implementation
- `rate-limit.ts` — per-user-per-hour + global-per-day caps, logs to `api_call_log`
- `sentry.ts` — Sentry init + `captureError`
- `task-verbs.ts` — NESA directive verb extraction from a question string
- `user-names.ts` — `getUserInfoBatch()` with 30s cache
- `feedback-tools.ts` — Tool schemas for all Claude tool-call endpoints (holistic, criteria, inline, rubric parse, class feedback, school insights, the five Tier-A cohort cards, and the four student-scope cards)
- `anthropic-tool-call.ts` — `callTool<T>()` wrapper
- `insights-filters.ts` — Filter parsing, faculty-scope clamping, year-level helpers
- `schools.ts` — School resolution, scope helpers (`resolveInsightsAccess`, `getOwnedClassIds`, `getInScopeClassIds`, `getInScopeStudentIds`, `getSchoolTeacherIds`, `getSchoolStudentIds`, `canViewInsights`, `listAllAuthUsers`)
- `admin.ts` — `isGlobalAdmin()` — `ADMIN_USER_IDS` first, falls back to `ADMIN_EMAILS`
- LTI: `lib/lti/*` — `config.ts`, `jwt.ts`, `nonce.ts`, `roles.ts`, `user-provision.ts`, `course-provision.ts`, `service-auth.ts`, `nrps.ts`, `ags.ts`

### `prompts/`
- `feedback-system.ts` — Pass 1 system + user prompt
- `inline-suggestions-system.ts` / `inline-suggestions-user.ts` — Pass 3

### `data/`
- `nesa-reference.ts` — GLOSSARY, PERFORMANCE_BANDS, MARKING_PRINCIPLES, SOLO_LEVELS, VERB_DEPTH_MAP, COMMON_PITFALLS, FEEDBACK_PRINCIPLES
- `nesa-courses.ts` — HSC course list + `getDisciplineForCourse()` mapping
- `subject-glossaries.ts` — 13 subject-specific terminology banks
- `marker-voice-loader.ts` — Reads NESA Notes JSON → calibration block
- `nesa-marking-feedback/*.json` — Scraped NESA Notes 2021–2024 by subject
- `pdhpe-stage6.ts`, `hms-stage6.ts` — Detailed syllabus outcomes

### `public/`
Auth + onboarding: `index.html`, `auth.html`, `choose-role.html`, `forgot-password.html`, `reset.html`
Student: `student.html`, `class-view.html`, `submit.html`, `feedback.html`, `my-results.html`
Teacher: `teacher.html`, `new-class.html`, `class-detail.html`, `new-task.html`, `task-detail.html`, `mark-submission.html`, `teacher-markbook.html`
Insights: `insights.html` (single page — handles cohort + student modes, all three tiers)
Admin: `admin.html`
Policy: `compliance.html`, `privacy.html`, `terms.html`, `contact.html`
Shared JS: `js/app.js` (Supabase client, `authFetch`, `requireAuth`, `apiUrl`, Sentry init), `js/rubric.js` (rubric parser/renderer — pipe-table, band-style, criterion-list, letter-band, multi-part HSC, flattened-table; modes `display` / `mark-entry` / `graded`), `js/nesa-courses.js` (course autocomplete), `js/contact-modal.js`

### `scripts/`
- SQL migrations: `classes-migration.sql`, `class-feedback-migration.sql`, `rls-policies.sql`, `scale-indexes.sql`, `lti-migration.sql`, `typed-response-only-migration.sql`, `teacher-marking-migration.sql`, `submit-for-marking-migration.sql`, `insights-cards-cache.sql`
- One-offs: `backfill-inline-suggestions.ts`, `scrape-nesa-feedback.ts`, `generate-lti-keypair.ts`
- Smoke tests: `lti-smoke-test.ts`, `insights-teacher-smoke-test.ts`, `insights-student-smoke-test.ts`

### Config
- `vercel.json` — `maxDuration: 300` (Pro plan), rewrites `/lti/*` → `/api/lti/*`
- `tsconfig.json` — NodeNext modules to match Vercel runtime
- `package.json` — `@anthropic-ai/sdk`, `@supabase/supabase-js`, `@sentry/node`, `@vercel/node`, `jose`

## Env vars

- `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service_role)
- `SENTRY_DSN` — optional; observability no-ops without it
- `ADMIN_USER_IDS` — comma-separated UUIDs (preferred over `ADMIN_EMAILS` for safety against email-squat during signup)
- `ADMIN_EMAILS` — legacy fallback
- `LTI_PRIVATE_KEY` — RSA-2048 PEM. Newlines as `\n` if one-line, multi-line if pasted in Vercel
- `LTI_KEY_ID` — UUID kid for the public JWK
- `SITE_ORIGIN` — frontend origin for LTI redirects (defaults to `https://proofready.app`)

## Key design decisions

- **No mark/band predictions, ever.** Hard-coded prompt rules. The tool refuses to estimate marks even when asked.
- **No content rewriting.** Feedback says what to fix and why, not how. Hard-coded.
- **3-draft cap per task** to prevent dependence on AI feedback and limit cost.
- **Three parallel passes** so wall-clock = max(pass1, pass2, pass3) not sum. Pass 1 is load-bearing; Passes 2 + 3 are best-effort.
- **Subject-specific calibration.** NESA Notes from the Marking Centre 2021–2024 indexed in `data/nesa-marking-feedback/*.json` + subject glossaries in `data/subject-glossaries.ts` injected into Pass 1.
- **Typed-response-only as default** (`typed_response_only` = true). Paste/drop blocked, mobile warned off, autosave + telemetry. Designed so a draft submitted to ProofReady is actually the student's own typing.
- **api.proofready.app subdomain** is Cloudflare DNS-only, not orange-cloud. Cloudflare's 100s edge proxy timeout would kill long Anthropic calls; bypassing it gives us Vercel's full 300s on Pro.
- **Insights student-name policy.** School-wide and cohort prompts forbid naming students ("aggregate only"). Student-scope prompts (`student_*` kinds) explicitly allow naming — the teacher is already authorised to see this student. The no-mark/no-band rule still applies.

## Known issues / gotchas

- **Google OAuth doesn't work in Expo Go** — N/A for ProofReady (web only). Mentioned only because the same person also runs Citrafort.
- **`insights-synthesis.ts` has three pre-existing TS errors** (`schoolId: string | null` passed to functions expecting `string`). Pre-dates the insights tier overhaul. Functionally fine — the null path is guarded earlier — but worth fixing eventually.
- **`school_insights_cards` table is keyed by `(school_id, card_kind)`** — teachers' class-scope generations would collide if cached there, which is why the teacher tier bypasses the cache.
- **Surname parsing is naive** — last whitespace-separated token. Doesn't handle compound surnames ("Van Der Berg") gracefully in the ranking heuristic. The search still works (substring match catches it); only the ranking boost might miss.
- **Faculty-restricted leaders cannot widen scope by passing a foreign faculty in the URL.** `applyFacultyScope` clamps the filter to allowed faculties; a request for a faculty outside the grant returns no data (not a 403, because empty is a useful UI signal).
- **Teachers without a school context** (no LTI, no email-domain match, no `school_members` row) still get insights. Their `schoolId` resolves empty; class-scope works, but they don't share a cohort with anyone.

## Sister projects (different Supabase, different repos)

- **Citrafort** — household finance app. Mobile (Expo) + web (Next.js). Supabase ref `kjueriejebawtccuqxid`. Repo `robsheahan/citrafort`. Path `/Users/rob/citrafort`.
- **Recommndr**, **Lexis**, **Equivise** — separate apps, separate repos, separate Supabase projects (when they have them).

Don't cross-reference these in ProofReady work.
