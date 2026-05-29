# Maths feedback — strategy & build plan

**Goal:** Ship HSC Mathematics feedback that is unambiguously better than any existing AI tool (Photomath, Mathspace, Khanmigo, Wolfram, ChatGPT, Symbolab) and good enough that an experienced HSC Maths teacher would recognise it as their own marking voice.

This is not a "support another subject" task. The whole feedback architecture has to change: input modality, the unit of analysis, the marking rubric, the error model, the calibration data. This doc lays out what's hard, what competitors get wrong, and the build path.

Central design question (unchanged): **"How can we get the most accurate possible feedback to mimic that of a professional, experienced HSC Mathematics teacher?"**

---

## 1. Why generic AI maths feedback is bad

A senior HSC Maths marker doesn't grade the *answer*. They grade the *method*. ChatGPT et al. do the opposite — they verify the final answer and offer corrections. That's tutoring, not marking. Every popular tool fails one of the following:

| Tool | What it does | Why it fails as HSC feedback |
|---|---|---|
| Photomath | Solves the problem step-by-step | Solves *for* the student. Doesn't read their working. No NESA rubric. |
| Wolfram Alpha | Symbolic answer + steps | Same — provides a model solution, not feedback on student work. |
| ChatGPT / generic LLM | Conversational tutoring | Hallucinates marker conventions. Will award marks the student wouldn't get. Won't catch notation slips. Often skips to "the answer is…". |
| Mathspace | Adaptive practice w/ hints | Question-bank product. Not draft feedback on student-authored working. |
| Khanmigo | Socratic tutor | Doesn't read working at all. Asks the student leading questions. |
| Symbolab / Microsoft Math | Step solvers | Same failure mode as Photomath. |

**The gap:** nobody reads the student's actual working, line by line, against the actual NESA marking conventions, and tells them where they would lose method marks. That's the product.

---

## 2. What an experienced HSC Maths marker actually does

This is the calibration target. Synthesised from NESA's Notes from the Marking Centre across Mathematics Standard 2, Advanced, Extension 1, and Extension 2 (2021–2024) — and from what every senior HSC Maths teacher actually flags.

### 2.1 The marking schema
HSC Maths marking is **per-step**, not per-answer:

- **Method marks (M)** — for choosing a valid approach and setting it up correctly.
- **Accuracy marks (A)** — for executing each step without error.
- **Final-answer marks** — sometimes, but secondary to method.
- **Follow-through credit** — if a student makes an early arithmetic error but their subsequent method is consistent with that error, they don't lose subsequent marks. AI tools never apply this — they cascade the error as wrong.
- **Communication / justification marks** — for proofs, "show that", and Ext 1/2 problems. Marks awarded for justification *as well as* correctness.

### 2.2 The recurring marker comments (across NESA Notes 2021–2024)
- "Many candidates omitted the constant of integration."
- "Candidates need to show all working, particularly when a 'show that' or 'prove' question is asked."
- "A common error was incorrect application of the chain rule when…"
- "Candidates frequently confused…" (notation, sign, domain restriction)
- "Better responses included a diagram with all relevant information labelled."
- "Many candidates did not state the conditions under which their answer applied."
- "Candidates should not jump from one line to another without justification."
- "Approximations should not be used in exact-value questions."
- "Final answers should be presented in simplest form."
- "Candidates wasted time finding a value that was not asked for."

### 2.3 What good handwritten working looks like at HSC level
- Each line follows from the one above by **exactly one** transformation.
- Equality signs are used only between equal expressions (not as "next line" punctuation).
- Setup is labelled: "Let x = …", "Let θ be the angle between…".
- Diagrams labelled with given values and constructed values.
- "Therefore" / `∴` used to mark a conclusion.
- Final answer boxed or stated in a complete sentence ("The probability is 7/12.").
- Exact values vs decimal approximations handled correctly.
- Units present where appropriate (applied questions).

### 2.4 Where students lose marks
Roughly in descending order of frequency:
1. **Skipping working** on "show that" / "prove" questions. The answer is *given*; marks are entirely for the working.
2. **Equals-sign abuse** — using `=` to mean "next line" between non-equal quantities.
3. **Notation slips** — `∫` without `dx`, missing `+C`, missing absolute value bars on `ln`, missing domain on inverse trig.
4. **Algebraic execution errors** that the marker can identify by category (sign error, distribution error, index law error).
5. **Misreading the directive verb** — "Find the value of" vs "Show that" vs "Prove" vs "Hence find" (Hence = must use previous part).
6. **Not interpreting the answer in context** (applied / financial / mechanics problems).
7. **Diagrams unlabelled** or absent when they would clarify the setup.
8. **Wrong level of precision** — exact when decimal was asked, or vice versa.
9. **Not stating restrictions / domains / conditions.**
10. **Inefficient method** — taking a brute-force path when the question hints at a clean one (especially Ext 1/2).

