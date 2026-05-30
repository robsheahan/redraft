# Maths feedback — typed-input only (no photos, no paper)

**Constraint:** Students do all their maths work **in the browser**. No photographing of paper, no PDF uploads, no OCR. The student's typed input is the only substrate the AI gets.

**Question:** Given that constraint, what input UX produces the highest-quality marker-style feedback, with the least friction, and (most importantly) lets us do something **no other tool does**?

This doc replaces sections 3, 4 and 9 of `maths-feedback-plan.md`. The marker-voice + NESA calibration sections (§§ 2, 5, 6) still apply unchanged.

---

## 1. Why the obvious answer is wrong

The obvious answer is "embed a math editor (MathLive / MathQuill) in a textarea, let students type LaTeX-via-palette, send the LaTeX to Claude for feedback."

That gets us to parity with no one and ahead of no one:

- Friction is high for long working — clicking through fractions and integrals is far slower than handwriting.
- Students hate it. They will pencil-and-paper the working, then transcribe the *final answer* into the box and treat us as a glorified answer-checker.
- The AI gets a string of LaTeX with no semantic structure: it has to reverse-engineer what each line *was for*, which is exactly where ChatGPT-style maths feedback already gets confidently wrong.
- We end up competing with Photomath on the wrong axis.

So a math editor on its own is necessary but not sufficient. The unlock is in the **structure** we wrap around it.

---

## 2. Input-modality candidates (friction vs value)

Eight options, scored against four things: **friction** (how painful is typing the working?), **fidelity** (does the AI see enough to give marker-level feedback?), **pedagogy** (does the input modality itself teach good habits?), and **novelty** (does any competitor do this?).

| Option | Friction | Fidelity | Pedagogy | Novelty | Verdict |
|---|---|---|---|---|---|
| **A. Plain MathLive editor (one big textarea)** | High | Low–mid | Low | Zero | The obvious answer. Reject. |
| **B. AsciiMath / plain-text math** (`x^2 + 3/4 sin(theta)`) | Mid | Low | Low | Low | Saves a few keystrokes vs A. Still semantically thin. |
| **C. Mixed prose+math** (markdown-with-inline-`$...$`) | Mid | Mid | Mid | Low | Closer to how scribbled working actually reads. Useful for written justification but doesn't force structure. |
| **D. Step-slot scaffolding** (UI generates 4–7 empty step boxes from the question) | Low | High | Mid | Mid | Risk: prescriptive — narrows legitimate alternative methods. Tutoring vibe. |
| **E. Voice input** ("x squared plus three over four…") | Low (in theory) | Low | Low | High | Brittle in classrooms, parser tax, demo-quality not production. |
| **F. Stylus on canvas → handwriting-recognition** | Very low (on iPad) | High | High | High | Technically not "paper" or OCR, but adjacent enough that I'm flagging the question. Best-in-class if available. |
| **G. Calculator-with-provenance** (CAS-lite that logs every operation) | Low | Mid | Low | Mid | Drifts into tutoring. Doesn't capture *reasoning*. |
| **H. "Line + reason" hybrid** (per line: math editor + 1-sentence justification) | Mid | **High** | **High** | **High** | **Recommended.** Explained below. |

The interesting candidates are **H** (recommended), **C** (good lower-friction fallback) and **F** (best UX if stylus is on the table).

---

## 3. The recommendation: "Line + reason" input

The single most undervalued insight about HSC maths marking is that **method marks are awarded for picking the right move, not for executing it**. NESA's Notes from the Marking Centre repeatedly say the same thing: candidates who showed *why* they took a step, even when their algebra was wrong, picked up more marks than candidates who blasted to the right answer without justification.

No competitor takes that seriously. Every existing tool reads the maths and ignores the prose.

So make the prose first-class. Every line of working is a pair:

```
┌──────────────────────────────────────────────────────────┐
│  f'(x) = 6x + 2                              [math]      │
│  Differentiating using the power rule.       [reason]    │
└──────────────────────────────────────────────────────────┘
```

The student adds lines as they work. Each line is `{ math, reason }`. The reason is a short typed sentence — *why* this step, *which rule*, *which substitution*.

### Why this is the right answer

**(a) It cuts friction in half.** The student no longer has to type every intermediate algebraic step — they can write `(by the chain rule)` and skip to the result. This is what mathematicians actually do on paper in margins; we're just making it the primary surface.

