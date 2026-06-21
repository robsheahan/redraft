# HSC Mathematics corpus — findings & workflow guidance

Analysis of 33 NESA HSC Mathematics documents (2019–2025; Standard 1/2, Advanced, Extension 1/2) pulled into `HSC Maths Resources/` (gitignored — local only). Three document types: **exam papers** (what students do), **marking guidelines** (how marks are allocated), **Notes from the Marking Centre / marking feedback** (what markers observe). This doc synthesises how they sit with ProofReady's maths workflow and what to improve.

> **The single biggest finding:** the marking-feedback PDFs **are** the "NESA Notes from the Marking Centre" that our marker-voice prompts were always meant to be calibrated on — and which `docs/maths-typed-input-plan.md` §11 deferred because NESA publishes them as PDFs the HTML scraper couldn't reach. We now have the data. The calibration loader (`data/marker-voice-loader.ts`) is wired but unpopulated for maths; this corpus populates it.

---

## 1. What the corpus VALIDATES about our setup

- **Marker voice & hard rules — exactly right.** NESA never grades the person, never predicts a mark/band, never uses praise/blame adjectives. It describes what *responses* did. Our no-marks/no-bands/marker-voice rules match authentic practice 1:1.
- **The holistic structure maps onto NESA's two fixed frames.** Every feedback doc uses: *"In better responses, students were able to: …"* (action-verb clauses) and *"Areas for students to improve include: …"* (gerund clauses). That is precisely our "what you've done well / improvements" split.
- **Error-category enum ~80% confirmed.** `missing_constant` (+C, ln|x|), `method_choice`, `justification_missing`, `verb_mismatch`, `precision_wrong`, `premature_rounding`, `unit_missing`, `context_missing`, `domain_restriction_missing`, `notation_equals_abuse`, `algebra_*`, `arithmetic`, `variable_confusion` — all directly evidenced, many across every year/course.
- **Marking-guideline format ≈ our per-step field.** NESA's "one mark-bearing criterion per line" is exactly our marking-guideline model.
- **Worked solution = NESA's "Sample answer."** NESA pairs a teacher-facing **Criteria ladder** with a separate **Sample answer** (full solution) — identical to our hidden worked-solution + marking-guideline pairing.
- **Method vs accuracy is real and structural.** Lower criteria tiers reward method; the top tier requires accuracy. Matches our per-line method/accuracy split + follow-through.
- **"Hence" / multi-part is load-bearing.** ~13 explicit "Hence" + many "use your answer from part (a)" chains. Our multi-part + Hence-awareness is well-aimed.
- **M1–M6 taxonomy maps cleanly.** M5 (communication of working) is the **most-emphasised skill in the entire corpus** — validating `step_gaps` as first-class.

---

## 2. What students are expected to DO in a test → feedback + submission

### 2a. Calibrate the marker voice on the corpus (highest-ROI, unblocks the moat)
The voice to mimic, distilled from 11 feedback docs:
- **Two frames:** positive = action-verb clause; improvement = **gerund** ("showing all steps…", "rounding only at the final step…").
- **Concrete + contrastive**, never generic: *"5.5% increase is not 105.5%"*, *"the future value, not the interest"*, *"a z-score is not a probability"*. Name the *specific* misconception.
- **Quote command words** in single quotes and check comprehension of *'show'*, *'hence'*, *'derive'*, *'evaluate'*, *'not'*, *'respectively'* ("in the same order").
- **No marks, no bands, no praise.**
- **Reward order markers actually use** (course-invariant): (1) show all working / legible sequence, esp. "show" questions; (2) efficient method + connect parts via "Hence"; (3) precise language + correct notation; (4) substitution shown before evaluating; (5) check/validate + answer in context with a concluding statement; (6) use the mark count as a step-count guide.