These ten categories are the spine of the maths feedback tool. Every piece of generated feedback should attach to one of them, with a fallback "other notation" / "other method" bucket.

---

## 3. The input problem (the hardest part)

ProofReady today is built around typed prose with paste blocked. None of that maps to maths:
- HSC students write maths by hand. They will not type LaTeX during a study session.
- A typed text box can't capture diagrams, fractions, or working layout.
- Mathpix-style OCR exists but isn't free, and student handwriting OCR is still error-prone.

There are three plausible input modalities. We will need all three over time, in this order:

### 3.1 Photo upload (MVP — the only modality that survives contact with reality)
- Student takes a photo (or photos) of their handwritten working.
- We send it to **Claude Sonnet 4.6 (vision)**, which has materially improved at reading handwritten maths through 2025 and is already in our stack.
- The model returns a **structured transcription**:
  ```
  {
    "steps": [
      { "line": "Let f(x) = 3x^2 + 2x", "interpretation": "definition", "issues": [] },
      { "line": "f'(x) = 6x + 2", "interpretation": "derivative", "issues": [] },
      { "line": "6x + 2 = 0  →  x = -1/3", "interpretation": "stationary point", "issues": ["no working shown for division by 6"] },
      ...
    ],
    "diagrams": [{ "description": "...", "labelled": false }],
    "final_answer_stated": true,
    "final_answer_text": "x = -1/3"
  }
  ```
- The transcription is the substrate for feedback. We show the transcription to the student and ask them to confirm before generating feedback — this turns OCR misreads into a teaching moment ("the model couldn't read this line — is your working clear enough that a marker could?").

### 3.2 Math-aware typed input (post-MVP)
- Embed an open-source math editor (KaTeX-rendered, with palette buttons for fractions / integrals / sigma / matrices). Candidates: **MathLive** (open-source by Khan Academy), **MathQuill**.
- Render student input as LaTeX → already structured.
- Use for "type up your working" mode — clean, but high friction for long questions.

### 3.3 Apple Pencil / stylus capture (long-term)
- Native handwriting capture in a web canvas, with stroke data sent for handwriting recognition.
- Cleanest UX on iPad. Not the MVP.

---

## 4. The feedback architecture for maths

The current three-pass feedback architecture (holistic / criterion-by-criterion / inline) is broken for maths. Replace it with a **four-pass per-question** architecture:

### Pass A — Transcription confirmation (vision)
- Reads the photo, returns structured steps + diagram metadata.
- Renders LaTeX back to the student for visual confirmation.
- Failure mode is benign — if the model misreads, the student fixes it before Pass B.

### Pass B — Per-step diagnostic (the load-bearing pass)
- Walks the transcription line by line.
- For each line, asks: does this line follow from the previous one? Is the transformation valid? Is notation correct?
- Returns a typed annotation per line: `{ line_index, status: "ok"|"slip"|"error"|"justification_missing", category, comment }`.
- Categories drawn from the ten error types in §2.4.
- Critically: applies **follow-through credit**. If line 3 has a sign error and line 4 correctly continues from that wrong value, line 4 is `ok`, not `error`.

### Pass C — Holistic marker comment
- Reads the whole solution + the diagnostic annotations.
- Produces the same shape as current `holistic_feedback`: `what_youve_done_well`, `improvements`, `top_priority`, `task_verb_check`.
- Verb check is critical for maths: "Hence" / "Show that" / "Prove" / "Find" / "Evaluate" all have specific meanings in HSC.
- Marker voice calibrated against NESA Notes from the Marking Centre (Maths Standard 2 / Advanced / Ext 1 / Ext 2, 2021–2024 — needs scraping, see §6).

### Pass D — Method efficiency (Ext 1 / Ext 2 only, optional)
- For higher-level questions: was there a cleaner method? Without telling the student the answer, hint at it: "There's a substitution that simplifies this integral significantly. Look at the form of the denominator."
- Skipped for Standard 2 / Advanced unless the question explicitly invites elegance.

### What we don't do
- **No worked solutions.** Same product rule as essays — we do not provide the answer or rewrite the working. We diagnose. This is the differentiator vs Photomath.
- **No mark predictions.** Same hard rule.
- **No partial answer leaks.** When a student is one step from the answer, Pass C cannot inadvertently complete it for them. Prompt-level guardrail.

---

## 5. Rubric model for maths

Maths rubrics in HSC are not the prose-style criterion lists ProofReady currently parses. They are:

- **Per-question mark allocations** (Q5 = 4 marks, Q6 = 7 marks).
- **Marking guidelines per question** — internal NESA marker schemas like:
  ```
  Q6 (7 marks)
  • Correctly differentiates the function (1)
  • Sets derivative to zero and solves (1)
  • Determines nature of stationary points (1)
  • Calculates y-coordinates (1)
  • Evaluates endpoints (1)
  • States absolute max/min in context (1)
  • Justifies with second-derivative or sign table (1)
  ```

Two implications for ProofReady:
1. The teacher's task setup needs a "maths task" mode where they paste per-question marking guidelines (or NESA-published ones for past papers).
2. The criteria rubric parser (`parseRubricWithAI` in `api/task.ts`) needs a maths branch that recognises mark-allocation lines rather than band descriptors.

For teacher-created practice tasks where no formal rubric exists, we can offer a "generate marking guidelines" button that proposes one — same UX as the existing "Generate marking criteria" button on `new-task.html`, but maths-aware.

---

## 6. Calibration data needed

The competitive moat for essay subjects is `data/nesa-marking-feedback/*.json` (NESA Notes from the Marking Centre scraped per subject). We don't have those for maths yet. Required:

### 6.1 Scrape NESA Notes from the Marking Centre — Maths
Years 2021–2024 for:
- Mathematics Standard 2
- Mathematics Advanced
- Mathematics Extension 1
- Mathematics Extension 2

Use the existing `scripts/scrape-nesa-feedback.ts` as the template. Maths Notes are structurally different — they're organised by question number, with marker observations per question. Each entry needs `{ question, marks_available, common_errors[], better_responses[], examples_of_low_quality[] }`.

### 6.2 NESA Reference Sheet
The HSC Maths Reference Sheet (formulas provided in the exam) must be loaded into prompt context so the model doesn't penalise students for using formulas that are provided, and so it can flag when a student has derived something the reference sheet gives them.

### 6.3 Syllabus outcomes
Same shape as `data/pdhpe-stage6.ts` and `hms-stage6.ts`, for each of the four Maths courses. Outcomes drive the per-task outcome chips and the longitudinal student profile.

### 6.4 Notation conventions
A short reference doc on HSC notation conventions (∫…dx not ∫…, `+C`, `ln|x|`, domain restrictions on inverse trig, exact-vs-decimal). Injected into Pass B.

### 6.5 Common error taxonomy
The ten categories in §2.4 formalised as an enum the model returns, so we can build cohort cards on "this class is consistently missing constants of integration".

---

## 7. Insights for maths (cohort + student)

This is where the product wins long-term. The current insights system aggregates feedback themes into cohort cards. For maths, the cards write themselves once Pass B returns categorised errors:

- **Top method errors this week** — "8 of 24 students dropped the constant of integration in Q4."
- **Notation drift** — "Equality-sign misuse is up across Year 12 Advanced this fortnight."
- **Verb misreads** — "Of 18 students attempting Q7, 11 wrote `find` answers when the verb was `show`."
- **Diagram discipline** — "5 students attempted Q3 (mechanics) without a labelled diagram."

These are categorically more useful than the essay-side cards because the categories are objective. A maths teacher sees them and immediately knows what to reteach Monday.

Per-student profile additions: **method-mark efficiency** (% of method marks captured per question attempted), **notation discipline score** (longitudinal trend), **verb-direction adherence**.

---

## 8. Architecture changes (concrete)

### 8.1 Data model
- `tasks.subject_type` — new column, enum: `essay` (default — current behaviour) | `maths`. Drives the entire downstream branch.
- `tasks.marking_guidelines` (jsonb) — maths-mode equivalent of `criteria_text`. Per-question mark allocations.
- `submissions.input_modality` — `typed` | `photo` | `latex`.
- `submissions.transcription` (jsonb) — Pass A output (structured steps + diagrams).
- `submissions.step_diagnostics` (jsonb) — Pass B output (per-line annotations + categorised errors).
- `submissions.images` (text[]) — Supabase Storage URLs for uploaded photos.

### 8.2 New API endpoints
- `POST /api/transcribe-working` — Pass A (vision). Returns transcription.
- `POST /api/diagnose-working` — Pass B. Takes transcription + question + marking guidelines, returns step diagnostics.
- `POST /api/generate-maths-feedback` — Wraps A → B → C → (D) and writes to `submissions.feedback`. Branches off `tasks.subject_type === 'maths'` instead of the current three-pass essay flow.