**(b) It maps directly to NESA marking.** Method marks ≈ reason field. Accuracy marks ≈ math field. The AI can score each axis independently and surface them in the feedback — "your method is sound on every step; your algebra slipped on line 3" is the marker-voice we're aiming for.

**(c) It teaches communication.** NESA explicitly awards marks for "clear communication of mathematical reasoning". Working-with-reasons is a habit weak students don't have. Making the input modality require it is a pedagogical free lunch.

**(d) It makes the AI's job dramatically easier.** With LaTeX-only input the model has to guess intent ("was this a substitution? a simplification? a sign error followed by accidental cancellation?"). With reasons attached, intent is declared by the student. This is the difference between speculative and accurate diagnosis.

**(e) It is genuinely novel.** I can't find any AI maths tool — Photomath, Wolfram, Mathspace, Khanmigo, ChatGPT, Symbolab — that takes the student's *stated reasoning* alongside their working and evaluates both. It's an obvious idea in retrospect, which is the best kind.

### What the input UI looks like

```
[Question shown at top]

┌─ Line 1 ─────────────────────────────────────────────────┐
│  Let f(x) = 3x² + 2x                                     │  ← math field (MathLive)
│  Defining the function.                                  │  ← reason field
└──────────────────────────────────────────────────────────┘
                          [ + Add line ]
┌─ Line 2 ─────────────────────────────────────────────────┐
│  f'(x) = 6x + 2                                          │
│  Differentiating using power rule.                       │
└──────────────────────────────────────────────────────────┘
                          [ + Add line ]
┌─ Line 3 (final answer) ──────────────────────────────────┐
│  x = -1/3                                                │
│  Solving f'(x) = 0 for the stationary point.             │
└──────────────────────────────────────────────────────────┘

[ Submit for feedback ]
```

Math input via **MathLive** (Apache-licensed, KaTeX-rendered, has keyboard shortcuts for `/` → fraction, `^` → superscript, `_` → subscript, `sqrt` → √, etc.). After a half-hour of use, fast students bypass the palette entirely and type at typing speed.

Reason field is a plain `<input type="text">`. Optional but heavily encouraged — every empty reason field shows a faded prompt ("why this step?"). When a student tries to submit with empty reasons, a soft warning: "Your reasoning is what earns method marks. Add a one-sentence reason to each line — even just 'differentiate' or 'substitute x=2'."

### Reducing friction further

Three escape hatches so we don't punish fluent students:

- **"Freeform mode"** — toggle that turns the whole input into a single MathLive textarea. The student types one big string of math (with optional inline `[reason: …]` annotations). On submit, an extra pre-pass (cheap Haiku call) splits it into the same `{ math, reason }` structure for the diagnostic pipeline. Power users get speed; the data model stays uniform.

- **"Snap from clipboard"** — paste a block of half-formatted working (from a notes app, from a previous attempt) and the same Haiku splitter restructures it. Note: this is the *only* place paste is allowed in the maths flow; it's structurally different from prose-essay paste (we're parsing, not accepting) so the typed-only rule isn't violated in spirit.

- **Keyboard-first navigation** — Tab between math/reason, Enter to add a new line, Cmd-Enter to submit. No mouse needed.

---

## 4. Novel angle 2: mark-allocation-aware scaffolding

When the teacher sets the task, they paste a marking guideline — same UX as the current criteria field, but for maths it looks like:

```
Q6 (7 marks):
- Differentiates the function (1 mark)
- Sets derivative to zero and solves (1 mark)
- Determines nature of stationary points (1 mark)
- Calculates y-coordinates (1 mark)
- Evaluates endpoints (1 mark)
- States absolute max/min in context (1 mark)
- Justifies with second-derivative or sign table (1 mark)
```

ProofReady parses this into a list of expected method steps. **The student doesn't see them.** But:

1. **Pre-submit diagnostic.** On submit, the AI cross-references the student's `{ math, reason }` lines against the expected method steps. If the student skipped a mark-bearing step ("you didn't justify the nature of the stationary points"), it's flagged in the feedback — without telling the student which mark they missed.

2. **Verb-aware framing.** "Show that" + "Hence" + "Prove" + "Evaluate" each have specific NESA conventions. We extract the directive verb from the question (already do this for essays) and gate the diagnostic on it: "Show that" with the answer given in the question → marker expects every step shown → AI strict on "step skipped" detection.

3. **Teacher AI-assist.** If the teacher pastes only the question with no marking guideline (in-class practice scenario), we offer a `[ Generate marking guideline ]` button — same UX as `[ Generate criteria ]` for essays today. The AI proposes a NESA-style mark allocation the teacher can edit.

