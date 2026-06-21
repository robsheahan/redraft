# Maths overhaul — accuracy, handwriting input, and authoring

**Goal:** make ProofReady the premier maths teacher/student interface. The current typed `{math, reason}` v0 is a clever proof-of-concept but is not yet trustworthy enough or low-friction enough to own the category. This plan sequences the work that gets us there.

Central design question (unchanged): **"How can we get the most accurate possible feedback to mimic that of a professional, experienced teacher?"** An experienced maths teacher's defining trait is that they don't make marking errors — so accuracy is the foundation everything else sits on.

## Decisions locked (2026-06-21)

1. **Drop the student reasoning line.** A maths HOD reviewed the line+reason model and didn't buy it. The reason field was friction the student carried to make the *model's* job easier, and it felt artificial to a practitioner. We keep per-line diagnosis; we drop the typed reason input. (See "What we keep" below — we do **not** lose reasoning feedback.)
2. **Handwriting / OCR input for maths.** Students enter working by handwriting (tablet canvas) or photo (snap paper) → vision transcription → confirm → diagnose. Typed entry stays as a fallback. **Essays are untouched** — paste-blocking + typing telemetry remain the essay integrity model.
3. **OCR for teacher authoring.** Teachers photograph handwritten/printed questions → transcribed + structured into an editable multi-question exam. Same flow captures the hidden worked solution. **Transcribe + structure, never auto-generate question content; always land in an editable review state.**
4. **Accuracy first.** A hidden teacher worked-solution + a verification layer is priority #1 — dropping the reason line removes the model's declared-intent crutch, so the verifier is what replaces it.

