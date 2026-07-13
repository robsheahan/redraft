# ProofReady — Project Overview

A NESA-aligned formative-feedback tool for NSW student drafts, covering both written-response subjects and Mathematics across Years 7–12. Teachers create classes and tasks, students submit drafts, and ProofReady returns criteria-anchored feedback in the voice of an experienced marker. Every submission is also scored against the **ProofReady skill taxonomy** and folded into a per-student skill database — the asset the longitudinal profile, insights, and the **Lesson Differentiator** all read from. (Public copy never calls this "AI feedback" — the branding leans on the NESA-calibrated quality, not the mechanism; legal/compliance pages still disclose AI use.) Built by Rob Sheahan (a NSW PDHPE teacher) and shipped as a Canvas LTI 1.3 pilot starting with Penrith Christian School. Repo: `robsheahan/redraft`. Domain: `proofready.app`.

## Central design question

Every build decision is evaluated against one question:

> **"How can we get the most accurate possible feedback to mimic that of a professional, experienced teacher?"**

Concretely: no mark/band predictions, no content rewriting, marker-voice prompts calibrated against NESA Notes from the Marking Centre 2021–2024, multi-pass feedback (essay: holistic + criterion-by-criterion + inline annotations; maths: per-line diagnostic + holistic), strict subject-aware glossary and verb-depth checks — and every submission feeds a per-student skill profile so the picture compounds over time.

## Stack