### 2b. Extend the error-category enum (validated additions)
High-frequency errors common in the corpus but missing / poorly covered:
- **`transcription_error`** — miscopying a formula off the Reference Sheet, a table value, or dropping zeros in a big number. Very frequent, distinct from `arithmetic`.
- **`reference_sheet_misuse`** — failing to locate/use/copy the provided formula. Course-spanning.
- **`incomplete_answer`** — computes a value but never answers the actual question, or stops one step short (a *terminal* omission, distinct from `step_gaps`' *intermediate* omission).
- **`statistical_interpretation`** — the recurring z-score≠probability / slope≠correlation / extrapolation-unreliable cluster (currently jammed into `context_missing`).
- **Refine `precision_wrong`** to explicitly cover **sig-fig vs decimal-place** confusion (a distinct, perennial error).
- **`calculator_mode_error`** (radians/degrees) — frequent and genuinely its own thing.
- **Rename `verb_mismatch`** in concept to **command-word comprehension** (broader than a verb mismatch).

These also enrich the **"Maths errors by category"** insights card (#4) with the categories teachers most recognise.

### 2c. Encode the marker priority ordering into `top_priority`
The corpus shows a clear, course-invariant ordering of what costs marks (working → method choice → precision/rounding → units → +C/abs-value → not-answering). Encoding it into the single-priority selector makes ProofReady's "top priority" pick match how a marker triages.

### 2d. The submission-model ceiling (name it honestly)
An estimated **10–30% of Section II marks require non-typed outputs** we can't capture: graph/curve sketching, drawing/labelling diagrams (networks, probability trees, geometry), completing tables, region/number-line shading, annotating a provided figure. Hit hardest in **Standard 1/2 (~20–30%)**; lighter in **Advanced (~10–18%)** and **Extension (~8–15%)**, where the bulk is the algebra/proof spine we handle well.
- **Implication:** ProofReady is a **strong fit for the algebra/calculus/proof core** (most Advanced/Extension marks), a **partial fit for Standard 1/2** (more visual/table production).
- **Prerequisite even for line-only answers:** many questions say "read off the graph" / "from the diagram" — so **rendering a provided figure to the student** is needed before those are even authorable.

---

## 3. How teachers set up work/assessments → authoring

### 3a. Make "Generate marking guideline" emit NESA's authentic format
NESA's guideline is a **descending criteria ladder with cumulative marks**, not additive steps:
```
Criteria                                               Marks
• Provides correct solution                            3
• Finds the value of n, or equivalent merit            2
• Finds the correct values of a or d, or equivalent merit   1
Sample answer:
<full worked solution>
```
Concrete generator changes:
- Always **open with `Provides correct solution`** (multi-step) / `Provides correct answer` (one-step) at full marks, then descend; bottom tier = 1 mark; no zero row.
- Use NESA's **controlled verb vocabulary** for lower tiers (Provides, Finds, Calculates, Uses, Obtains, Applies, Identifies, Attempts, Establishes, Shows, Substitutes, Recognises).
- **Append `, or equivalent merit`** to partial-credit tiers — the highest-signal authenticity marker, and it operationally encodes follow-through (award the method tier for any equally-advanced approach).
- Name **concrete milestones** ("Finds the correct antiderivative"), never vague descriptors.
- For "show that"/"prove": top = `Provides correct proof`; partials reward progress toward the *given* target (and full working is mandatory — can't earn the top mark by restating the target). Induction has a stereotyped base-case / inductive-step / full-proof ladder.
- **Generate the guideline FROM the worked solution** so each criterion anchors to a step in it — produces internally-consistent ladders and supports accurate per-line marking + follow-through.

### 3b. Two-level part nesting `(a) → (i)(ii)(iii)`
Standard/Advanced are effectively flat `(a)(b)(c)` (our current model fits). **Extension routinely nests two levels** — our flat parts can't represent an Extension question faithfully (teachers would have to flatten and lose the marks structure). Add one level of nesting to author Extension as-written.

### 3c. MC + extended-response in one assessment container
Every real HSC paper mixes **Section I (10–15 MC)** with **Section II (extended)**. We have MC mode and extended/maths feedback as separate things; a faithful HSC-style paper needs both in one container.

### 3d. Provided figures + tables as stimulus
Most non-pure-algebra questions ship a figure (graph, network, geometry diagram, histogram, box plot) or a data table the student must read/annotate. Teachers need to attach a figure/table to a question or part as **first-class stimulus rendered to the student** (today's task attachments are inert/auxiliary). This also overlaps with the #3b photo-authoring pipeline (snap the figure, carry it through).

### 3e. Answer-length-per-mark cue
NESA scales the printed answer space to the marks (a 1-mark part ≈ 4 lines; a 4-mark part ≈ 15+). A subtle "lines expected" cue per part mirrors the real exam and nudges students to show enough working.

---

## 4. Prioritised recommendations (by ROI)

1. **Load the marking-feedback corpus as maths marker-voice calibration.** The deferred §11 item, now unblocked — directly serves the central design question. Parse the 11 feedback PDFs into the `marker-voice-loader.ts` calibration block (common-error + better-response + voice patterns, per course). *Highest ROI; we have the data.*
2. ✅ **DONE — `generate-marking-guideline` now emits NESA's authentic descending criteria ladder** (§3a): top line `Provides correct solution/proof/…` at full marks, descending cumulative tiers, `, or equivalent merit` on partials, NESA verb vocabulary, verb-aware (show/prove/induction/hence/justify), and it anchors to the teacher's worked solution when present. Stage-aware (Stage 4/5 use a simpler ladder).
3. **Extend the error-category enum + insights** with the validated additions (§2b) and the priority ordering (§2c).
4. **Provided-figure (image/table) stimulus** rendered to students (§3d) — unblocks "read off the graph" questions and reuses the #3b pipeline.
5. **Two-level part nesting + MC/extended container** (§3b, §3c) — for faithful Extension and full-paper authoring.
6. **(Bigger bet) student graph/diagram/table input** — the structural ceiling on how much of a real HSC paper we can ever cover. Decide deliberately; biggest impact on Standard 1/2.

---

## Appendix — reference snippets

**Marker voice (verbatim):**
- *"justifying conclusions using mathematical reasoning with a calculation not a broad statement."* (Std 1, 2023, Q20)
- *"understanding that 5.5% increase is not 105.5%…"* (Adv, 2024, Q13)
- *"recognising that the function should be in absolute value signs when an integration results in a logarithmic function."* (Ext 2, 2025, Q12d)
- *"a z-score does not represent a probability… a probability is not a z-score, and vice versa."* (Adv, 2024, Q23)
- *"use the mark value of a question as a guide to the complexity of solution required."* (Ext 1, 2019, Q12b-ii)

**Command-verb frequency (across 11 papers):** Find 94 · Show that 45 · Calculate 37 · Prove 28 · Draw 17 · Determine 15 · Shade 14 · Explain 14 · Hence 13 · Sketch 6. (Note: NESA does **not** use "Solve" or "Comment" — it phrases as "Find the value(s) of…" / "Describe"/"Explain".)

**Paper structure:** Std 1 = 80 (10 MC + Q11–28); Std 2 = 100 (15 MC + Q16–40); Advanced = 100 (10 MC + Q11–31); Ext 1 = 70 (10 MC + Q11–14); Ext 2 = 100 (10 MC + Q11–16). Standard/Advanced = many small questions; Extension = few large, deeply nested questions.