### 8.3 New prompts (`prompts/maths/`)
- `transcription-system.ts` — vision system prompt with notation rules + "transcribe verbatim, don't correct".
- `step-diagnostic-system.ts` — the load-bearing prompt. Follow-through rules, error taxonomy enum, no-completion guardrail, NESA notation conventions.
- `maths-holistic-system.ts` — like the essay holistic prompt, but with maths marker voice + verb taxonomy (Find / Show / Prove / Hence / Evaluate / Justify).
- `method-efficiency-system.ts` — Pass D for Ext 1 / Ext 2.

### 8.4 New UI surfaces
- **`submit-maths.html`** — separate submission flow (or branched `submit.html`). Components:
  - Photo upload (drag/drop + camera capture)
  - LaTeX-rendered transcription preview (KaTeX in browser)
  - "Looks right?" confirmation step before Pass B fires
- **`feedback-maths.html`** — separate feedback view:
  - Student's transcribed working on the left with per-line annotation chips
  - Holistic marker comment on the right
  - Verb-check + top priority + things done well at the top
  - No worked solution shown anywhere

### 8.5 Reuse
- Rate limiting, auth, schools/insights scope, task lifecycle — all reused. The maths branch is contained inside the feedback-generation layer.
- Teacher marking UI on `mark-submission.html` — extend to render the LaTeX transcription + per-line annotation tool. Reuse the existing annotation data model (`teacher_annotations` jsonb) but anchor to `line_index` instead of text offsets.

---

## 9. MVP scope (8–10 weeks of focused build)

The smallest cut that is **demonstrably better than every competitor** for one HSC Maths course:

1. **Course: Mathematics Advanced** (largest cohort; Rob teaches PDHPE, but Advanced is the broadest test).
2. **Modality: photo upload only.** No typed/LaTeX input in MVP.
3. **Calibration data:** scrape Maths Advanced Notes from the Marking Centre 2021–2024. Load reference sheet + syllabus outcomes.
4. **Feedback passes:** A (transcription) + B (per-step diagnostic) + C (holistic). No Pass D in MVP.
5. **Teacher rubric input:** free-text marking guidelines, parsed by a maths-aware variant of `parseRubricWithAI`.
6. **Teacher marking UI:** read-only of Pass B annotations in MVP. Full per-line annotation tool in v2.
7. **Insights:** ship `Top method errors this week` and `Notation drift` cohort cards for the cohort dashboard. The other essay cards work unchanged on whatever holistic content Pass C produces.

### Out of scope for MVP
- Diagram quality assessment beyond "labelled / not labelled".
- Stylus input.
- Apple Pencil app.
- Standard 2, Ext 1, Ext 2 (next four months).
- Multi-page handwritten responses with cross-references between pages.

---

## 10. Risks & open questions

- **Vision OCR error rate on handwritten Maths.** Needs a benchmark run on ~50 real Year 12 scripts before committing. If misreads exceed ~15% per page, MVP needs an LaTeX-typed fallback as well.
- **Follow-through credit logic.** Hardest prompt-engineering problem in the build. May need a deterministic checker (rerun student's stated answer through their stated method) layered onto Pass B.
- **Latency.** Pass A vision + Pass B step-by-step + Pass C will not parallelise the way the essay passes do (B depends on A). Realistic wall-clock: 30–60s per submission. Acceptable for drafts but a long way from the essay flow's UX.
- **Cost.** Vision tokens are expensive. Per-submission cost likely $0.30–$0.50 on Sonnet 4.6. Compare to ~$0.10–0.20 for essays. Rate-limit + per-task-mode pricing tiers to plan.
- **"Show that" exploitation.** If the answer is given in the question, a model can be tempted to award method marks the student didn't earn. Pass B prompt must explicitly verify each step rather than backward-reasoning from the given answer.
- **NESA copyright on past-paper questions.** Teachers will paste HSC past-paper questions into ProofReady. Internal use is fine, but if we surface past-paper questions inside marketing or shared insights, we need to launder them. Same posture as the essay tool.

---

## 11. Why this beats everyone

When a Year 12 Advanced student photographs their working and gets back:

> Line 3 — you've used `=` to mean "next line". The expressions on either side aren't equal. Use `=` only between equal expressions, or break the line.
>
> Line 5 — you've integrated `1/x` as `ln(x)`. NESA wants `ln|x|`. You'll lose a mark here.
>
> Line 7 — you've found `x` but the question asked for the value of `f(x)`. Re-read the question.
>
> Verb check — the question said *Show that*. You've worked towards an answer but haven't shown that the result equals the stated value at the end. Add a concluding line.
>
> Top priority — show every step on "show that" questions. The answer is given. Marks come from working.

…that is recognisably the voice of a senior HSC Maths marker. No other tool produces it. That's the product.