- **Hosting:** Vercel (Pro plan, 300s function timeout), functions pinned to **Sydney** (`"regions": ["syd1"]` in vercel.json — same region as Supabase; the default was US East, which put ~200ms of Pacific round-trip inside every DB query). Production routes `/api/*` through `api.proofready.app` (Cloudflare DNS-only — bypasses Cloudflare's 100s edge proxy timeout).
- **Frontend:** Vanilla JS + HTML in `public/`. No framework, no build step. Supabase JS SDK loaded from CDN.
- **Backend:** TypeScript serverless handlers in `api/` using `@vercel/node`.
- **Database / auth:** Supabase (Sydney region, project ref `jcxcbqsxshlwwvxlyyfd`). NOT to be confused with Citrafort's separate Supabase project (`kjueriejebawtccuqxid`) — different app.
- **AI:** Anthropic via `@anthropic-ai/sdk`. Claude Sonnet 5 for student-facing feedback (essay three-pass + maths two-pass), insights cards, and longitudinal profile synthesis; Claude Haiku 4.5 for the silent insights-signals pass on marked/quick tasks (~$0.004 per call) and the maths freeform/talk-through structuring pass. All endpoints use tool-call schemas for structured output via `lib/anthropic-tool-call.ts` (`callTool`). **Prompt caching** (`cacheSystem` flag on `callTool`) caches the large static system prompts as `cache_control: ephemeral` blocks — a classroom burst on one task pays one cache write then ~10× cheaper reads. `callTool` logs per-call token usage (`[usage] …` incl. cache hit-rate) for cost visibility.
- **Email:** Resend (outbound, custom proofready.app domain) for contact + **password-reset** mail (reset uses `admin.generateLink` + Resend, not Supabase's rate-limited default email). Cloudflare Email Routing for inbound `help@`.
- **File storage:** Supabase Storage, one **private** bucket `attachments`. Teachers attach photos/PDFs to a task; students may attach them to a submission **only when the task's `allow_student_attachments` toggle is on** (default off). Nothing is done with the files — stored and shown only. `api/attachment.ts` mints signed upload URLs (client uploads direct to Storage, bypassing the function-body limit) and short-lived signed download URLs after authorising the caller; the bucket has no Storage RLS (service role reads, signed-upload tokens write). Limits: images + PDF, ≤10MB each, ≤5 files.
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
- `tasks` — `id`, `class_id`, `title`, `question`, `course`, `task_type`, `subject_type` (text, `essay` default or `maths` — drives the maths flow + UI), `task_mode` (text, default `feedback_task`; CHECK ∈ {`feedback_task`, `marked_task`, `quick_task`}), `completion_only` (boolean, default false — quick_task only), `total_marks`, `due_date`, `outcomes` (jsonb), `criteria` (jsonb), `criteria_text`, `marking_guideline` (text — optional maths marking guide), `worked_solution` (text — optional maths-only hidden correctness anchor for the per-line diagnostic; never sent to students — stripped for all non-owners in `api/task.ts`), `parts` (jsonb, nullable — multi-part maths take-home: ordered sub-questions `[{id,label,text,marks?,marking_guideline?,worked_solution?}]`; `question` holds the shared stem; per-part guideline/solution stripped from students by `studentPartsView` in `lib/maths-parts.ts`), `hide_criteria_from_students` (boolean — exam-style: criteria hidden until graded), `notes`, `published_at`, `created_at`, `class_feedback` + `class_feedback_count` + `class_feedback_generated_at` (cached class-level synthesis), `typed_response_only` (boolean, default true), `lesson_builder` (boolean, default false — task published via the **Lesson Differentiator** differentiation flow). `teacher_attachments` (jsonb, default `[]` — accompanying-material file metadata `[{path,name,content_type,size}]`, shown to students). `time_limit_minutes` (int, nullable — in-class exam only; shown to students, not enforced). `allow_student_attachments` (boolean, default false — when on, students get an "Attach file" button on their submission; off = no student uploader). LTI columns: `lti_platform_id`, `lti_resource_link_id`, `lti_line_item_url`, `lti_ags_lineitems_url`.
- `submissions` — `id`, `student_id`, `task_id`, `question`, `course`, `draft_text`, `feedback` (jsonb), `working_lines` (jsonb — maths single-question: ordered `{math}` lines), `part_working` (jsonb, nullable — multi-part maths: `[{part_id, working_lines:[{math}], input_mode}]`), `input_mode` (maths: structured/freeform/talkthrough), `skill_assessment` (jsonb — per-dimension developmental read captured at feedback time; system/teacher data, never in the student payload), `draft_version`, `created_at`. **Own-task** (student self-created) columns: `own_task_id` (stable id grouping a student's drafts of one self-made task), `own_task_title`, `own_task_class_id` (optional, private to the student — for their own sorting only), `own_task_criteria_text`. Capped at 3 drafts per student per task on `feedback_task` **and per `own_task_id`**; single submission on `marked_task` / `quick_task`. Typing telemetry: `keystroke_count`, `paste_attempts_blocked`, `typing_session_count`, `total_typing_time_ms`, `time_to_first_keystroke_ms`. Teacher grading: `criterion_marks` (jsonb), `total_mark`, `teacher_comment`, `teacher_annotations` (jsonb — array of `{quote, comment, category, start, end}` with categories `praise`/`improve`/`note`), `completion_status` (text, only `'completed'` or null — set when a quick_task is marked "complete" without a numeric mark), `graded_at`, `graded_by`. Final-submission flag: `submitted_for_marking` (boolean). `student_attachments` (jsonb, default `[]` — file metadata `[{path,name,content_type,size}]` the student attached; shown to the marking teacher and back to the student). `over_time_cutoff_index` (int, nullable — in-class exam: the boundary where after-time work begins; a char index for essays, a line index for maths; null if no limit / the deadline was never reached).
- `draft_autosaves` — `student_id`, `task_id`, `draft_text`, `telemetry` (jsonb), `updated_at`. Composite PK. Persistent in-progress drafts. Cleared on successful submission.
- `api_call_log` — rate-limit + spend tracking. `user_id`, `endpoint`, `created_at`.
- `schools` — `id`, `name`, `primary_domain`, `secondary_domains` (text[]), `insights_cache` (jsonb), `insights_cache_task_count`, `insights_cache_generated_at`.
- `school_members` — `school_id`, `user_id`, `role` ∈ {`admin`, `leader`}, `faculties` (text[], leaders only).
- `school_insights_cards` — leader/admin cohort-card LLM cache. PK `(school_id, card_kind, scope_key)` — scope-keyed so an English HOD, an HSIE HOD and an executive each keep their own card instead of overwriting one slot. Carries `fingerprint` (in-scope corpus signature) for freshness. Student-kind cards are NOT cached here.
- `teacher_insights_cards` — teacher-tier cohort-card cache, PK `(teacher_id, card_kind, scope_key)` + `fingerprint`. Teacher cards are class-scoped so they get their own per-teacher cache rather than the school-keyed one.
- `student_profile_synthesis` — one row per student. Cached longitudinal academic profile (LLM-synthesised narrative + headline strength/priority + metrics jsonb including improvement_themes, strength_themes, mark_trend, profile_status ∈ {`established`, `developing`, `new`}), `submission_count_at_generation`, `stale` (boolean). Marked **stale** (not deleted) on any grading / feedback / marked-quick submission; the read path regenerates when there are new submissions or a stale row is past the refresh window, else serves last-known-good (so the class summary keeps usable data). Contains no draft quotes — safe to surface to any current teacher.
- `student_skill_profile` — the skill database rollup (SNAPSHOT). PK `(student_id, discipline, dimension)`; recency/confidence-weighted `level` (1–5) + `level_label`, `confidence` (0–1, grows with `observation_count`), `trend`, `signal` (latest actionable note), `taxonomy_version`. Written from every submission's `skill_assessment` via `lib/skill-profile.ts`. See **Skill taxonomy** below.
- `skill_observations` — the skill database HISTORY (append-only event log). One row per `(submission_id, dimension)`: the OBSERVED `level` (1–5) for that submission, `level_label`, `confidence`, `evidence_weight`, `discipline`, `family` (writing/maths), `observed_at`, `taxonomy_version`. Unique `(submission_id, dimension)` makes writes + backfill idempotent; `on delete cascade` from `submissions`. Written alongside the rollup by `recordSkillObservations` (best-effort). Read by the cohort skill-growth card (`computeSkillGrowth`, within-student deltas over time).
- `task_activities` — **Lesson Differentiator** per-student differentiated activity. PK `(task_id, student_id)`; `activity` (jsonb — `{student_focus, scaffolding[], extension}` for writing; `{question, difficulty, student_focus, scaffolding[]}` for a maths re-skin), `is_differentiated` (boolean — false = student got the main activity unchanged, no LLM call), `source_submission_count`, `taxonomy_version`, `generated_at`. Generated lazily on first open and locked thereafter.
- `lti_platforms` — one row per Canvas instance (issuer, client_id, deployment_id, hostname, JWKS + auth URLs, school_name, school_id).
- `lti_nonces` — short-lived OIDC handshake nonces.
- `lti_user_mappings` — Canvas user_id ↔ auth.users.id, per platform.
- `lti_course_mappings` — Canvas course_id ↔ classes.id, per platform.
- `lti_dl_sessions` — short-lived deep-linking sessions.

## Task modes

Every task is one of three modes (stored in `tasks.task_mode`). The new-task UI exposes **Quick task** and **Assessment task**; choosing Assessment task reveals two sub-types — **Take-home assessment** (→ `feedback_task`) and **In-class exam** (→ `marked_task`).

- **`feedback_task`** — "Take-home assessment". Three-pass Sonnet feedback shown to the student. Requires criteria. Up to 3 drafts per student. Counts toward mark distribution once graded. May be **single-question** (the default — instructions-as-question + task-level criteria) or **multi-question** (a `questions` array, each with its own marks + optional criteria, per-question feedback scaled to marks — see **Multi-question take-home feedback**).
- **`marked_task`** — "In-class exam". Silent Haiku insights pass at submit time; student sees no feedback. Single submission (submit-for-marking only). No criteria by default. Goes into the mark distribution. Supports an optional `time_limit_minutes` (shown to students, not enforced). **Over-time marking:** the student's timer starts on first keystroke (persisted in autosave telemetry so it survives a reopen); a live countdown shows on the submit page, and the draft/working state at the deadline is captured. At submit, the client computes `over_time_cutoff_index` (essay: common-prefix char index of the deadline snapshot vs final draft; maths: line count at the deadline) — the marking screens (`mark-submission.html` / `mark-submission-maths.html`) render everything past it in a distinct format with a "time limit reached" divider. Now produced by `task.ts` again (via the In-class exam sub-type).
- **`quick_task`** — silent Haiku insights pass at submit time; student sees no feedback. Single submission. No criteria. **Does NOT contribute to mark distribution** (cohort mark cards ignore it by design). Feeds the LLM cohort cards and student profiles. Teacher can mark it with a number, or "mark as complete" (`completion_only` task flag → `submissions.completion_status = 'completed'`).

Both no-feedback modes (`marked_task`, `quick_task`) submit through `/api/submit-for-marking`, which accepts either an essay `draft` or maths `working_lines` (serialised into `draft_text`; `working_lines` + `input_mode` stored on the submission) — so a maths in-class exam works the same as an essay one.

The silent Haiku pass lives in `lib/insights-signals-feedback.ts`. It writes a shape that matches the relevant subset of the holistic-feedback tool, so existing cohort cards and the student profile synthesis consume it with no branching.

## Core flows

### Teacher onboarding
1. Sign up email/password OR Google OAuth OR Canvas LTI launch.
2. First login → `choose-role.html` → picks `teacher` or `student`.
3. Lands on `teacher.html` (or `student.html`).

### Class + task lifecycle
1. Teacher creates a class on `new-class.html` (auto-generates 6-char join code).
2. Composes a task on `new-task.html` — picks **Quick task** (quick_task; criteria optional, number-marked or completion-only) or **Assessment task**, which splits into **Take-home assessment** (feedback_task; criteria + live feedback) or **In-class exam** (marked_task; no criteria, submit-for-marking only, optional time limit). Sets question, outcomes, total marks, due date. `typed_response_only` toggle defaults ON.
3. Saves as draft OR publishes. Students see only published tasks.
4. Shares the join code (or, for LTI-linked classes, students auto-enrol via NRPS on teacher launch).

### Student submission
1. Joins a class with the code on `student.html`, or auto-enrolled via LTI.
2. Opens `submit.html` for a task.
3. Writes draft in the textarea. When `typed_response_only`: paste/drop blocked with a toast, mobile screens show "open on laptop" guard, autosaves every ~1.5s to `draft_autosaves`, typing telemetry captured.
4. Submit paths depend on task mode:
   - **`feedback_task`** — "Get feedback" runs `/api/generate-feedback` (three Sonnet passes; counts toward 3-draft cap), or "Submit for marking" runs `/api/submit-for-marking` (no AI call, locks the task).
   - **`marked_task` / `quick_task`** — only "Submit for marking" is offered. `/api/submit-for-marking` runs the silent Haiku insights pass (`generateInsightsSignals`) and writes the structured output to `submissions.feedback` for downstream insights — but the UI never surfaces it to the student.
5. Locked state shows once any submission has `graded_at` OR `submitted_for_marking = true`.

### Own tasks (student self-created)
Students can also create their own practice task from `student.html` ("Enter my own task"): a required **title**, an optional **class** tag (private to them — sorting only), course, question, criteria, then a draft. These run the same `/api/generate-feedback` path with no `task_id` (a client-generated `own_task_id` instead), so they get the full three-pass feedback. Re-openable **3-draft model** grouped by `own_task_id`; "Your own tasks" cards show class/course + X/3 drafts and re-open prefilled. **Daily caps are by distinct tasks *started*** (draft-1 rows in the last 24h): **3 own tasks + 5 class tasks per student per day** (drafts 2–3 of an already-started task don't count), plus 10/hr per user + 5000/day global. Own-task submissions feed the skill database + longitudinal profile like any other, labelled "(own task)" in the synthesis.

### Three-pass AI feedback — feedback_task only (`api/generate-feedback.ts`)
Three parallel Anthropic calls via `Promise.allSettled`. Wall-clock = max(pass1, pass2, pass3), not sum.

- **Pass 1 — Holistic** (`prompts/feedback-system.ts`): load-bearing. Builds a system prompt injecting NESA glossary, performance bands, marking principles, SOLO taxonomy, verb-depth map, common pitfalls, discipline-specific persona, marker-voice reference (NESA Notes), subject-specific terminology. Strict no-band/no-rewrite rules. Returns `improvements`, `what_youve_done_well`, `top_priority`, `task_verb_check`.
- **Pass 2 — Criterion-by-criterion**: skipped if no criteria provided. Per-criterion verdict + recommendation.
- **Pass 3 — Inline annotations** (`lib/generate-inline-suggestions.ts`): returns annotations anchored to verbatim quote substrings of the draft (the model is told to mark up like a teacher's pen). Each annotation's quote is validated to exist in the draft.

Pass 1's holistic tool also returns a `skill_assessment` (pulled out server-side, never shown to the student — see **Skill taxonomy**). Rate-limited 10/hr per user, 5000/day global. Generation marks the student's `student_profile_synthesis` stale and folds skill signals into `student_skill_profile`.

### Multi-question take-home feedback — feedback_task, essay (`api/generate-multi-feedback.ts`)
A take-home assessment (`feedback_task`, `subject_type='essay'`) may carry a `questions` array (the same `tasks.questions` jsonb column the exam flow uses, but the **take-home variant** validated by `lib/feedback-questions.ts` — `validateFeedbackQuestions`, 1–8 questions, **written or multiple-choice**: `{id, type:'text'|'multiple_choice', text, marks, criteria_text?, options?, correct_option_id?, attachments}`). Written questions carry optional per-question criteria (shown to the student); MC carries a hidden `correct_option_id` (stripped from students pre-grading by `studentTaskView`, revealed in the per-question feedback). `api/task.ts` routes `questions` to the exam vs feedback validator by `task_mode`; per-question criteria relax the task-level criteria requirement. **No migration** — reuses `tasks.questions`, `submissions.answers` + `question_marks`, `draft_autosaves.answers`.

The student answers each question (scrolling cards on `submit.html`, reusing the exam answer/autosave plumbing) and gets **per-question feedback whose depth scales to the question's marks** (`lib/multi-question-feedback.ts`):
- **Multiple choice**: marked deterministically (no LLM) — `correct_option_id` comparison — and the feedback reveals right/wrong **plus the correct answer** (formative; the take-home loop is for learning, "submit for marking" is the summative gate). MC contributes no skill signal.
- **Short answer** (marks < `EXTENDED_RESPONSE_MIN_MARKS`, default 7): one concise **Sonnet** pass — warm + student-facing (`prompts/multi-question-feedback-system.ts`), via a lightweight `SHORT_ANSWER_FEEDBACK_TOOL` (no inline annotations, no skill capture). (Originally Haiku, but it intermittently dropped required fields even on the lightweight tool — Sonnet is reliable and one small call is still ~10× cheaper than the extended path.)
- **Extended response** (marks ≥ threshold): the full **Sonnet three-pass** (holistic + criterion-by-criterion *if* the question carries criteria + inline), scoped to that answer.

Questions run in parallel (`Promise.all`); a per-question failure soft-fails (`ok:false`) without sinking the submission. Feedback is stored as `submissions.feedback = { kind:'multi_question', questions:[…] }` (mirroring `maths_multipart`). The per-question `skill_assessment`s are **aggregated per dimension** into one signal before a single `recordSkillSignals` call — `aggregateSkillAssessments` (avoids the duplicate-`(student,dimension)` upsert the maths raw-concat risks). One rate-limit charge + one 3-draft cap per submission; the usual side-effects (profile-stale, autosave-clear, AGS). v1: questions are independent (no cross-question "Hence" context) and outcomes are task-level. Questions (written + MC) are authored at creation (`new-task.html`) **and edited in place** on the task page (`task-detail.html`), subject to the uniform lock below. "Submit for marking" routes `answers[]` through `submit-for-marking` (stores + locks, **no** silent pass — that's gated to marked/quick); the exam marking + graded screens are reused via `submission.answers`. Student feedback renders per-question on `feedback.html` (`renderMultiQuestionFeedback`).

### Editing tasks & the uniform lock (`api/task.ts`, `task-detail.html`)
**Every** task — single- or multi-question, any mode — is fully editable until the **first student starts**, then its content locks. "Started" = the task has any **submission OR in-progress autosaved draft** (`task.ts handleUpdate` counts both; `task-submissions.ts` returns a `started` flag for the UI). Before that, the Edit screen is the full editor (incl. the in-place question editor for multi-question take-homes); after, it's a limited panel where only **title, due date, and the teacher's private notes** stay editable — everything students answer against (question(s), criteria, marks, options/answer keys, etc.) is frozen, because submitted answers anchor to question ids. `handleUpdate` enforces this server-side (rejects question-set changes once started; strips any non-allowed field from the patch). This replaced the old patchwork (exams locked on publish; single-question never locked; multi-question on first submission).

### Feedback register + volume calibration
Feedback is calibrated to the **reader**, not just the answer — driven by the student's **stage / year level** and the answer's **demonstrated level**, never a band (so no-mark-prediction holds; altitude is deliberately never given).
- **Register**: plain language pitched to the actual year level (the holistic prompt previously hardcoded "Year 12"). Teacher/marking jargon is banned with plain rewrites — "say WHY that happens, step by step" not "show the cause-and-effect chain"; "add a real example" not "ground your explanation". The thinner the answer, the plainer the register.
- **Volume**: fewer, blunter steps for weaker/younger answers — Stage 4–5 leads with the 2–3 highest-leverage changes (the short pass gives one for a thin answer); HSC stays thorough but prioritised. Stops a struggling student being handed a checklist they won't action.
- Lives in `prompts/feedback-system.ts` (holistic / single-question, stage-aware via `yearLevel`) and `prompts/multi-question-feedback-system.ts` (short pass). Sits alongside the **graduated support prompts** (reminder/scaffold/example by skill profile) — support *depth* and *register/volume* are separate dials. Validated with `npm run calibrate-feedback` (see `test/`).

### Maths feedback — subject_type `maths` (`api/generate-maths-feedback.ts`)
Students enter working as ordered `{math}` lines on `submit-maths.html` (MathLive editors). Input modes: **line-by-line** (per-line MathLive), **freeform**, **talk-through** (the latter two run a Haiku structuring pass, `api/structure-maths-working.ts`), and **📷 photo** (snap handwritten working → Claude Sonnet vision transcription, `api/transcribe-maths-working.ts`, client-downscaled → the same confirm screen → diagnose; single-question only in v1). Multi-part `(a)(b)(c)` questions (`tasks.parts`, "Hence"-aware) run the per-part flow — each part is diagnosed separately with earlier parts as context. Two Sonnet passes per question/part (sequential — Pass C consumes Pass B):
- **Pass B — per-line diagnostic** (load-bearing): per-line typed status (ok / slip / error / following-through) + `step_gaps` between lines. Runs as a **tool-use loop**: the model can call a deterministic `check_equivalence` tool (`lib/maths-verify.ts` — a dependency-free numeric engine that verifies polynomial/rational algebra and returns `unknown` for anything it can't safely check) to verify a step before judging it, then emits the diagnostic. Also gets the hidden teacher `worked_solution` as a correctness anchor.
- **Pass C — holistic**: marker-voice `what_youve_done_well` / `top_priority` / `improvements`, plus the maths `skill_assessment`.

Stage-aware (Years 7–12) via `graduation_year`; HSC conventions (`+C`, `ln|x|`, "Show that", Reference Sheet) apply only at Stage 6, Stage 4–5 calibration from `data/stage-4-5-reference.ts`. Marking guideline is optional; `api/generate-marking-guideline.ts` AI-generates one. Teacher marking on `mark-submission-maths.html`; student view `feedback-maths.html`.

### Silent insights signals pass — marked_task / quick_task (`lib/insights-signals-feedback.ts`)
Single Haiku 4.5 call invoked from `/api/submit-for-marking` when `tasks.task_mode ∈ {marked_task, quick_task}`. Returns the same shape as a subset of the holistic-feedback tool (`what_youve_done_well`, `task_verb_check`, `improvements`, `top_priority`) plus a `skill_assessment`, so cohort cards + the student-profile synthesis + the skill database all consume it without branching. **Subject-aware:** `submit-for-marking` derives the skill family from `tasks.subject_type` (`familyForSubjectType`) and passes it through — a maths submission is scored on the maths dimensions (M1–M6) via `buildInsightsSignalsTool('maths')` + a maths-working prompt, and recorded under `family: 'maths'`; everything else uses writing (W1–W7). Cost is roughly $0.004/call. Failures don't fail the submission — the student's work still lands; only the side-effect signal is lost. Successful runs mark the profile stale and feed `student_skill_profile`. **Quick/marked tasks are the bulk of submissions, so this is where most skill data accrues.**

## Skill taxonomy (the skill database)

The "databasing" spine — every submission is scored against a small, durable skill taxonomy and accumulated into a queryable per-student store. The taxonomy (`data/skill-taxonomy.ts`, versioned via `TAXONOMY_VERSION`) is the IP: copyable as a list, but worthless without months of consistently-rated submission data behind it.

- **Two tiers.** A 4-capability universal **spine** (Task Command, Reasoning, Evidence & Support, Communication) that every subject rolls up to, and discipline **dimensions** underneath — 7 writing (`W1`–`W7`) and 6 maths (`M1`–`M6`) — that carry the actionable signal.
- **Jurisdiction-neutral.** Anchored on SOLO / Bloom / academic literacy, not NESA labels, so it survives a move to VCE/QCE etc.; only the *calibration* (marker-voice exemplars) is NSW-specific.
- **Developmental scale, never a mark/band.** Levels: emerging → developing → consolidating → secure → extending (1–5). Diagnostic only — preserves the no-band-prediction rule.
- **Captured at feedback time, no extra call.** `skill_assessment` is an output field on the holistic / maths-holistic / insights-signals tools (built from the taxonomy via `buildSkillAssessmentSchema` so they can't drift). Pulled out server-side, stored on `submissions.skill_assessment`, and folded into `student_skill_profile` by `recordSkillSignals` (`lib/skill-profile.ts`) using an EWMA (recency-weighted level) + growing confidence + trend. Fire-and-forget — never affects the student's feedback.
- **Readers** — the **Lesson Differentiator** queries `student_skill_profile` via `readSkillProfile()`; the **cohort skill matrix** card aggregates the snapshot via `computeSkillMatrix()` in `lib/skill-matrix.ts`; the **cohort skill growth** + **per-student trajectory/movement** cards aggregate the observation history via `lib/skill-history.ts`; and (R3) the **LLM syntheses are now skill-anchored** — the longitudinal student profile, the four student cards, and the whole-cohort pattern cards (`common_gaps` / `things_done_well`) all receive a measured skill block (`lib/skill-prompt.ts` `formatStudentSkillProfile` / `formatCohortSkillMatrix`) alongside the feedback prose, so the narrative is grounded in levels/trends rather than re-derived from wording. Best-effort: a skill read failure just omits the block.
- **History log** — every rollup write also appends one row per (submission, dimension) to `skill_observations` (`recordSkillObservations` in `lib/skill-profile.ts`), the append-only event log the growth card reads. Best-effort and isolated: a failed history write never disturbs the rollup. Backfillable from existing `submissions.skill_assessment` via `npm run backfill-skill-observations`.

### Teacher marking (`mark-submission.html` → `submission-grade.ts`)
- Two-column layout. Student draft on the left with text-selection annotation tool (select text → "+ Annotate" → category + comment). Rubric mark entry on the right.
- Per-criterion inputs for criterion-list rubrics, single overall input for band-style.
- For `quick_task` with `completion_only`, the UI offers a "mark as complete" toggle instead of (or alongside) a numeric mark — sets `submissions.completion_status = 'completed'`.
- On save: writes `criterion_marks`, `total_mark`, `teacher_comment`, `teacher_annotations`, `completion_status`, `graded_at`, `graded_by`. Clears the matching `draft_autosaves` row. Invalidates the student's `student_profile_synthesis` cache. Fires AGS passback to Canvas SpeedGrader if the task is LTI-linked.

### Student results view
- `my-results.html` — student "markbook". Summary strip (classes, tasks, marked, overall average), one card per class with class average, then per-task rows with status (not submitted / due soon / overdue / submitted / submitted late / marked) and mark.
- `feedback.html` — single submission's feedback. Adds a "Marked by your teacher" tab when `graded_at` is set, with per-criterion rubric breakdown in graded mode, teacher comment, and teacher annotations in blue/purple (differentiated from ProofReady's annotations).

## Lesson Differentiator

The first **reader** of the skill database turned into action — the feedback → profile → differentiated activity → more feedback flywheel. Built 2026-06; open to every school (per-domain gating is post-pilot).

**Flow.** A teacher publishes a task with the "Publish with Lesson Differentiator" button on `new-task.html` (`createTask(true, true)` → `tasks.lesson_builder = true`); authoring is otherwise unchanged. Each student gets a version of the activity attuned to their skill profile, generated **lazily the first time they open the task** (`POST /api/generate-activity`) and locked in `task_activities` (stable across their 3 drafts). **No skill data → main activity unchanged, no LLM call.** Any failure → silent fallback to the main activity; students never see an error.

**Differentiation differs by subject:**
- **Writing → support-layer only.** Question / criteria / outcomes identical for everyone; only `student_focus` + `scaffolding[]` + `extension` differ. Deliberate, for assessment validity (no per-student essay-question rewrites). Tool `DIFFERENTIATED_ACTIVITY_TOOL`.
- **Maths *without* a marking guideline → re-skin the question.** Same outcome + same solution method; only the instance difficulty changes (numbers/coefficients/context, at most ±1 added/removed step), confidence-aware. The variant carries a `question`; `submit-maths.html` renders it (fetched before render), `generate-maths-feedback.ts` evaluates against it (and stores it on the submission), `mark-submission-maths.html` shows `submission.question`. Tool `DIFFERENTIATED_MATHS_ACTIVITY_TOOL`.
- **Maths *with* a marking guideline → support-layer** (the guideline is written for the base question, so the question stays put).

**Prompt:** `prompts/lesson-builder-system.ts` (`buildActivitySystemPrompt` + `buildMathsActivitySystemPrompt` + `buildActivityUserPrompt`). Rules: target 1–2 dimensions, scaffold developing / extend secure, **student-facing text is an invitation, never a diagnosis** (no levels/bands), confidence- and stage-aware. Skill profile read via `readSkillProfile()`.

**Student view** (`submit.html` / `submit-maths.html`): a "Your focus for this task" banner (focus + scaffolding/extension); for maths re-skins the differentiated question replaces the main one.

**Teacher view** is deliberately low-touch — the task page shows nothing extra. Per-student support appears only on the individual marking screen (`mark-submission.html` / `mark-submission-maths.html`) as a "support this student was given" block (context, ignorable for bulk "mark all complete"). `task-submissions` returns an `activities` array (per-student variants, incl. enrolled students who haven't opened yet) consumed by the marking screen.

## LTI 1.3 (Canvas)

First pilot: **Penrith Christian School** (`learningpcs.instructure.com`, client_id `277420000000000006`, deployment `238:4918899f387deeb8c2a566f759e392996b5535f4`). Seeded into `lti_platforms` via `scripts/lti-migration.sql`.

Endpoints (exposed at `/lti/*` via the `vercel.json` rewrite):
- `/lti/jwks` — public JWK Canvas uses to verify our DeepLinkingResponse JWTs
- `/lti/login` — OIDC initiation
- `/lti/launch` — main launch handler. Verifies platform id_token against Canvas JWKS, validates nonce, provisions user + class, kicks off async NRPS roster sync for teacher launches, redirects to magic-link session URL.
- `/lti/deep-link` — deep linking picker session info + signed response

Supports: OIDC initiation, resource link launch, deep linking, NRPS roster sync, AGS grade passback (completion + final mark).

**Deep-link → task resolution:** Canvas mints its own resource_link id for a deep-linked assignment, so the join key is `custom.proofready_task_id` (set in the DeepLinkingResponse content item, echoed by Canvas on every launch). The **first launch** of the assignment resolves the task via the custom claim (verified against platform + mapped class), then self-heals `tasks.lti_resource_link_id` + the AGS line-item URLs; later launches match on the resource_link id directly. Deep linking clears the task's AGS URLs (re-linking must not post grades to the old assignment's column until the new one is launched once). Deep-linked line items are created worth `total_marks`. Student launches route maths tasks to `submit-maths.html`. A second teacher launching a course already linked to a colleague's class lands on `lti-class-owned.html` (first-launcher-wins; co-teaching not yet supported) instead of a 403. Issuer in config = `https://canvas.instructure.com` (generic Canvas Cloud value, not the school's hostname). JWKS/auth/token endpoints point to `sso.canvaslms.com`. Self-hosted Canvas instances would use the school's own domain.

Env: `LTI_PRIVATE_KEY` (RSA-2048 PEM, PKCS#8), `LTI_KEY_ID` (UUID kid), `SITE_ORIGIN`.

## Insights system

The largest subsystem outside the core feedback flow. Three-tier access (teacher / leader / admin), two views (cohort / individual student), eight LLM card kinds + six SQL-derived cards.

### Two views

**Cohort view** — default when no `student_id` filter set. The cards depend on tier:
- Teacher (class scope): **class profile summary** (LLM, aggregated from `student_profile_synthesis` rows of currently-enrolled students) + mark distribution + **Skill breakdown** (deterministic skill matrix) + **Skill growth** (deterministic, from the observation history) + improvement velocity + keyword struggles (verb_depth LLM) + top 3 mistakes (common_gaps LLM) + stretch goals (top_decile LLM, quartile mode) + 3 things done well (things_done_well LLM) + **Maths errors by category** (shown only when the class has maths feedback submissions)
- Leader/admin (school scope): activity sparkline, faculty engagement, mark distribution, mark by faculty, **Skill breakdown** (deterministic skill matrix, rolled up across in-scope disciplines), **Skill growth** (deterministic, within-student change over time), marking progress, teacher activity, per-criterion lows, improvement velocity, keyword struggles, **Maths errors by category**, plus all five Tier-A LLM cards (bottom_decile, top_decile, verb_depth, common_gaps, things_done_well)

**Skill growth** (`computeSkillGrowth` in `lib/skill-history.ts`, from the `skill_observations` history) is a deterministic companion to the breakdown: for each dimension it averages each student's OWN change over time (latest observation − earliest, for students with ≥2 observations), so it measures whether students are improving rather than how the cohort's composition shifted. Ranks dimensions most-improved first, flags the top mover and the one to watch, windowed to the dashboard's time filter. No LLM, no mark/band, aggregate only.

**Skill breakdown** (`computeSkillMatrix` in `lib/skill-matrix.ts`) is the **first insights reader of the skill database** and **not an LLM card**. For each writing dimension (W1–W7) and maths dimension (M1–M6) it aggregates the in-scope cohort's `student_skill_profile` rollups into a distribution across the developmental levels (emerging → extending), with the cohort median, a net-trend arrow, average confidence (flagging students on thin evidence), a 4-capability spine rollup, and a highlighted **focus** dimension (lowest mean with enough data). Scoped by students enrolled in the in-scope classes AND those classes' disciplines, so faculty restriction is honoured. A student carrying a dimension under multiple disciplines is collapsed to one value so they're never double-counted. Deterministic, free, no rate limit, no floor beyond a 3-student minimum per family — developmental levels only, never a mark/band, and no student named.

**Maths errors by category** (`computeMathsErrorCategories` in `insights-cards.ts`) is **not an LLM card** — it deterministically aggregates the per-line diagnostic categories (`missing_constant`, `notation_equals_abuse`, `verb_mismatch`, skipped mark-bearing steps, …) across in-scope maths feedback submissions (single-question + multi-part) and ranks them by **distinct students** ("8 students dropped +C"). Objective and free — no generation, no rate limit. Covers feedback-task maths only (marked/quick maths run the Haiku pass, which doesn't emit per-line categories).

A **time-window filter** applies to all submissions queries via `getTimeWindowCutoff` in `lib/insights-filters.ts` — limits subs to a recent window so cards reflect current cohort behaviour rather than historical baselines.

**Individual student view** — triggered by selecting a student from the search box. Available to all tiers. Loads the longitudinal profile via `/api/student-profile` and renders metric cards alongside it:
1. Hero: **Student profile** (LLM, span 12) — longitudinal narrative + headline strength + headline priority + improvement / strength themes + profile_status (established / developing / new). Cached in `student_profile_synthesis`; regenerated lazily on cache miss.
2. **Mark distribution** (span 12) — A–E band counts + per-task list (this student only). Excludes `quick_task` submissions by design.
3. **Skill movement** (span 12) — the at-a-glance summary of measured skill change: which dimensions this student has *improved* on, *slipped* on, or is *still working on* (flat and below secure). `summariseSkillMovement` in `lib/skill-history.ts`, from the observation history. **This replaced the old "improvement velocity" card**, which compared LLM improvement TITLES as verbatim strings — noise, since regenerated feedback rarely repeats wording. Deterministic, developmental levels only.
4. **Skill trajectory** (span 12) — this student's per-dimension level over time as sparklines, from `skill_observations` (`computeStudentSkillJourney` in `lib/skill-history.ts`). Deterministic, developmental levels only. Each line shows the assessed level per skill across submissions, with a net-change badge and the current level; a dashed reference line marks *secure*.
4. **Top 3 mistakes** (LLM, span 6) — recurring patterns in their improvement feedback
5. **Stretch goals** (LLM, span 6) — personalised next steps
6. **3 things done well** (LLM, span 12) — consistent strengths

Quick-task submissions never contribute to mark-percentage stats — `insights-card-generate.ts` zeroes `mark_pct` whenever `task_mode = 'quick_task'`, even if the teacher chose to give it a number. They still feed cohort LLM cards via their silent Haiku feedback.

### Scope rules (enforced server-side)

In `lib/schools.ts`:
- `resolveInsightsAccess(supabase, user, opts)` → `{ schoolId, schoolName, callerRole, restrictedFaculties }`. Returns null only for unauthenticated callers.
- `getOwnedClassIds(supabase, userId)` — classes where teacher_id = userId.
- `getInScopeClassIds(supabase, role, userId, schoolId, restrictedFaculties)` — teacher = own; leader = school × faculty filter; admin = all school.
- `getInScopeStudentIds(supabase, role, userId, schoolId, restrictedFaculties)` — distinct student_ids across in-scope classes.

A teacher passing `?class_id=` for a class they don't own naturally returns zero rows (the classes query is constrained by `teacher_id IN [user.id]`). A student outside a teacher's class is filtered out by the same constraint — verified by the smoke test in `scripts/insights-student-smoke-test.ts`.

### LLM card caching

- Cohort cards are cached per **(owner, kind, scope)** with **corpus-fingerprint freshness** — leader/admin in `school_insights_cards` keyed `(school_id, card_kind, scope_key)`, teacher tier in `teacher_insights_cards` keyed `(teacher_id, card_kind, scope_key)`. A generate re-reads the cache first: if the fingerprint (in-scope submission count + latest activity + mark signature) matches, it returns cached for free and skips the rate-limit. Different scopes coexist; same-scope leaders share. Generated cards persist across reloads (GET `/api/insights-cards` returns the scope-matched row for the caller's tier).
- Student cards (all four kinds): no cache by design (privacy + freshness). Regenerated each generate; in-memory client state holds the result for re-renders.
- Student profile (`student_profile_synthesis`): per-student row, marked **stale** on grading / AI-feedback / marked-quick submission. Read path regenerates only on new submissions or a stale row past the refresh window (`lib/student-profile.ts` `profileNeedsRegen`), else serves cached — so bulk marking doesn't force a regen per profile open.
- Class profile summary (`class_profile_summary` kind): generated on demand from currently-cached student profiles for the class — does NOT spawn N profile generations on click. Students without a cached profile are surfaced as "needs more data".
- **UI:** the insights page (cohort + student views) is driven by a single **"Generate Insights" / "Regenerate Insights"** button at the top — no per-card buttons. Each card shows a spinner overlay and keeps prior content until its own result lands; the click fans out all applicable kinds in parallel.

Rate limit: 5/hr per user per card kind for cohort; 8/hr per student per kind on student cards (bucket key includes a short student_id prefix so spamming one student doesn't lock out others). Class profile summary: 6/hr per school, 300/day global. Student profile generation: 30/hr per user, 800/day global (cache hits are not rate-limited).

### Floors

- Cohort decile cards (top/bottom): ≥5 graded submissions (teacher tier uses ≥4, quartile slice).
- Teacher-tier cohort LLM cards: ≥10 submissions with feedback.
- Student LLM cards: ≥3 submissions with feedback (below that, the card shows "Not enough data yet" with the current count).

### Card presentation (current)

- Cohort LLM cards (gaps, strengths, deciles) and the student cards render as **clean orange-bulleted lists** (`.pts`); the old coloured tiles and the LLM `scope_note` disclaimer are gone (scope_note removed from the tool schemas entirely).
- The single **Generate Insights** button shows an inline spinner while running (not a wait-cursor); each card keeps prior content under a spinner overlay until its own result lands.
- Card titles are uniform (one `cardHeader` style). The cohort grid orders **gaps + things-done-well above the maths-errors and decile cards**. "Top 3 cohort-wide gaps" → "Top 3 most common gaps".
- The **Leadership synthesis** card (formerly "Cross-faculty synthesis") renders as one flat card — sub-sections are plain subheadings, not nested boxes.
- **Provenance labels (R6).** Every insight card states what it rests on, so a teacher can calibrate trust. LLM cohort + student cards show "N submissions across M tasks · updated … · scope …" in the header. The deterministic skill cards carry a `provenanceFooter` (shared helper): the **Skill breakdown** footer names the student basis and flags how many skill readings rest on thin evidence ("8 of 24 … treat those as indicative"); **Skill growth / trajectory / movement** footers state the within-student method so growth isn't misread as a cohort mean. All reiterate "developmental levels, not marks or bands". Backend: the cohort `common_gaps` prompt tags each entry "full feedback" (Sonnet, assessment tasks) vs "brief auto-signal" (Haiku, quick/exam tasks) with a weighting instruction, so the model discounts the lighter evidence.

### Student search

`/api/insights-students-search?q=…` — substring match on `display_name` + `email`, case-insensitive, scope-restricted to `getInScopeStudentIds`. Returns up to 10 results, surname-prefix matches ranked first. Used by an autocomplete input on the insights page (120ms debounce, 1-char minimum, "Searching…" placeholder shown immediately).

## API endpoints

### Feedback + submissions
- `POST /api/generate-feedback` — Essay three-pass Claude feedback (single-question). Auth-required. Rate-limited.
- `POST /api/generate-multi-feedback` — Per-question feedback for a multi-question take-home assessment (feedback_task essay with a `questions` array). Marks-scaled depth (Haiku short / Sonnet three-pass extended). Rate-limited.
- `POST /api/generate-maths-feedback` — Maths two-pass feedback (subject_type `maths`). Rate-limited.
- `POST /api/structure-maths-working` — Haiku pass that splits freeform/talk-through maths input into `{math}` lines.
- `POST /api/transcribe-maths-working` — Claude Sonnet **vision** pass that transcribes a photo of handwritten maths working into `{math}` lines (student confirms before diagnosis). Image sent base64 after client-side downscale.
- `POST /api/transcribe-maths-authoring` — **teacher-only** vision pass (#3b): photographs a question / worked solution / multi-part question while authoring → clean text (inline `$...$`) or `{stem, parts[]}`. Transcribe + structure only (never solves/invents); fills `new-task.html` fields in an editable state.
- `POST /api/generate-marking-guideline` — AI-generate a maths marking guideline (teacher, at task time).
- `POST /api/generate-activity` — **Lesson Differentiator**: generate (or return the locked) per-student differentiated activity for a `lesson_builder` task. Student-triggered, lazy, auth-required; silent fallback to the main activity.
- `POST /api/generate-criteria` — AI-generate marking criteria for a task (teacher).
- `POST /api/generate-class-feedback` — Teacher-only synthesis across a class's submissions for one task. Persists to `tasks.class_feedback`.
- `GET /api/task` / `POST` / `PUT` / `DELETE` — Task CRUD. Class teacher only.
- `GET /api/task-submissions` — All submissions for one task, enriched with student names. Teacher only. `?light=1` (used by the task-detail list) omits the heavyweight `feedback` + `skill_assessment` jsonb; the marking screens fetch full rows.
- `GET /api/task-csv` — CSV export of submissions for a task.
- `GET /api/class` / `POST` — Class CRUD + join-by-code.
- `GET /api/me` — Current user's profile + role + classes. Subpaths: `?resource=submissions`, `?resource=task-drafts&task_id=…`, `?resource=results`.
- `GET /api/draft-autosave` / `PUT` — In-progress drafts.
- `POST /api/submit-for-marking` — Final non-AI submission (essay `draft` or maths `working_lines`). Runs the silent Haiku insights pass for marked/quick tasks. Locks the task.
- `PUT /api/submission-grade` — Teacher marking. Writes rubric marks + annotations + fires AGS passback.
- `POST /api/signup` — Custom signup with display_name + email_confirm bypass.
- `POST /api/request-password-reset` — Generates a recovery link (`admin.generateLink`) and sends it via Resend (falls back to Supabase email if `RESEND_API_KEY` unset). Always 200 (anti-enumeration); rate-limited per email via a hashed-email key. Landing page `reset.html` establishes the session from the link.
- `POST /api/set-role` — Sets `user_metadata.role`.
- `POST /api/contact` — Contact form → forwards to help@.
- `POST /api/attachment` — mint a signed upload URL for one task/submission file (validates type + size; teacher role required for task scope). `GET /api/attachment?path=…&task_id=…|&submission_id=…` — authorise the caller against the owning task/submission, then return a short-lived signed download URL.

### Admin / school management
- `GET /api/admin-schools` — Admin school list/management data.
- `GET/POST /api/school-members` — Manage `school_members` (grant leader/admin).

### Insights
- `GET /api/insights-cards` — Cohort cards (school or class scope based on caller role + filters).
- `GET /api/insights-student?student_id=…` — Single-student card data. Verifies caller scope.
- `GET /api/insights-students-search?q=…` — Typeahead student search.
- `GET /api/insights-detail?kind=teachers|classes|tasks|submissions&…` — KPI drill-downs.
- `GET /api/insights-synthesis` / `POST` — School-wide LLM synthesis (leader/admin only), rendered as the **Leadership synthesis** card. `school_strengths` + `school_weaknesses` capped at 3 with an internal-consistency rule (no strength contradicting a gap; small-sample caveat stated once, not repeated). POST always regenerates. Cached on `schools.insights_cache`.
- `POST /api/insights-card-generate` — Generate one Tier-A LLM card. Body: `{ kind, school_id?, faculty?, course?, class_id?, year_level?, student_id? }`. Kinds:
  - Cohort: `bottom_decile`, `top_decile`, `verb_depth`, `common_gaps`, `things_done_well`. **`common_gaps` generates the top 3 gaps AND top 3 strengths in ONE consistent call** (tool `COHORT_PATTERNS_TOOL`, internal-consistency rule so a skill is never both a strength and a gap), then fans the strengths into the `things_done_well` cache — the frontend requests `common_gaps` only and both cards come from that one call. A generation-version tag in `cohortFingerprint` busts stale caches on logic changes.
  - Student: `student_top_mistakes`, `student_stretch_goals`, `student_strengths`, `student_summary`
  - Class: `class_profile_summary` (requires `class_id`, aggregates cached student profiles)
- `GET /api/student-profile?student_id=…` — Longitudinal student profile. Returns cache hit if present, otherwise regenerates via Sonnet and persists. Access: the student themselves OR a teacher/leader/admin whose insights scope includes the student.
- `GET /api/admin-stats` — Internal admin dashboard data. Gated by `ADMIN_USER_IDS`/`ADMIN_EMAILS`.

### LTI 1.3
- `GET /lti/jwks` — public JWK
- `GET/POST /lti/login` — OIDC initiation
- `POST /lti/launch` — main launch
- `GET/POST /lti/deep-link` — deep linking picker + signed response

## File overview

### `api/`
Feedback (essay): `generate-feedback.ts`, `generate-multi-feedback.ts` (multi-question take-home), `generate-class-feedback.ts`
Feedback (maths): `generate-maths-feedback.ts`, `structure-maths-working.ts`, `generate-marking-guideline.ts`
Task authoring: `generate-criteria.ts`
Lesson Differentiator: `generate-activity.ts` (per-student differentiated activity)
Submissions: `submit-for-marking.ts` (also runs the silent Haiku pass + skill capture for marked/quick tasks), `submission-grade.ts`, `task-submissions.ts`, `task-csv.ts`, `task.ts` (validates task_mode + subject_type + criteria + completion_only), `draft-autosave.ts`
Auth: `signup.ts`, `request-password-reset.ts`, `set-role.ts`
Classes + user: `class.ts`, `me.ts`
Insights: `insights-cards.ts`, `insights-student.ts`, `insights-students-search.ts`, `insights-detail.ts`, `insights-synthesis.ts`, `insights-card-generate.ts`, `student-profile.ts`
Admin: `admin-stats.ts`, `admin-schools.ts`, `school-members.ts`
Contact: `contact.ts`
Attachments: `attachment.ts` (signed upload + authorised signed download for task/submission files)
LTI: `api/lti/*` — `jwks.ts`, `login.ts`, `launch.ts`, `deep-link.ts`

### `lib/`
- `auth.ts` — `getSupabase()`, `verifyAuth(req)`
- `cors.ts` — `applyCors()` for api.proofready.app
- `generate-inline-suggestions.ts` — Pass 3 implementation
- `insights-signals-feedback.ts` — silent Haiku pass for marked/quick task submissions
- `feedback-questions.ts` — `validateFeedbackQuestions` (multi-question take-home text questions + per-question criteria) + `isFeedbackQuestionsTask`
- `multi-question-feedback.ts` — `generateQuestionFeedback` (marks-scaled short/extended per-question feedback) + `aggregateSkillAssessments` (one skill signal per dimension per submission)
- `skill-profile.ts` — `recordSkillSignals()` (validate `skill_assessment` against the taxonomy + EWMA rollup into `student_skill_profile`; also appends to the history log when a `submissionId` is passed), `recordSkillObservations()` (append-only write to `skill_observations`; reused by the backfill), `validateSkillSignals()` (shared validation/dedupe), and `readSkillProfile()` (read side, used by Lesson Differentiator)
- `skill-matrix.ts` — `computeSkillMatrix()`, the deterministic cohort skill-breakdown card (per-dimension level distribution from `student_skill_profile`)
- `skill-history.ts` — reads over `skill_observations`: `computeSkillGrowth()` (cohort growth card, within-student deltas), `computeStudentSkillJourney()` (per-student trajectory series), `summariseSkillMovement()` (per-student improved/slipped/still-working summary — the R4 replacement for improvement velocity)
- `skill-prompt.ts` — (R3) formats skill data into LLM prompt blocks: `formatStudentSkillProfile()` (one student's rollup) + `formatCohortSkillMatrix()` (cohort distribution), each with baked-in no-mark/no-band guardrails. Injected into the student-profile synthesis, the student cards, and the cohort pattern cards.
- `parse-rubric-with-ai.ts` — Sonnet rubric → structured criteria at task create/edit
- `rubric-detect.ts` — `looksLikeBandRubric()` / `stripBandLabels()` heuristics
- `student-profile.ts` — `readCachedProfile()` + `regenerateProfile()` + `profileNeedsRegen()` for the longitudinal profile (stale-flag model)
- `rate-limit.ts` — per-user-per-hour + global-per-day caps, logs to `api_call_log`
- `sentry.ts` — Sentry init + `captureError`
- `task-verbs.ts` — NESA directive verb extraction from a question string
- `user-names.ts` — `getUserInfoBatch()` / `getUsersByEmailDomain()`: RPC-first (`get_user_info` / `get_users_by_email_domain` SQL functions, `scripts/user-info-rpc-migration.sql`) with a listUsers-sweep fallback until the migration runs. Replaced the old page-through-every-auth-user pattern that made every hot page slower with every platform signup
- `feedback-tools.ts` — Tool schemas for all Claude tool-call endpoints (holistic, criteria, inline, rubric parse, class feedback, school insights, the Tier-A cohort cards incl. the combined `COHORT_PATTERNS_TOOL`, the student-scope cards, the insights-signals Haiku tool, the class_profile_summary tool, and the Lesson Differentiator `DIFFERENTIATED_ACTIVITY_TOOL` + `DIFFERENTIATED_MATHS_ACTIVITY_TOOL`)
- `anthropic-tool-call.ts` — `callTool<T>()` wrapper
- `insights-filters.ts` — Filter parsing, faculty-scope clamping, year-level helpers, `getTimeWindowCutoff()`
- `schools.ts` — School resolution, scope helpers (`resolveInsightsAccess`, `getOwnedClassIds`, `getInScopeClassIds`, `getInScopeStudentIds`, `getSchoolTeacherIds`, `getSchoolStudentIds`, `canViewInsights`, `listAllAuthUsers`)
- `admin.ts` — `isGlobalAdmin()` — `ADMIN_USER_IDS` first, falls back to `ADMIN_EMAILS`
- LTI: `lib/lti/*` — `config.ts`, `jwt.ts`, `nonce.ts`, `roles.ts`, `user-provision.ts`, `course-provision.ts`, `service-auth.ts`, `nrps.ts`, `ags.ts`

### `prompts/`
- `feedback-system.ts` — Pass 1 system + user prompt (split invariant-core + course-specific for caching)
- `inline-suggestions-system.ts` / `inline-suggestions-user.ts` — Pass 3
- `insights-signals-system.ts` — Haiku silent-pass system + user prompt
- `maths-system.ts` — maths per-line diagnostic + holistic system/user prompts (stage-aware)
- `multi-question-feedback-system.ts` — warm, student-facing short-answer prompt for the multi-question take-home light pass (Haiku)
- `feedback-system.ts` also exports `buildCriteriaCheckPrompt` (the criterion-pass system prompt), shared by single- and multi-question essay feedback
- `lesson-builder-system.ts` — Lesson Differentiator differentiation prompts (writing support-layer + maths question re-skin)

### `data/`
- `skill-taxonomy.ts` — **the ProofReady skill taxonomy** (spine + writing/maths dimensions, scale, `buildSkillAssessmentSchema`, `TAXONOMY_VERSION`)
- `nesa-reference.ts` — GLOSSARY, PERFORMANCE_BANDS, MARKING_PRINCIPLES, SOLO_LEVELS, VERB_DEPTH_MAP, COMMON_PITFALLS, FEEDBACK_PRINCIPLES, `currentYearLevelFromGraduationYear`
- `nesa-courses.ts` — HSC course list + `getDisciplineForCourse()` mapping
- `subject-glossaries.ts` — subject-specific terminology banks
- `marker-voice-loader.ts` — Reads NESA Notes JSON → calibration block
- `nesa-marking-feedback/*.json` — Scraped NESA Notes 2021–2024 by subject
- `stage-4-5-reference.ts` — Stage 4/5 (Y7–10) calibration for maths + writing

### `public/`
Auth + onboarding: `index.html`, `auth.html`, `choose-role.html`, `forgot-password.html`, `reset.html`
Student: `student.html`, `class-view.html`, `submit.html`, `submit-maths.html`, `feedback.html`, `feedback-maths.html`, `my-results.html`
Teacher: `teacher.html`, `new-class.html`, `class-detail.html`, `new-task.html` (incl. the live "Publish with Lesson Differentiator" publish action), `task-detail.html`, `mark-submission.html`, `mark-submission-maths.html`, `teacher-markbook.html`
Insights: `insights.html` (single page — handles cohort + student modes, all three tiers; single Generate-Insights button)
Admin: `admin.html`
LTI: `lti-not-ready.html` (shown when an LTI launch lands before provisioning is done), `lti-deep-link.html` (deep-linking picker)
UI note: all checkboxes use a centered background-SVG checkmark; emoji glyphs replaced with lucide-style stroke SVGs site-wide.
Marketing: `deck.html` (rewritten from `/deck`; source HTML in `pitch/pitch-deck.html`), `handout.pdf` (rewritten from `/handout`; the pitch handout PDF — replace this file to update it)
Admin resources: `admin.html` renders an admin-only **Resources** footer (only appears after the admin-stats gate passes) linking the narrative walkthrough (public `resources` Storage bucket → `…/storage/v1/object/public/resources/walkthrough.mp4`), the slide deck (`/deck`) and the handout (`/handout`). Re-uploading the video under the same name updates it with no code change.
Policy: `compliance.html`, `privacy.html`, `terms.html`, `contact.html`
Account: `profile.html`
Shared JS: `js/app.js` (Supabase client, `authFetch`, `requireAuth`, `apiUrl`, Sentry init), `js/rubric.js` (rubric parser/renderer — pipe-table, band-style, criterion-list, letter-band, multi-part HSC, flattened-table; modes `display` / `mark-entry` / `graded`), `js/nesa-courses.js` (course autocomplete), `js/contact-modal.js`, `js/attachments.js` (`Attachments.createAttachmentUploader` + `renderAttachmentList` — file upload widget + read-only signed-URL list)

### `scripts/`
- SQL migrations: `classes-migration.sql`, `class-feedback-migration.sql`, `rls-policies.sql`, `scale-indexes.sql`, `lti-migration.sql`, `typed-response-only-migration.sql`, `teacher-marking-migration.sql`, `submit-for-marking-migration.sql`, `insights-cards-cache.sql`, `task-modes-migration.sql`, `student-profile-migration.sql`, `schools-migration.sql`, `schools-faculties.sql`, `maths-feedback-migration.sql`, `hide-criteria-from-students-migration.sql`, `teacher-insights-cards.sql`, `school-insights-cards-scope.sql` (adds scope_key + fingerprint), `student-profile-stale-migration.sql` (adds the `stale` flag), `skill-profile-migration.sql` (adds `submissions.skill_assessment` + `student_skill_profile`), `own-task-fields-migration.sql` (`submissions.own_task_*`), `lesson-builder-migration.sql` (`tasks.lesson_builder` + `task_activities`), `attachments-migration.sql` (private `attachments` Storage bucket + `tasks.teacher_attachments` + `submissions.student_attachments`), `exam-time-limit-migration.sql` (`tasks.time_limit_minutes`), `exam-over-time-migration.sql` (`submissions.over_time_cutoff_index`), `resources-bucket-migration.sql` (public `resources` Storage bucket for admin presentation assets), `student-attachments-toggle-migration.sql` (`tasks.allow_student_attachments`), `skill-observations-migration.sql` (`skill_observations` history log for the skill-growth card), `skill-profile-atomic-migration.sql` (optional atomic rollup fold — audit P1-10, not yet wired), `user-info-rpc-migration.sql` (id-scoped auth-user lookup RPCs — the listUsers replacement), `api-call-log-maintenance.sql` (rate-limit index + hourly pg_cron prune of >30d rows)
- One-offs: `backfill-inline-suggestions.ts`, `backfill-skill-observations.ts` (populate `skill_observations` from existing `skill_assessment`; `npm run backfill-skill-observations`), `scrape-nesa-feedback.ts`, `generate-lti-keypair.ts`, `diagnose-pcs-search.ts`
- Smoke tests: `lti-smoke-test.ts`, `insights-teacher-smoke-test.ts`, `insights-student-smoke-test.ts`

### Config
- `vercel.json` — `maxDuration: 300` (Pro plan) on every Claude-backed endpoint, security headers (nosniff, HSTS, referrer policy, `frame-ancestors` allowing Canvas iframes), rewrites `/lti/*` → `/api/lti/*`, `/deck` → `/deck.html`, `/handout` → `/handout.pdf`
- `tsconfig.json` — `module: ESNext` + `moduleResolution: bundler`, strict
- `package.json` — `@anthropic-ai/sdk`, `@supabase/supabase-js`, `@sentry/node`, `@vercel/node`, `@vercel/functions`, `jose`

### `test/`
- `evaluate-sample.ts`, `smoke-rubric-parse.ts`, `smoke-tool-use.ts`, `test-inline-suggestions.ts` — manual/smoke harnesses, run directly with `tsx` (no test runner wired up yet)
- `calibration-fixtures.ts` + `calibrate-feedback.ts` (`npm run calibrate-feedback`) — runs the per-question feedback engine over emerging/borderline/strong fixtures and prints each result + a teacher-jargon count + avg words/sentence, so register/volume prompt changes are measured (jargon should drop) without flattening strong-band feedback. Makes real Anthropic calls.

## Env vars

- Core: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service_role), `SUPABASE_ANON_KEY`, `SUPABASE_SITE_URL`
- LTI: `LTI_PRIVATE_KEY` or `LTI_PRIVATE_KEY_HEX`, `LTI_KEY_ID`, `SITE_ORIGIN`
- Misc: `RESEND_API_KEY` (contact form), `SENTRY_DSN`, `ADMIN_USER_IDS`
- `SUPABASE_ANON_KEY` — used by the password-reset fallback path
- `RESEND_API_KEY` — Resend; powers the contact form and password-reset emails
- `SENTRY_DSN` — optional; observability no-ops without it
- `ADMIN_USER_IDS` — comma-separated UUIDs (preferred over `ADMIN_EMAILS` for safety against email-squat during signup)
- `ADMIN_EMAILS` — legacy fallback
- `LTI_PRIVATE_KEY` — RSA-2048 PEM. Newlines as `\n` if one-line, multi-line if pasted in Vercel
- `LTI_KEY_ID` — UUID kid for the public JWK
- `SITE_ORIGIN` — frontend origin for LTI redirects (defaults to `https://proofready.app`)

## Key design decisions

- **No mark/band predictions, ever.** Hard-coded prompt rules. The tool refuses to estimate marks even when asked.
- **No content rewriting.** Feedback says what to fix and why, not how. Hard-coded.
- **3-draft cap per task** to prevent over-reliance on the feedback and limit cost.
- **Three parallel passes** so wall-clock = max(pass1, pass2, pass3) not sum. Pass 1 is load-bearing; Passes 2 + 3 are best-effort.
- **Subject-specific calibration.** NESA Notes from the Marking Centre 2021–2024 indexed in `data/nesa-marking-feedback/*.json` + subject glossaries in `data/subject-glossaries.ts` injected into Pass 1.
- **Typed-response-only as default** (`typed_response_only` = true). Paste/drop blocked, mobile warned off, autosave + telemetry. Designed so a draft submitted to ProofReady is actually the student's own typing.
- **api.proofready.app subdomain** is Cloudflare DNS-only, not orange-cloud. Cloudflare's 100s edge proxy timeout would kill long Anthropic calls; bypassing it gives us Vercel's full 300s on Pro.
- **Insights student-name policy.** School-wide and cohort prompts forbid naming students ("aggregate only"). Student-scope prompts (`student_*` kinds) explicitly allow naming — the teacher is already authorised to see this student. The no-mark/no-band rule still applies.
- **Student profile privacy contract.** The longitudinal profile synthesis never sees raw draft text, never sees verbatim annotation quotes, and is forbidden from quoting or paraphrasing student writing. This is what makes the profile safe to surface to any current teacher of the student — including one inheriting students mid-year who never saw the previous class's drafts. The privacy policy explicitly covers this for `marked_task` / `quick_task` paths: silent AI pass, never shown to the student, used only for aggregate cohort signals + the profile, no model training, no cross-school sharing.
- **Quick task is "not a graded task" by design.** Even when a teacher gives a quick_task a numeric mark, it stays out of mark distribution / decile cards. It feeds LLM cohort cards and the student profile only. Mark-card logic in `insights-card-generate.ts` zeroes `mark_pct` for `task_mode = 'quick_task'`.
- **Prompt caching is plumbing, not a one-off.** `callTool({ cacheSystem: true })` caches the large static system prompts; structure calls so the invariant prefix is shared (e.g. across a class submitting the same task) for ~10× cheaper input. The same shared-prefix pattern keeps Lesson Differentiator cheap across a class.
- **Databasing is the strategy.** Every submission scores against the skill taxonomy at feedback time and accumulates into `student_skill_profile`. Insights, the profile, and the Lesson Differentiator are *readers* of one compounding store — the moat is the accumulated, consistently-rated data, not the taxonomy list.
- **Lesson Differentiator = support-layer for writing, question re-skin for maths.** Writing differentiates only the support (assessment validity); maths (no guideline) re-skins the question's difficulty holding outcome + method fixed. Student-facing differentiation is always an invitation, never a deficit diagnosis.
- **Own tasks are capped by *distinct tasks started per day*** (3 own + 5 class), not raw call count — so the 3-draft model stays usable while still bounding cost/abuse.
- **No "AI feedback" branding in user copy.** App/marketing copy leans on NESA-calibrated quality, not the mechanism; legal/compliance pages keep the AI disclosures. Homepage line: "Smarter feedback, better insights".
- **Scope-keyed, fingerprinted insight caches.** Cohort cards cache per (owner, kind, scope) with a corpus fingerprint; different scopes coexist, same-scope viewers share, and a generate is free when nothing changed. Teacher tier has its own per-teacher cache.
- **LTI provisioning is idempotent.** `provisionUser`/`provisionClass` converge on a `23505` unique-violation (Canvas can double-fire a launch) instead of failing; `provisionClass` also cleans up the orphan class the losing request created.

## Known issues / gotchas

- **Google OAuth doesn't work in Expo Go** — N/A for ProofReady (web only). Mentioned only because the same person also runs Citrafort.
- **Skill capture: marked/quick tasks run on Haiku.** Quick tasks (the bulk of submissions) score skills via the cheaper Haiku pass, which is less nuanced than Sonnet — accepted because aggregation smooths noise and the AI-feedback paths add Sonnet-quality signal. Worth sanity-checking captured `signal` notes against teacher judgment before any reader depends on them.
- **Skill taxonomy is versioned** (`TAXONOMY_VERSION`). Adding/renaming a dimension orphans prior data or needs a re-score — change deliberately.
- **Surname parsing is naive** — last whitespace-separated token. Doesn't handle compound surnames ("Van Der Berg") gracefully in the ranking heuristic. The search still works (substring match catches it); only the ranking boost might miss.
- **Faculty-restricted leaders cannot widen scope by passing a foreign faculty in the URL.** `applyFacultyScope` clamps the filter to allowed faculties; a request for a faculty outside the grant returns no data (not a 403, because empty is a useful UI signal).
- **Teachers without a school context** (no LTI, no email-domain match, no `school_members` row) still get insights. Their `schoolId` resolves empty; class-scope works, but they don't share a cohort with anyone.
- **Lesson Differentiator maths re-skins are auto-generated** — the highest-risk surface. Sanity-check difficulty + solvability before trusting them; the lever is `buildMathsActivitySystemPrompt` in `prompts/lesson-builder-system.ts`, and the conservative dial is numbers-only (drop the ±1-step allowance). Maths tasks *with* a marking guideline fall back to support-layer so the guideline still matches.
- **Vercel git auto-deploy has been intermittently missing pushes.** If a change doesn't appear after `git push`, run `vercel --prod` (the reliable fallback) and re-verify.
- **me?resource=submissions no longer carries `draft_text`/`feedback` for class-task rows** (payload grew with the student's whole history). The dashboard routes class-task rows to `feedback.html?task=<id>` (self-load; the subject probe redirects maths). Own-task rows still carry both (no server-side task to self-load from).
- **Feedback sessionStorage handoffs are consume-once.** `proofready_feedback` / `proofready_maths_feedback` are cleared after render (the task id is pinned into the URL via replaceState so refresh self-loads), and a `?task=` URL param always wins over a mismatched stored handoff.

## Sister projects (different Supabase, different repos)

- **Citrafort** — household finance app. Mobile (Expo) + web (Next.js). Supabase ref `kjueriejebawtccuqxid`. Repo `robsheahan/citrafort`. Path `/Users/rob/citrafort`.
- **Recommndr**, **Lexis**, **Equivise** — separate apps, separate repos, separate Supabase projects (when they have them).

Don't cross-reference these in ProofReady work.