**Moat reframe:** *"reads the student's actual handwritten working, line by line, against syllabus marking conventions, in marker voice, and compounds it into a skill profile."* Stronger and more defensible than reason-per-line. (Note: this supersedes the earlier framing in `project_proofready_maths` / design-call #2 that treated *line+reason* as the moat. Per-line *diagnosis* is retained and is still load-bearing; the *typed reason field* is what goes.)

## Roadmap (build order)

| # | Item | Status |
|---|------|--------|
| 0 | Drop the reasoning line | ✅ done 2026-06-21 (uncommitted) |
| 1 | Accuracy foundation — hidden worked solution + verification | ✅ Phase 1 done 2026-06-21 (uncommitted; **migration not yet run**). Phase 2 deferred |
| 2 | Multi-part questions (`(a)(b)(c)` + "Hence") for maths | later |
| 3 | Handwriting / OCR — **student** input (transcribe → confirm → diagnose) | later |
| 3b | Handwriting / OCR — **teacher** authoring (photo → structured exam; worked solution) | later |
| 4 | Maths-native cohort insights (aggregate the per-line categories) | later |

#0 and #1 are independent of input modality — they operate on the `[{math}]` line substrate, which both typed and (future) handwriting input produce. So they can ship before the capture work and don't get rebuilt when it lands.

---

## Cross-cutting UI principles (recorded now; implemented at #3 / #3b)

The capture UI is built in #3/#3b, but the decisions are locked now so the surfaces we touch earlier are shaped consistently.

- **Capture ≠ attach.** The existing "attach file" control stores an *inert* document (shown, never read). A capture photo *becomes* the content (transcribed into working / a question). Same gesture, opposite outcome. **Never fold capture into the attach-file button**, and keep them visually distinct. Capture lives where content is created; attach stays the inert reference uploader.
- **Student (`submit-maths.html`): capture is an input *mode*, not a bolt-on button.** The mode-picker is the home. Rationalise it around handwrite-vs-type: `[ ✍ Write ] [ 📷 Photo ] [ ⌨ Type ]` — Write = on-screen canvas (touch devices), Photo = camera (phones), Type = MathLive fallback (laptops). All three land in the **existing confirm screen** (the freeform/talk-through confirmation flow) as editable transcribed lines before submit.
- **Reverse the essay mobile-guard for maths.** Essays push students to a laptop; maths *wants* the phone/tablet. The maths submit page should embrace touch/mobile, not warn against it.
- **Teacher (`new-task.html`): one "📷 Build from a photo" action at the exam-editor level** (beside "+ Add question"), not per-question — one scan fans out into multiple editable rows. Style it in the same family as the existing "Generate marking criteria/guideline" buttons (AI-assist that drafts editable content). Per-question photo is a secondary nicety only (adding a figure to one question).
- **Diagrams: carry through, don't redraw.** Transcribe the text; keep the original hand-drawn figure as the question's attached image. Cheap first cut at "figures in questions"; redrawing is out of scope.
- **Worked solution capture is a separate, clearly-labelled action** ("Add worked solution — hidden from students"), never blended with the question scan, so what-students-see vs what's-hidden is never ambiguous.

---

## #0 — Drop the reasoning line

### What we keep (important)
- **Per-line diagnosis stays** — `math_status` per line, `step_gaps` between lines, marker-voice comments. The distinguishing per-line granularity is unchanged.
- **Reasoning/justification feedback stays.** It now comes from the *working itself* (whether "show that" has a concluding line, whether justification steps are present, whether conditions are stated) — the way a real marker infers it. `justification_missing` and `verb_mismatch` categories are retained.
- **Skill taxonomy unchanged.** `M3 (Reasoning & justification)` is assessed from the working — **no `TAXONOMY_VERSION` bump**.
- **No migration.** `submissions.working_lines` stays `jsonb`; new rows are `[{math}]`, old rows keep their unused `reason`. Renderers simply stop showing it.

### Touch points (file by file)

**`lib/feedback-tools.ts`**
- `MATHS_PER_LINE_DIAGNOSTIC_TOOL`: remove the `reason_status` property and drop it from the item `required`. In the `category` enum, remove `reason_only_issue` (keep `justification_missing`, `verb_mismatch`, etc.). Rewrite the `category` description that references `reason_status` (the "Use 'ok' only when both math_status and reason_status are ok" line → math only).
- `MATHS_STRUCTURE_WORKING_TOOL`: remove the `reason` field from `lines.items` and from its `required`; lines become `{ math }` only.
- `MATHS_HOLISTIC_TOOL`: structurally unchanged (`skill_assessment` includes M3, stays).

**`prompts/maths-system.ts`**
- `buildMathsPerLineDiagnosticSystem`: the line description ("each line has two parts: math + reason") → math only. "HOW TO READ A LINE" drop the reason axis. `categoryGuideForStage` → remove the `reason_only_issue` bullet from the `universal` block. Drop the "if the reason is missing/vague/mismatched…" guidance. Keep follow-through, notation, justification, verb rules.
- `buildMathsStructureWorkingSystem` / `buildMathsStructureWorkingUserPrompt`: remove reason-extraction instructions; output `{math}` lines.
- `buildMathsPerLineUserPrompt`: the numbered transcript drops the `reason:` line per entry.
- `buildMathsHolisticUserPrompt`: numbered working `Line N: <math> — <reason>` → `Line N: <math>`.

**`api/generate-maths-feedback.ts`**
- `WorkingLine` type `{ math, reason }` → `{ math }`; `sanitiseLines` stops requiring/keeping `reason` (tolerate its absence on read).
- `draft_text` flattening: drop the `Reason:` line.

**`api/structure-maths-working.ts`**
- Returns `{math}` lines (mirror the tool-schema change).

**`public/submit-maths.html`**
- `addLine`: remove the `.reason-input` element and its telemetry/paste wiring (keep `math-field` telemetry).
- `collectLines`: return `{ math }`.
- `submitForFeedback`: remove the "N lines have no reason — submit anyway?" confirm.
- Inline hints: reword (drop "a short reason underneath earns method marks").
- Mode-picker: relabel "Structured (line + reason)" → "Line by line". (Full handwrite/type rationalisation is #3; for now keep Line-by-line / Freeform / Talk-through.)
- Autosave + prior-draft seed: operate on `{math}`.

**`public/feedback-maths.html`**
- `render`: drop the `.line-reason` row.
- `renderAnnotation`: remove the `reason_status` logic (`isReasonOnly`, the `reason` class, the `help` icon). Collapse to `math_status` only: ok / slip(warn) / ok_following_through(ft) / error.
- `prettyCategory`: remove the `reason_only_issue` case.

**`public/mark-submission-maths.html`**
- `renderWorking`: drop the `.line-reason` row.
- `renderAiAnnot`: remove the `reason_status` branch.

**`api/submit-for-marking.ts`** (found during the sweep — the marked/quick maths path, not in the original list)
- `mathLines` type `{math, reason}` → `{math}`; drop reason from the map/filter and from the serialised `draftText` (the `Reason:` line). This is what feeds the silent Haiku insights pass for in-class-exam / quick maths tasks.

### Done (2026-06-21)
- `tsc --noEmit` clean. Full reason-field sweep clean across schema, prompts, all three maths APIs, and all three maths HTML surfaces. Prompt-render smoke confirmed `{math}`-only lines render as `Line N: <math>` with no reason field; the only remaining "reason" strings are the word *reasoning* (assessed from the working) + the `justification_missing` category — both intentional.
- Left as harmless dead code (no functional impact): `.reason-input` / `.annot.reason` CSS rules. Not worth the churn now; a later pass can remove.
- Not migrated, not committed. No `TAXONOMY_VERSION` bump (M3 retained).
- **Asset spotted for #1:** `MATHS_RESKIN_VERIFY_TOOL` (in `feedback-tools.ts`) already makes the model derive a `worked_solution` from scratch to verify Lesson-Differentiator re-skins — a working precedent for the worked-solution-as-correctness-anchor pattern.

---

## #1 — Accuracy foundation (worked solution + verification)

The trust foundation. Today Pass B asks Sonnet to independently judge whether each line follows algebraically — the exact thing LLMs are unreliable at. We give it a known-correct anchor and (phase 2) a deterministic checker.

### Phase 1A — hidden teacher worked-solution field

**Data model** — `scripts/maths-worked-solution-migration.sql`:
```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worked_solution text;
```
Maths-only in practice; null for everything else.

**`api/task.ts`**
- Create/update: accept `worked_solution` for maths tasks, mirroring `marking_guideline` (set to null for non-maths, as at the `subjectType === 'maths' ? … : null` lines).
- **Strip for non-owners — unconditionally** (NOT gated on `isGraded`): in the existing `if (!isOwner && (… || task.subject_type === 'maths' || …))` block (lines ~93–118), add `payload.worked_solution = null;` for the maths branch, *outside* the `isGraded` gate. The worked solution is the correctness anchor and the highest-severity leak surface — treat it like the multi-question answer key. (Reveal-to-students-after-grading is a deliberate later option, default **off**.)

**`public/new-task.html`** (maths authoring path)
- Add a **"Worked solution — hidden from students"** textarea near the Marking guideline field, styled in the Generate-button/marking-guideline family, with a one-line hint ("Used to mark accurately. Never shown to students.").
- v1 is type/paste. **Photo capture of the solution is #3b** — design the field so a capture button slots in beside it later.
- Wire `worked_solution` into the `createTask`/update payload.
- (Deferred option: an AI "draft worked solution" assist — teacher-only, hidden, reviewed. Risky re: "we don't solve"; not in v1.)

### Phase 1B — verification in the diagnostic

**`prompts/maths-system.ts`**
- `buildMathsPerLineUserPrompt` gains `workedSolution?: string | null`. Inject it fenced as a correctness anchor, e.g.:
  > `REFERENCE SOLUTION (teacher-provided — for YOUR correctness checking ONLY. NEVER reveal, quote, hint at, or reconstruct it for the student.)`
- `buildMathsPerLineDiagnosticSystem`: add a rule — *a reference solution may be supplied; use it to judge each line's correctness and to detect skipped mark-bearing steps; still apply follow-through credit; it is the marker's instrument and must never leak* (same posture as the marking guideline).

**`api/generate-maths-feedback.ts`**
- Read `task.worked_solution`; pass to `buildMathsPerLineUserPrompt`.
- **Edge case — Lesson Differentiator maths re-skin:** when `task.lesson_builder` re-skinned the question per student (`question` replaced from `task_activities`), the base worked solution **does not match** the variant. Do **not** pass `worked_solution` in that case (or regenerate per-variant later). Guard explicitly.

Effect: `math_status` is judged against a known-correct path instead of re-derived — the single biggest accuracy gain, for a small change.

### Phase 2 — deterministic verifier (decision pending; sketch only)
A symbolic/numeric check (math.js inline, a small sympy service, or Claude tool-use compute) that verifies line-to-line consistency + final-answer correctness and feeds Pass B as ground truth. Phase 1 ships first; the approach is an open question below.

### Verify (#1)
- **Leak test:** grep/smoke that `worked_solution` never appears in any student-facing payload (`/api/task` as a student member; the feedback object; `feedback-maths.html`). Highest-severity surface — verify like the exam answer key.
- Accuracy spot-check: run a handful of known-good and known-wrong scripts with vs without the reference solution; confirm fewer false "error" calls on correct lines.
- `tsc` clean; existing maths E2E still green.

### Done — Phase 1 (2026-06-21, uncommitted)
- **Migration `scripts/maths-worked-solution-migration.sql` NOT yet run in Supabase.** ⚠️ Must run before deploy — `handleCreate` inserts the `worked_solution` column, so task creation will error until the column exists.
- `api/task.ts`: accepts `worked_solution` on create + update (maths-only, null otherwise); **stripped unconditionally for all non-owners** (`if (!isOwner) delete payload.worked_solution`, line ~91) — hardest guarantee, not gated on graded status.
- `prompts/maths-system.ts`: `buildMathsPerLineUserPrompt` injects the fenced `REFERENCE SOLUTION` block; the diagnostic system prompt gained the reference-solution rule (source-of-truth for correctness, **credit valid alternative methods**, never reveal).
- `api/generate-maths-feedback.ts`: reads `task.worked_solution`, passes it to Pass B, **guards the Lesson-Differentiator re-skin case** (`questionWasReskinned` → null, since the base solution wouldn't match a re-skinned question).
- `public/new-task.html`: "Worked solution (optional · hidden from students)" textarea in Step 3, maths-only, wired into the create payload.
- Verified: `tsc` clean; prompt-render smoke (block present with a solution, absent without, no-leak + alt-method rules in the system prompt); leak audit — `worked_solution` appears in no student surface or read path.
- **Not wired:** the silent Haiku insights pass (`submit-for-marking` → marked/quick maths) doesn't use the worked solution yet — only the `feedback_task` Pass B does. And `new-task.html` is create-only, so there's no edit-existing UI for the field yet (consistent with `marking_guideline`).

---

## Open questions

1. **Phase-2 verification approach** — prompt-anchor only (Phase 1) may be enough; if not, which deterministic engine (math.js / sympy service / tool-use compute)?
2. **Device reality at pilots** — **DECIDED 2026-06-21: photo-first.** #3 capture builds on photo upload + Claude vision (universal across phones/laptops/tablets); on-screen canvas / stylus-SDK is a later v2 if pilot device reality warrants it.
3. **Reveal the worked solution to students post-grading?** Default off in v1; genuinely useful as a "model solution after marking" — separate product call.
4. **Keep all three typed modes, or collapse to Type-only at #3** once handwriting is primary?

## Explicitly out of scope (for now)
- Redrawing/vectorising diagrams (carry the image through instead).
- Conversational / Socratic follow-up (tension with the "we mark, we don't tutor" positioning — separate discussion).
- A paid handwriting SDK (MyScript/iink) — only if pilot device reality is iPad+Pencil and photo/canvas proves insufficient.
