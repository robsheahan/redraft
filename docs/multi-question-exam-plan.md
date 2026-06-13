# Multi-Question In-Class Exams — Design Plan

**Status:** BUILT 2026-06-13 (uncommitted working tree). All nine build-order steps implemented; `tsc` clean; `scripts/exam-smoke-test.ts` passes (37 checks). **Action required before use:** run `scripts/multi-question-exam-migration.sql` in the Supabase SQL editor, then deploy (verify Vercel auto-deploy or `vercel --prod`). The live browser E2E (steps 7 + 9 manual parts) is still to be done in a deployed environment.
**Origin:** Teacher feedback — real assessments are rarely one question. ProofReady should be able to *be* the format for a full in-class assessment, not just host one question of it.

---

## 1. Scope decision (and why)

Multi-question support lands in **`marked_task` (In-class exam) only**, with **typed-text and multiple-choice questions**, in v1.

**Why the exam mode:**
- It has **no student-facing AI**. A take-home `feedback_task` runs three Sonnet passes per draft × up to 3 drafts — per-question that explodes cost and breaks the draft model conceptually (what is "draft 2" across 6 questions?). An exam runs one silent Haiku pass at submit; multi-question there is a data-model + UI problem, not an LLM-cost problem.
- It's where the constraint actually bites. Take-home drafts are typically one extended response. A real NSW in-class exam is short answers building to an extended response.
- It composes with existing decisions: single submission, no criteria requirement, no feedback rendering, no Lesson Differentiator (standardisation).

**Why text + MC, not maths:** text answers cover short answers and extended responses; MC covers Section-I-style objective items — together that's a complete NSW exam paper for written subjects. Per-question MathLive working is still ~a doubling of scope with no pilot demand, so maths exams keep the existing single-question flow; the per-question `type` field means it can be added later **without migration**. **MC builds last** (step 8, after the typed-text flow is verified end-to-end) so its one sharp edge — answer-key stripping — lands on a proven foundation; steps 1–7 are shippable without it.

