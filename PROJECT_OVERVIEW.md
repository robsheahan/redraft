# ProofReady — Project Overview

A NESA-aligned formative-feedback tool for NSW HSC student drafts. Teachers create classes and tasks, students submit drafts, AI returns criteria-anchored feedback in the voice of an experienced HSC marker.

## Stack

- **Hosting:** Vercel (Pro plan, 300s function timeout). Production routes `/api/*` through `api.proofready.app` (Cloudflare DNS-only, bypasses Cloudflare's 100s edge proxy timeout).
- **Frontend:** Vanilla JS + HTML in `public/`. No framework, no build step. Supabase JS SDK loaded from CDN.
- **Backend:** TypeScript serverless handlers in `api/` using `@vercel/node`.
- **Database / auth:** Supabase (Sydney region, project ref `jcxcbqsxshlwwvxlyyfd`).
- **AI:** Anthropic Claude Sonnet 4.6 via `@anthropic-ai/sdk`. Three parallel passes per submission.
- **Email:** Resend (outbound, custom proofready.app domain). Cloudflare Email Routing (inbound help@).
- **Auth providers:** Supabase email/password + Google OAuth.
- **Observability:** Sentry (browser + Node.js projects).

## Data model (Supabase)

- `auth.users` — Supabase auth, plus `user_metadata.role` ∈ {teacher, student}, `display_name`.
- `classes` — `id`, `code` (6-char join code), `teacher_id`, `name`, `course`, `created_at`.
- `class_members` — `class_id`, `student_id`, `joined_at`. Composite PK.
- `tasks` — `id`, `class_id`, `title`, `question`, `course`, `task_type`, `total_marks`, `due_date`, `outcomes` (jsonb), `criteria` (jsonb), `criteria_text`, `notes`, `published_at`, `created_at`, plus `class_feedback`, `class_feedback_count`, `class_feedback_generated_at` for cached class-level synthesis.
- `submissions` — `id`, `student_id`, `task_id`, `question`, `course`, `draft_text`, `feedback` (jsonb), `draft_version`, `created_at`. Capped at 3 drafts per student per task.
- `api_call_log` — rate-limit + spend tracking. `user_id`, `endpoint`, `created_at`.

## Key decisions

- **Three parallel passes** in `api/generate-feedback.ts` via `Promise.allSettled`: holistic (Pass 1, load-bearing), criterion-by-criterion (Pass 2, skipped if no criteria), inline annotations on student quotes (Pass 3). Wall-clock = max instead of sum.
- **Subject-specific calibration**: NESA Notes from the Marking Centre 2021–2024 indexed in `data/nesa-marking-feedback/*.json`, plus subject glossaries in `data/subject-glossaries.ts` injected into Pass 1 system prompt.
- **No mark/band predictions ever** — hard-coded prompt rules. The tool refuses to estimate marks.
- **No content rewriting** — feedback says what to fix and why, not how. Hard-coded.
- **3-draft cap per task** to prevent dependence and limit cost.
- **CSV export** for teachers via `api/task-csv.ts`.

---

## File overview

### `api/` — Vercel serverless handlers

- **`generate-feedback.ts`** — Main feedback endpoint. Three parallel Anthropic calls. Auth-required. Rate-limited (10/hr per user, 5000/day global). Saves to `submissions`. Skips Pass 2 if no marking criteria provided.
- **`generate-class-feedback.ts`** — Teacher-only synthesis across a class's submissions. Reads latest submission per student, asks Claude to identify common strengths, gaps, top priorities. Persists to `tasks.class_feedback`. Rate-limited (5/hr per user, 500/day global).
- **`task.ts`** — CRUD for tasks. GET (read), POST (create), PUT (update), DELETE. Authorisation: only the class's teacher can mutate.
- **`task-submissions.ts`** — Teacher view of all submissions for one task. Returns task + submissions array enriched with student names.
- **`task-csv.ts`** — Streams a CSV of submissions for a task.
- **`class.ts`** — Class CRUD plus join-by-code for students.
- **`me.ts`** — Returns the current user's profile + role + classes.
- **`signup.ts`** — Custom signup that lets us set `display_name` and avoid Supabase's email-confirmation flow.
- **`request-password-reset.ts`** — Sends a Resend-powered reset email with our own template.
- **`set-role.ts`** — Sets `user_metadata.role` after the user picks teacher/student.
- **`contact.ts`** — Receives contact-form posts and forwards to help@proofready.app.
- **`admin-stats.ts`** — Admin-only dashboard data: counts, recent activity, full user roster, sign-ups by email domain. Gated by `ADMIN_EMAILS` env var.

### `lib/` — server-side helpers

- **`auth.ts`** — `getSupabase()` (service-role client), `verifyAuth(req)` (validates Bearer token, returns user).
- **`cors.ts`** — `applyCors()` for the cross-origin api.proofready.app subdomain. Returns true on OPTIONS preflight.
- **`extract-json.ts`** — `extractFirstJsonObject(text)` — robustly pulls the first balanced JSON object from a model response.
- **`generate-inline-suggestions.ts`** — Pass 3 implementation. Returns annotations anchored to verbatim quote substrings of the draft. Validates each annotation's quote actually appears in the draft.
- **`rate-limit.ts`** — `checkAndLogRateLimit()` — per-user-per-hour and global-per-day caps, logs into `api_call_log`.
- **`sentry.ts`** — Sentry init + `captureError(err, context)` helper. No-op when `SENTRY_DSN` is unset.
- **`task-verbs.ts`** — Extracts NESA directive verbs ("analyse", "evaluate" etc.) from a question string. Used to anchor verb-depth checks in feedback.
- **`user-names.ts`** — `getUserInfoBatch()` — batched listUsers lookup with 30s cache. Avoids per-row auth calls.

### `prompts/` — system & user prompt builders

- **`feedback-system.ts`** — Pass 1 system + user prompt. Injects NESA glossary, performance bands, marking principles, SOLO taxonomy, verb-depth map, common pitfalls, discipline-specific persona, marker-voice reference (NESA Notes), subject-specific terminology. Strict no-band/no-rewrite rules.
- **`inline-suggestions-system.ts`** — Pass 3 system prompt. Tells the model to attach comments to verbatim quotes from the student's draft, like a teacher's pen marks.
- **`inline-suggestions-user.ts`** — Pass 3 user prompt builder.

### `data/` — reference data

- **`nesa-reference.ts`** — `GLOSSARY` (NESA key-word definitions), `PERFORMANCE_BANDS` (band 1–6 descriptors), `MARKING_PRINCIPLES`, `SOLO_LEVELS`, `VERB_DEPTH_MAP` (Bloom-level depth per verb), `COMMON_PITFALLS`, `FEEDBACK_PRINCIPLES`.
- **`nesa-courses.ts`** — Full HSC course list with `getDisciplineForCourse()` mapping (e.g. "Modern History" → "HSIE").
- **`subject-glossaries.ts`** — 13 subject-specific terminology banks ({term, definition, watchFor}). Injected into Pass 1 system prompt for the matching subject.
- **`marker-voice-loader.ts`** — `buildMarkerVoiceReference()` — reads relevant year/course JSON from `nesa-marking-feedback/`, formats as a calibration block.
- **`nesa-marking-feedback/*.json`** — Scraped NESA Notes from the Marking Centre 2021–2024, by subject. Used as marker-voice calibration.
- **`pdhpe-stage6.ts`** / **`hms-stage6.ts`** — Detailed syllabus outcome lists for these courses.

### `public/` — static frontend

- **`index.html`** — Marketing landing page, role-pick CTA.
- **`auth.html`** — Login (email + password + Google OAuth). Routes by role after success.
- **`choose-role.html`** — First-login role picker (teacher vs student).
- **`forgot-password.html`** / **`reset.html`** — Custom password reset flow (uses Resend, not Supabase's default).
- **`student.html`** — Student home: lists classes, tasks, recent feedback. Sorted alphabetically.
- **`teacher.html`** — Teacher home: classes (alphabetical), recent tasks across classes.
- **`new-class.html`** — Teacher creates a class. Auto-generates 6-char join code.
- **`class-detail.html`** — Teacher view of a class: students, tasks, share-code panel.
- **`class-view.html`** — Student view of a class: tasks they can submit to.
- **`new-task.html`** — Teacher composes a task: question, criteria, outcomes, save-as-draft or save-and-publish. Has a Cancel button.
- **`task-detail.html`** — Teacher view of one task: submissions list, generate/regenerate class feedback (persisted), CSV export. Class feedback re-renders on page load if cached.
- **`submit.html`** — Student submission page: shows task + criteria, draft textarea, draft-progress banner, 3-draft cap state. Loading overlay with rotating messages.
- **`feedback.html`** — Renders one submission's feedback (holistic + criteria + inline annotations on the draft).
- **`admin.html`** — Internal admin dashboard. Sign-ups by email domain (per-school uptake), full user roster, recent submissions/tasks.
- **`compliance.html`** / **`privacy.html`** / **`terms.html`** / **`contact.html`** — Standard policy pages.
- **`js/app.js`** — Shared frontend helpers: Supabase client, `authFetch`, `requireAuth`, `apiUrl` (routes via api.proofready.app in production), Sentry browser SDK init.
- **`js/rubric.js`** — Rubric parser/renderer. Handles pipe-table, band-style, criterion-list, letter-band, multi-part HSC, and flattened-table formats.
- **`js/nesa-courses.js`** — Course autocomplete for the new-task form.
- **`js/contact-modal.js`** — Shared contact-modal trigger.

### `pitch/` — sales / pilot collateral

- **`handout.html`** — One-page printable handout for school leadership pitches.
- **`qa.html`** — Q&A briefing for deputies / heads of teaching & learning.

### `scripts/` — one-off SQL & maintenance

- **`classes-migration.sql`** — Initial classes redesign migration (creates `classes`, `class_members`; switches `tasks` to `class_id`).
- **`class-feedback-migration.sql`** — Adds `class_feedback`, `class_feedback_count`, `class_feedback_generated_at` columns to `tasks`.
- **`rls-policies.sql`** — Row-level security policies on all tables.
- **`scale-indexes.sql`** — Indexes added for pilot-scale read performance.
- **`backfill-inline-suggestions.ts`** — One-off: regenerate Pass 3 annotations for old submissions that predate Pass 3.
- **`scrape-nesa-feedback.ts`** — One-off: scrapes NESA Notes from the Marking Centre into the JSON files.

### `test/` — local QA harnesses (not CI)

- **`evaluate-sample.ts`** — Runs feedback generation on a sample draft for manual quality review.
- **`test-inline-suggestions.ts`** — Tests Pass 3 in isolation.

### Config

- **`vercel.json`** — Sets `maxDuration: 300` on serverless functions (Pro plan).
- **`tsconfig.json`** — TypeScript config (NodeNext modules to match Vercel runtime).
- **`package.json`** — `@anthropic-ai/sdk`, `@supabase/supabase-js`, `@sentry/node`, `@vercel/node`.

### Docs

- **`docs/nesa-permission-request.md`** — Draft of permission request to NESA for use of marking-centre material.