---

## 5. "Talk-through" mode for low-stakes practice

For **Quick tasks** (the lightweight ProofReady mode that doesn't count toward marks), offer a third input mode alongside structured-lines and freeform:

> Type your working as prose. Include the maths inline with `$...$`. Explain as you go.

Example student input:

> *"I want to find the stationary points of $f(x) = 3x^2 + 2x$. Differentiating gives $f'(x) = 6x + 2$. Setting that to zero, I get $x = -1/3$. That's a minimum because the coefficient of $x^2$ is positive."*

The AI evaluates both the maths (parses the `$...$` segments) and the prose reasoning together. Friction is very low; output fidelity is mid-high; it's a much better experience for a student doing 5 quick exam-prep questions in 20 minutes than fighting a math editor.

For high-stakes assessment tasks we'd default to structured-lines (because we need the per-step structure for marking guideline alignment); for low-stakes practice, talk-through wins on UX.

---

## 6. The flag in the room: stylus input

You said "no paper, no images." Stylus on a web canvas (Apple Pencil on iPad in Safari, or a Wacom on a laptop) is technically *neither* — it's stroke data, captured and recognised in real time, never rasterised. The student's "input" is a sequence of vectors, not a photo.

If iPad-in-the-classroom is realistic for your pilot cohorts, this is the best possible UX: as natural as paper, no editor friction, no OCR risk. Libraries that do this well in 2026: **MyScript Web SDK** (commercial, very accurate on maths handwriting), or **iink** (their newer offering). Both render LaTeX live as the student writes.

I'm not building this in MVP because (a) you said no images and stylus is adjacent; (b) commercial SDK pricing is non-trivial; (c) Safari iPad coverage is good but not universal.

**Question to come back to:** do you want stylus as a v2 modality, or is the typed path the whole product?

---

## 7. Revised three-pass architecture

Replaces section 4 of `maths-feedback-plan.md`:

### Pass A — Structure resolution (cheap Haiku)

Only runs when the student used Freeform or Talk-through mode. Converts the freeform input into the canonical `{ lines: [{ math, reason }, …], final_answer }` shape. For structured-lines mode, this pass is skipped — the data is already structured.

Failure mode is benign: if Haiku misreads the split, the student fixes it in a confirmation step. (Same UX as our existing rubric-parse confirmation in `parseRubricWithAI`.)

### Pass B — Per-line diagnostic (Sonnet, load-bearing)

Walks each line and, for each one, evaluates **both**:

- **Math correctness** — does this line follow algebraically from the previous? Is notation right? Is the step the student's reason claims it is?
- **Reasoning quality** — does the stated reason match the step taken? Is the reason a recognised mathematical move? Is the directive verb in the question being addressed by this line?

Returns `{ line_index, math_status, reason_status, category, comment }`. Categories from the error taxonomy (see `maths-feedback-plan.md` §2.4) plus three reason-specific ones:

- `reason_missing` — student didn't write one
- `reason_mismatch` — reason says "differentiate", math shows integration
- `reason_imprecise` — reason is vague ("simplify"); we want the specific rule

Plus one verb-aware category:

- `verb_mismatch` — the line answers a different question to the one asked (e.g. states stationary points when the question asked for absolute extrema; finds a value when the question said "show that").

Critically: **applies follow-through credit**. Line 4 that correctly follows from a wrong line 3 is `math_status: ok_following_through`, not `error`.

Cross-references against the parsed marking guideline (§4) to detect skipped mark-bearing steps. Surfaces those as `category: step_missing` chips inserted *between* lines in the rendered output.

### Pass C — Holistic marker comment (Sonnet)

Returns three fields only: `what_youve_done_well`, `top_priority`, `improvements`. No separate verb-check section (verb misreads surface in the per-line annotations from Pass B instead). Calibrated against the NESA Maths Notes from the Marking Centre (still to scrape — see `maths-feedback-plan.md` §6).

### What we still don't do

- **No worked solutions.** Hard product rule, same as essay flow.
- **No mark predictions.** Hard product rule.
- **No completing the student's working.** The model is prompt-guarded against finishing the next step when the student is one away from the answer.

---

## 8. Comparable strengths vs each competitor

| Tool | What they do | What we do that they don't |
|---|---|---|
| Photomath / Symbolab | Solve the problem step-by-step | We don't solve — we diagnose the student's own steps |
| Wolfram Alpha | Symbolic answer + working | Same — we leave the answer to the student |
| ChatGPT | Conversational tutoring, hallucinates marker conventions | NESA-calibrated, marker-voice, no hallucinated marks |
| Mathspace | Adaptive practice on canned questions | Works on student-authored working for teacher-authored questions |
| Khanmigo | Socratic tutor | We don't tutor; we mark like an experienced HSC teacher |
| Every existing tool | Reads symbols only | Reads symbols *and* the student's stated reasoning, evaluates both |

The last row is the moat.

---

## 9. MVP cut (typed-only)

10–12 weeks of focused build, targeting Mathematics Advanced:

1. **Math editor:** MathLive embedded into ProofReady. Keyboard-first.
2. **Input mode:** structured-lines (default), freeform (toggle), talk-through (Quick tasks only).
3. **Data model additions:**
   - `tasks.subject_type` enum: `essay` (current) | `maths`
   - `tasks.marking_guideline` jsonb — parsed step list with mark allocations
   - `submissions.working_lines` jsonb — `[{ math: latex, reason: text }, …]`
   - `submissions.input_mode` text — `structured` | `freeform` | `talkthrough`
4. **API:**
   - `POST /api/parse-marking-guideline` — teacher tool, AI-assists writing the per-step mark schema
   - `POST /api/structure-working` — Pass A (Haiku), called only for freeform/talkthrough modes
   - `POST /api/generate-maths-feedback` — Passes B + C, branches off `tasks.subject_type === 'maths'`
5. **UI:**
   - `submit-maths.html` — structured-lines surface (or branch in submit.html)
   - `feedback-maths.html` — single view: holistic comment + top priority + improvements at top, student's working with inline per-line annotations below
   - `new-task.html` — subject-type picker, marking-guideline input, "generate marking guideline" button
6. **Calibration data:** scrape NESA Maths Notes from the Marking Centre 2021–2024 (Standard 2 / Advanced / Ext 1 / Ext 2). Load the Reference Sheet + Advanced syllabus outcomes.
7. **Teacher marking UI:** reuse `mark-submission.html`. Add a per-line-annotation tool anchored to `line_index` instead of text offsets. Teacher sees `{ math, reason }` rendered side-by-side per line, marks per the marking guideline.
8. **Insights cards** (free win once Pass B returns categorised errors):
   - Top method errors this week
   - Top reasoning errors this week (reason_missing / reason_mismatch)
   - Notation drift
   - Verb misreads this week (verb_mismatch)

### Out of scope for MVP
- Diagrams (graphs, geometry). v2 with a `<canvas>` sketch surface + drawing tools.
- Multi-part questions with cross-references (Q5 (i), (ii), (iii) where (iii) uses (i)'s answer). v2.
- Stylus input. v2 decision pending §7.
- Other Maths courses (Standard 2, Ext 1, Ext 2). Sequential after Advanced is proven.

---

## 10. Open questions for you

1. **Stylus input** — is iPad-in-the-classroom a realistic v2, or is typed the whole product? (Materially changes whether we license MyScript or stay pure-typed.)
2. **Freeform vs structured default** — I've defaulted assessment tasks to structured-lines. Confirm? Some teachers might want freeform always because they trust their students to type cleanly.
3. **"Generate marking guideline" button** — same trust model as the essay rubric generator? I.e. AI proposes, teacher always edits before publish? (Yes is my default.)
4. **Pilot subject** — Advanced is the widest cohort but you're a PDHPE teacher. Would you rather start with Standard 2 because the entry-point is friendlier, or Advanced because it's the demo a head of maths cares about?
5. **Pre-commit math editor choice** — MathLive (Apache, Khan Academy, well-maintained), MathQuill (MIT, smaller community, older), or KaTeX-with-custom-input-layer (lightest, most work)? My default is MathLive.

---

## 11. The one-paragraph pitch

When a Year 12 Advanced student opens ProofReady, they see the question and a stack of empty lines. Each line is two fields: the maths, and a one-sentence reason. They work through the problem the way a confident student does — symbols on the left, justification on the right. They submit. In 30 seconds they get back a per-line diagnostic that scores method and accuracy separately, applies follow-through credit on consequential errors, flags the step they skipped that NESA expects shown, and calls out where their stated reasoning didn't match the move they made. None of it gives away the answer. All of it sounds like a senior HSC marker. **That is the product, and no one else is shipping it.**