**MC posture (Rob's calls, 2026-06-13):** teacher enters the options and selects the correct answer at authoring; students see the options in a **per-student scrambled order**; MC questions are **auto-marked — teachers never mark them** (read-only on the marking screen); written questions require teacher grading as planned. Auto-marking is deterministic answer-key comparison, not AI judgment — no conflict with the no-AI-marking ethos.

**Restriction is policy, not structure.** The `questions` array lives on `tasks` generally; `api/task.ts` validation simply rejects it outside `marked_task` + `subject_type='essay'` for now. Extending to quick tasks later (a 3-question "do now") is a validation change, not a migration.

**Structure: flat numbered list.** Questions 1..N, each with text + optional marks. Sub-parts ("Question 3(a)") and section headers are written into the question text by the teacher. No nesting level in v1.

### Non-goals (v1)
- Teacher override of MC auto-marks (Rob: no need for teachers to mark those). Accepted limitation: a miskeyed question can't be credited per-student; the recourse is the whole-submission teacher comment. Revisit if it bites in the pilot.
- Multi-question maths (per-question working lines).
- Sections as a schema concept; per-question time limits.
- Multi-question on `quick_task` / `feedback_task` (deliberate; revisit post-pilot).
- Lesson Differentiator on exams (stays off — and v1 adds the missing API-level gate, see §8).

---

## 2. Data model

One new migration: **`scripts/multi-question-exam-migration.sql`**.

```sql
alter table public.tasks
  add column if not exists questions jsonb;          -- null = legacy single-question task

alter table public.submissions
  add column if not exists answers jsonb,            -- null = legacy single-draft submission
  add column if not exists question_marks jsonb;     -- teacher per-question marks

alter table public.draft_autosaves
  add column if not exists answers jsonb;            -- in-progress per-question answers
```

### `tasks.questions` — array of question objects
```jsonc
[
  { "id": "<client-generated uuid>", "type": "text", "text": "Outline TWO ...", "marks": 3,
    "attachments": [ { "path": "...", "name": "source-a.pdf", "content_type": "application/pdf", "size": 81234 } ] },
  { "id": "...", "type": "multiple_choice", "text": "Which of the following ...", "marks": 1,
    "options": [ { "id": "<uuid>", "text": "..." }, { "id": "<uuid>", "text": "..." } ],
    "correct_option_id": "<uuid>", "attachments": [] },
  { "id": "...",                      "type": "text", "text": "Analyse how ...", "marks": 8, "attachments": [] }
]
```
- `id` — stable client-generated uuid; everything downstream anchors to it. Display numbers derive from array order (never stored, so reordering while drafting can't drift).
- `type` — `'text'` or `'multiple_choice'` in v1; `'maths'` reserved.
- MC questions carry `options` (2–6, stable client-generated ids — ids, not letters, are the identity, because display order is scrambled per student) and `correct_option_id`. **`correct_option_id` is the answer key and must never reach a student client pre-grading** — see the stripping helper in §4a.
- `marks` — **required** per-question marks (a real exam paper always shows them), **shown to students**. `total_marks` is always the sum of question marks — derived, not independently editable, for multi-question exams.
- `attachments` — optional per-question stimulus files (sources, diagrams, data tables — "Refer to Source A"), same `{path,name,content_type,size}` shape as `tasks.teacher_attachments`. Files live in the existing private `attachments` bucket under the same task scope, so **`api/attachment.ts` needs no changes** — upload minting and signed-download authorization are already per-task; only where the metadata lands differs. Caps: ≤3 files per question, existing type/size rules (images + PDF, ≤10MB). Task-level `teacher_attachments` still works alongside (whole-paper material, e.g. a formula sheet).
- **Convention:** `questions` non-null ⇒ multi-question task; `tasks.question` (scalar) is null. N=1 exams keep writing the legacy scalar `question` (see §3) — the multi-question machinery only engages at N≥2.

### `submissions.answers` — array, parallel to questions
```jsonc
[
  { "question_id": "...", "question_text": "Outline TWO ...", "marks": 3,
    "text": "<student answer>", "over_time_cutoff_index": null },
  { "question_id": "...", "question_text": "Which of the following ...", "marks": 1,
    "selected_option_id": "<uuid>", "selected_option_text": "..." },
  { "question_id": "...", "question_text": "Analyse how ...", "marks": 8,
    "text": "...", "over_time_cutoff_index": 412 }
]
```
MC answers store the selected option (id + text snapshot) instead of `text`. Correctness is **not** stored on the answer — it lives only in `question_marks` (below), which is stripped from student-facing submission payloads pre-grading.
- `question_text` + `marks` are **snapshotted at submit** so the submission stays self-describing even if the task is later edited — the marking screen renders from `submission.answers` alone, no join drift.
- `over_time_cutoff_index` moves **inside each answer** (char index into that answer's `text`). The submission-level `over_time_cutoff_index` column stays null for multi-question submissions.

### `submissions.question_marks` — teacher marking
```jsonc
[ { "question_id": "...", "mark": 2.5, "source": "teacher" },
  { "question_id": "...", "mark": 1,   "source": "auto" } ]
```
MC rows are written by the server at submit time (`source: 'auto'`, answer-key comparison); text rows by the teacher at marking time. `total_mark` is **still written** (sum of question marks) — so AGS passback, the markbook, mark-distribution cards, and the profile synthesis (`lib/student-profile.ts` reads only `total_mark`) all work **unchanged, zero branching**.

### `teacher_annotations` — one additive field
Annotation objects gain an optional `question_id`; `start`/`end` become relative to **that answer's `text`**. Legacy annotations (no `question_id`) keep anchoring to `draft_text` exactly as today.

### `draft_text` stays, serialized — the load-bearing compat decision
The maths flow already established the pattern: structured column (`working_lines`) **plus** a serialized `draft_text` for every downstream reader. Multi-question follows it exactly. A single serializer (new `lib/exam-transcript.ts`, used only server-side):

```
Question 1 (3 marks): Outline TWO ...
Answer: <student text>

Question 2 (8 marks): Analyse how ...
Answer: <student text>
```

Because `draft_text` is always populated, these consumers need **no changes at all**: the Haiku insights pass corpus, `student_profile_synthesis`, insights fingerprints, `task-csv`'s `draft_text` column, `task-submissions`' `select *`.

---

## 3. Authoring — `new-task.html` + `api/task.ts`

**UI (new-task.html):** when the In-class exam sub-type is selected, the single "Task question" textarea becomes a question list editor:
- Question rows: auto-numbered label, a **type toggle (Text / Multiple choice)**, textarea, marks input, an "Attach file" control (reuses `Attachments.createAttachmentUploader` from `js/attachments.js`, one instance per row, writing into that question's `attachments`), and a remove button; "+ Add question" below. Reorder via simple up/down arrows (drafting only).
- MC rows additionally show an option list (default 4 rows, "+ Add option" up to 6, minimum 2) with a radio beside each to **select the correct answer**; marks default to 1. The teacher authors options in their preferred canonical order — scrambling happens per student at serve time, never at authoring.
- One question (the default) ⇒ payload carries the legacy scalar `question`, `questions: null`. The common case stays on the battle-tested path, and **maths exams (single-question only) are untouched**.
- N≥2 ⇒ payload carries `questions[]` (client generates uuids), `question: null`. The `total_marks` field becomes a read-only auto-sum of the question marks.

**Validation (api/task.ts `handleCreate`/`handleUpdate`):**
- `questions` accepted **only** when `task_mode='marked_task'` and `subject_type` is essay. Reject elsewhere (400) — this is the policy gate.
- Each entry: `text` required non-empty, `type` ∈ {`text`, `multiple_choice`}, `marks` required positive number, `attachments` optional array capped at 3. MC entries: 2–6 options with non-empty text and unique ids, `correct_option_id` required and matching an option (validate shape server-side, same as `teacher_attachments` handling), cap **20 questions**, per-question text length cap (mirror existing question limits). Exactly one of `question` / `questions` populated. Server recomputes `total_marks` as the sum of question marks (ignores any client-sent value for multi-question tasks).
- **Lock on publish:** once `published_at` is set, `handleUpdate` rejects changes to the `questions` array (add/remove/reorder/edit). You don't edit a live exam; answers anchor to question ids. (Title, due date, time limit stay editable.)

---

## 4. Student exam page — `submit.html`

Branch on `task.questions` being non-null; legacy path untouched.

### 4a. Answer-key security + per-student scrambling (the sharp edge)

One helper, **`studentTaskView(task, studentId)`** in a new `lib/exam-questions.ts`, applied at **every** endpoint that returns task data to a student role. It does two things in one place:
1. **Strips `correct_option_id`** (and nothing else option-related) from every MC question. The key must never appear in any student-reachable payload — task reads, autosave echoes, or pre-graded submission reads. The same sweep must confirm student-facing **submission** payloads strip `question_marks`, `feedback`, and `skill_assessment` pre-grading (the existing "silent pass never surfaces" posture, now load-bearing for the MC key).
2. **Deterministically scrambles option order** per student: shuffle seeded by a hash of `(student_id, question_id)` — stable across reloads and autosave restores for one student, different across students sitting the same exam. No randomness source needed at request time; the seed is pure data. Teacher-facing reads always get canonical order.

Build this helper first within the MC step and write the smoke check for it before wiring UI.

- **Layout:** single scrolling page (paper-exam mental model, simplest autosave). Each question block: "Question N" + marks badge + question text + that question's attachment list (read-only signed-URL list via `Attachments.renderAttachmentList`, exactly like task-level accompanying material renders today) + its own textarea with a per-question word count.
- **Typed-response-only:** paste/drop blocking and telemetry capture attach to every textarea; telemetry stays **aggregated at submission level** (keystrokes etc. summed across boxes — the columns don't change).
- **MC blocks:** radio group in the student's scrambled order (delivered by `studentTaskView`, §4a). Selecting writes `selected_option_id` into the autosave payload like any other answer.
- **MC + the timer:** unlike text (shown-not-enforced, because over-time typing is visible work a teacher can discount), MC has no visible-work equivalent and no teacher adjustment exists — so **MC inputs disable at the deadline** (UI), the deadline snapshot of selections lands in `telemetry.answers_at_deadline` like text answers, and if a final selection differs from the snapshot (tampering / missed disable) the **server auto-marks from the snapshot** and the marking screen flags the question "changed after time limit".
- **Autosave:** still one debounced PUT per (student, task); body gains `answers: {question_id: text | selected_option_id}` alongside `draft_text` (a cheap serialized join, so a legacy reader never sees empty). `api/draft-autosave.ts` persists the new `answers` column; restore repopulates each box by question id.
- **Timer / over-time:** one whole-exam timer (unchanged — `time_limit_minutes` is per task). At the deadline, snapshot **every** answer into `telemetry.answers_at_deadline` (object keyed by question id; telemetry is already jsonb — survives reopen, same as today's `text_at_deadline`). At submit, run the existing `commonPrefixLength` per question against each snapshot → per-answer `over_time_cutoff_index`. Per-answer length caps bound the telemetry blob.
- **Submit payload:** `answers: [{question_id, text, over_time_cutoff_index}]` instead of `draft` + the scalar cutoff. Everything else (telemetry fields, `student_attachments`) unchanged.

`submit-maths.html`: no changes (maths exams remain single-question in v1).

---

## 5. Submit endpoint — `api/submit-for-marking.ts`

- Accept `answers[]` as a third body shape alongside essay `draft` and maths `working_lines`. Validate: task actually has `questions`, every answer's `question_id` matches a task question (missing answers stored as empty — students may legitimately skip), text type/length checks; for MC, `selected_option_id` must be one of the question's options (or null = skipped).
- Snapshot `question_text` + `marks` (and for MC, `selected_option_text`) from the task into each stored answer.
- **Auto-mark MC at submit:** compare each selection (deadline snapshot wins where it differs, §4) against `correct_option_id`; write `question_marks` rows with `source:'auto'` (full marks or 0). Not revealed to the student — `graded_at` stays null, and `question_marks` is stripped from student payloads until graded.
- Build `draft_text` via the `lib/exam-transcript.ts` serializer; store `answers` + `draft_text` on the submission. MC lines serialize as `Question N (1 mark, multiple choice): <q> — Selected: "<option text>"` with **no correctness marker** (draft_text can reach pre-graded student payloads; correctness lives only in `question_marks`). The Haiku call instead gets an unstored "Multiple choice: X/N correct" context line in its user prompt, with guidance to weight the skill assessment toward the written answers. Submission-level `question` column: null (the answers are self-describing).
- **Haiku insights pass: still exactly one call.** Pass the serialized transcript as `draft` and a short header ("In-class exam, N questions") as `question`. One-line addition to the `insights-signals` prompt noting the draft may be a multi-question exam transcript — the skill assessment reads the whole performance, which is what the skill database wants. No tool-schema change.
- Idempotency constraint, rate limits, lock semantics: unchanged.

---

## 6. Marking — `mark-submission.html` + `api/submission-grade.ts`

Branch on `submission.answers` non-null.

- **Left column:** one section per answer — question text + marks badge + that question's attachments (so the marker sees the stimulus the student was responding to; joined from the task by `question_id`, which is safe because questions are locked on publish), then the answer with the existing selection→annotate tool. Annotations record `question_id`; `start`/`end` relative to that answer. The existing over-time divider rendering (`renderDraftWithAnnotations`'s split) is reused **per answer** using each answer's own cutoff.
- **MC questions render read-only** — question, options in canonical order with the student's pick and the correct answer marked, the auto mark, an aggregate line ("Multiple choice: 7/10 — automarked"), and the "changed after time limit" flag where it applies. No inputs: teachers never mark MC (Rob's call).
- **Right column:** a mark input per **text** question (`x / marks`), live-summed **Total** = MC auto sum + written marks (read-only — per-question inputs are the way to adjust it), plus the existing whole-submission teacher comment.
- **Save:** body gains `question_marks[]` for text questions only; server validates each `question_id` against the submission's answers and each mark ≥0 and ≤ that question's marks, preserves the `source:'auto'` MC rows untouched, computes and writes `total_mark` = sum server-side.
- **Release stays teacher-controlled:** even an all-MC exam needs the teacher's save to set `graded_at` (one click) — students never see MC results, or anything else, before the teacher releases. Annotations validated as today plus `question_id` membership.
- **AGS passback: zero change** — it reads `total_mark`.
- "Support this student was given" Lesson Differentiator block: n/a (gated off exams, §8).

---

## 7. Student results + exports

- **`feedback.html`** (graded marked_task view): when `answers` is present, render per question — question text, that question's attachments (signed-URL list, same as the submit page), mark badge (`2.5 / 3`), the student's answer with that question's teacher annotations — then total + teacher comment. MC questions show the options in the same scrambled order the student sat (recomputed deterministically), their pick ticked/crossed and the correct answer highlighted — post-grading only, so revealing the key here is fine. Pre-grading, marked_task shows no feedback (unchanged).
- **`my-results.html`:** no change (reads `total_mark` + status only).
- **`api/task-csv.ts`:** `draft_text` column already carries the full serialized transcript. Additionally, for multi-question tasks append `q1_mark..qN_mark` columns from `question_marks` (auto and teacher marks alike), and for MC questions a `qN_selected` column with the chosen option text. (Header derived from the task's questions; legacy tasks unchanged.)
- **`api/task-submissions.ts`:** `select *` already returns the new columns; the marking screen consumes them. No endpoint change.

---

## 8. Hardening folded in (pre-existing gap)

The explorer pass found Lesson Differentiator is only **UI-gated** off exams — `new-task.html` hides the button, but neither `api/task.ts` nor `api/generate-activity.ts` rejects `lesson_builder=true` on a `marked_task`. v1 adds:
- `api/task.ts`: reject `lesson_builder` unless `task_mode='quick_task'` (matching the UI's stated rule).
- `api/generate-activity.ts`: return the main activity (no LLM call) for `marked_task`, belt-and-braces.

This protects exam standardisation independent of this feature, and removes the multi-question × differentiation interaction entirely.

---

## 9. What deliberately doesn't change

| Surface | Why it's untouched |
|---|---|
| Haiku pass / skill capture | one call on the serialized transcript; same tool, same family routing |
| `student_profile_synthesis` | reads `total_mark` + feedback summaries only |
| Insights cards + fingerprints | corpus reads `draft_text` / counts — already populated |
| AGS / markbook / mark distribution | `total_mark` still written |
| LTI launch/deep-link/NRPS | task internals are opaque to LTI |
| Maths exam flow | stays single-question |
| `hide_criteria_from_students` | exams have no criteria |

---

## 10. Build order (each step shippable behind the previous)

1. **Migration + serializer + validation** — `multi-question-exam-migration.sql`, `lib/exam-transcript.ts`, `api/task.ts` questions validation + lock-on-publish + the Lesson Differentiator API gate (§8).
2. **Authoring** — `new-task.html` question-list editor, N=1 legacy fallback, marks auto-sum.
3. **Student flow** — `submit.html` multi-question render, autosave (`api/draft-autosave.ts` + column), telemetry attach, per-question deadline snapshots + cutoffs, submit payload.
4. **Submit endpoint** — `answers[]` shape in `submit-for-marking.ts`, snapshotting, transcript serialization, Haiku prompt line.
5. **Marking** — `mark-submission.html` per-question sections + annotations + marks, `submission-grade.ts` validation + server-side total.
6. **Results + export** — `feedback.html` graded per-question view, `task-csv.ts` mark columns.
7. **Verification (text flow)** — `tsc` clean; manual E2E: author 3-question exam (differing mark values, one question with a PDF stimulus attached; confirm total_marks auto-sums) → student submits with one skipped answer + deliberately over time → mark per question with annotations on Q1 and Q3 → check student graded view, CSV, AGS payload, profile regen. Regression: legacy single-question essay exam and maths exam still round-trip identically. Smoke script in the style of `scripts/insights-*-smoke-test.ts` if time allows.
8. **Multiple choice** — `studentTaskView` strip/scramble helper in `lib/exam-questions.ts` **first, with its smoke check** (key absent from student payloads; shuffle deterministic per student, divergent across students); then authoring MC rows + validation, student radio blocks + deadline disable, submit-time auto-marking + transcript lines + Haiku context, marking-screen read-only MC block, graded view, CSV columns.
9. **Verification (MC)** — mixed text+MC exam E2E: two student accounts see different option orders (and stable across reloads); network inspection shows no `correct_option_id` or `question_marks` in any student payload pre-grading; auto marks correct incl. a skipped MC question; change-after-deadline path flags on the marking screen; all-MC exam releases with a single teacher save; AGS total = auto + teacher marks.

## 11. Risks / open questions

- **Annotation anchoring discipline** — `start`/`end` semantics now depend on `question_id` presence; the render + save paths in `mark-submission.html` must never mix the two coordinate spaces. Highest-care code in the build.
- **Skipped questions** — stored as empty answers so numbering stays aligned; the marking screen shows "No answer" rather than omitting the section.
- **Telemetry size** — N deadline snapshots in `draft_autosaves.telemetry`; bounded by per-answer length caps + the 20-question cap.
- **Answer-key leakage is the highest-severity failure mode** — one missed student-facing read path (task fetch, autosave echo, pre-graded submission, even `draft_text` content) leaks the key or the score mid-exam. Mitigation: single `studentTaskView` chokepoint, correctness kept out of `answers` and `draft_text` entirely, and the §10-step-9 network-inspection check is non-optional.
- **Scramble determinism** — the shuffle seed must be pure data (hash of student_id + question_id), never a randomness call, so order is reproducible at marking/graded-view time and stable across reloads.
- **Miskeyed MC questions have no per-student recourse in v1** (no override — deliberate). If a teacher discovers a bad key after sitting, the v1 answer is "fix the key won't help; use the teacher comment". Watch for this in the pilot.
- **Teacher expectation creep** — first requests after shipping will likely be sections-as-structure and per-question criteria. Both are deliberate non-goals; the `type` field and the policy-not-structure gate are the pre-built extension points.

*(Resolved 2026-06-13: per-question marks are **required** — Rob's call. A teacher who doesn't want mark allocation uses a quick task instead.)*
