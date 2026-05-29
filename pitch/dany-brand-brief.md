# ProofReady — Brief for Presentation Materials

**Use:** Paste this whole document into your LLM (Claude, ChatGPT, etc.) as context before asking it to draft slides, one-pagers, explainer copy, social posts, or any other ProofReady materials.

---

## 1. What ProofReady is — in one sentence

ProofReady is a web tool that gives NSW HSC students NESA-aligned formative feedback on their assessment drafts, in the voice of an experienced HSC marker — so students get high-quality teacher-style feedback on every draft without waiting in a queue, and teachers get hours of marking time back.

## 2. The 60-second version

- **Built by a teacher, for teachers.** Rob Sheahan, NSW PDHPE teacher, built ProofReady to solve his own marking workload.
- **Formative, not summative.** ProofReady gives feedback on *drafts*, not grades on final work. It does **not** predict bands or marks. Ever. (This is a hard product rule, not a hedging line.)
- **NESA-aligned.** Feedback is calibrated against NESA's published Notes from the Marking Centre (2021–2024), the NESA glossary, performance band descriptors, and HSC marking principles. This is the moat.
- **One subject at a time.** Starting with PDHPE (Rob's KLA). Expanding KLA by KLA — quality before breadth.
- **Canvas-native.** Launches inside Canvas as an LTI 1.3 tool. Students don't need a join code; the class roster syncs automatically. Optional grade passback to SpeedGrader.
- **Pilot live now:** Penrith Christian School (PCS) is the first Canvas LTI 1.3 pilot school.

## 3. The problem (use this framing for slides)

A draft is where learning happens, but teachers can only mark so many drafts before a deadline. So:
- Students submit final work without genuine draft feedback
- Or teachers burn weekends marking drafts that won't even be assessed
- Or feedback arrives too late to change the next attempt

ProofReady gives students draft feedback in minutes, at the quality of a senior HSC marker, so teachers can intervene where it actually matters.

## 4. What makes it different (the moat)

Other AI feedback tools are general-purpose. ProofReady is HSC-specific in a way that's hard to copy:

1. **NESA Notes from the Marking Centre** for the subject are injected into the prompt, so the feedback echoes what experienced HSC markers actually flag.
2. **NESA glossary + directive verb depth** — the tool checks whether the student responded to the verb in the question (Discuss vs Evaluate vs Analyse) at the right depth.
3. **Subject-specific terminology bank** for every supported KLA.
4. **Three-pass feedback architecture** — a holistic pass, a criterion-by-criterion pass, and inline annotations (like a teacher's pen on the page).
5. **No mark/band predictions, no content rewriting.** Hard product rules. Feedback says *what* to fix and *why*, not *how to write it for the student*.
6. **Typed-response-only by default.** Paste/drop are blocked, autosave + keystroke telemetry. The draft the teacher sees is what the student actually typed.

## 5. The "central design question" — quote-worthy

Every product decision is evaluated against one question:

> "How can we get the most accurate possible feedback to mimic that of a professional, experienced teacher?"

Use this as a guiding quote in pitch material — it's the explicit north star.

## 6. How a teacher uses it (flow for explainer slides)

1. Teacher signs in (or launches from Canvas).
2. Creates a class. Composes a task — picks **Assessment task** (full feedback flow, up to 3 drafts per student) or **Quick task** (silent insights pass, single submission, optional mark).
3. Pastes the question, outcomes, total marks, due date, and rubric/criteria.
4. Publishes. Students see only published tasks.
5. Students submit drafts → AI feedback in ~30–60 seconds.
6. Teacher marks the final submission with a rubric tool + text annotation. Marks pass back to Canvas SpeedGrader if LTI-linked.
7. Teacher gets **insights**: cohort-level cards (top mistakes, stretch goals, things done well, mark distribution) + per-student longitudinal profiles.

## 7. How a student experiences it

- Types their draft in a focused editor (paste is blocked).
- Hits "Get AI feedback".
- Receives:
  - **What you've done well** (3 things)
  - **Improvements** (specific, criterion-anchored)
  - **Top priority** (the one thing to fix first)
  - **Task verb check** (did you actually *evaluate*, or just *describe*?)
  - **Inline annotations** on quoted phrases of their own writing
- Can revise and resubmit (up to 3 times per task).
- When the teacher marks it, the student sees a per-criterion breakdown, the teacher's comment, and the teacher's own annotations alongside the AI ones.

## 8. Insights (for the leadership/admin pitch)

For Heads of Faculty / Heads of School, ProofReady surfaces:
- Mark distribution across the cohort
- Improvement velocity (are students addressing prior feedback?)
- Faculty- and school-level engagement
- The top 3 recurring mistakes across a cohort
- "Stretch goals" — what top-quartile students should reach for next
- Per-student longitudinal profile (cached, privacy-safe — no draft quotes ever shown)

Three tiers: **Teacher** (own classes), **Leader** (school + faculty filter), **Admin** (full school).

## 9. Privacy & compliance (one-liners that should appear in every external doc)

- Data hosted in **Australia** (Supabase Sydney region).
- AI processing via **Anthropic Claude**. Anthropic excludes API inputs/outputs from model training.
- **TLS** in transit, encrypted at rest.
- **Privacy Act 1988 / APP-aligned.** Full pack at `proofready.app/compliance.html`.
- **No model training on student work.** Ever.
- ProofReady receives student **name + email + Canvas user ID + course context** — no DOB, address, or other PII.

## 10. What ProofReady is NOT (avoid these claims in copy)

- It is **not** a grading tool. It does not assign marks or predict bands.
- It does **not** rewrite student work or "improve" their writing for them.
- It is **not** a plagiarism detector.
- It is **not** a substitute for teacher feedback — it scales the teacher's feedback capacity on drafts.
- It is **not** subject-agnostic. Quality comes from KLA-specific calibration; we ship a KLA only when it's calibrated.

## 11. The pilot

- **Penrith Christian School (PCS)** is the first Canvas LTI 1.3 pilot.
- Integration is live: dev key registered, deployment configured, NRPS roster sync + AGS grade passback working.
- Canvas Cloud host: `learningpcs.instructure.com`.

---

## 12. Brand — colors

Use CSS variable names from the production deck (`pitch/pitch-deck.html`) for consistency. Primary palette is a warm cream + ink + orange — *not* a generic ed-tech blue.

### Core neutrals
| Token | Hex | Use |
|---|---|---|
| `--cream` | `#fdf6ee` | Primary background |
| `--cream-soft` | `#faf7f2` | Section backgrounds |
| `--cream-warm` | `#fef3e6` | Highlight blocks |
| `--cream-edge` | `#f0e6d6` | Borders on cream |
| `--ink` | `#111827` | Primary text, headings |
| `--ink-soft` | `#1f2937` | Body text |
| `--grey-1` | `#374151` | Strong secondary text |
| `--grey-2` | `#4b5563` | Secondary text |
| `--grey-3` | `#6b7280` | Tertiary / lede / subdued |
| `--grey-4` | `#9ca3af` | Captions, metadata |
| `--grey-5` | `#d1d5db` | Dividers |

### Brand accents
| Token | Hex | Use |
|---|---|---|
| `--orange` | `#ed7615` | **Primary brand color.** CTAs, accent words, eyebrows |
| `--orange-dark` | `#b45309` | Slide tags / eyebrow text on cream |
| `--orange-soft` | `#fcd9b6` | Backgrounds for highlight blocks |

### Status / semantic colors
| Token | Hex | Use |
|---|---|---|
| `--green` | `#15803d` | Praise / success |
| `--green-soft` | `#f0fdf4` | Success backgrounds |
| `--green-edge` | `#bbf7d0` | Success borders |
| `--red` | `#dc2626` | Warning / improve |
| `--red-soft` | `#fef2f2` | Warning backgrounds |
| `--red-edge` | `#fecaca` | Warning borders |
| `--blue` | `#1d4ed8` | Teacher annotations (differentiated from AI) |
| `--blue-soft` | `#eff6ff` | Teacher annotation backgrounds |
| `--blue-edge` | `#bfdbfe` | Teacher annotation borders |
| `--purple` | `#6b21a8` | Teacher annotation alt |
| `--purple-soft` | `#faf5ff` | Teacher annotation alt background |

### Dark canvas (for dark sections / notes panels)
- Background: `#1a1715` (warm near-black, *not* pure black or grey)
- Text on dark: `#f5f0e8` (warm off-white)
- Muted text on dark: `#e8e0d4`

---

## 13. Brand — typography

- **Headings + body:** `Inter`, weights 400 / 500 / 600 / 700 / 800 / 900.
  - Loaded from Google Fonts: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900`
  - Fallback stack: `'Inter', -apple-system, sans-serif`
- **Monospace / code / URL bars:** `JetBrains Mono`, weights 400 / 500 / 600.

### Heading scale (from deck)
- H1: `52px / 800 / -1.4px letter-spacing / 1.05 line-height`
- H2: `36px / 800 / -1px / 1.1`
- H3: `22px / 700 / -0.4px`
- Lede: `22px / 500`, `color: --grey-1`, max-width ~880px
- Body: `16px / 400`, `color: --grey-1`
- Eyebrow / tag: `11px / 700 / 1.4px letter-spacing / UPPERCASE / color: --orange-dark`
- Slide num / metadata: `12px / 600 / 0.5px letter-spacing / color: --grey-4`

---

## 14. Brand — logo & assets

- **Logo / favicon source:** `public/proofready/favicon.svg`
- **Banner (raster):** `public/proofreadybanner.png`
- **Banner (vector):** `public/proofready-banner.svg`
- **Production icon URL** (use this in external docs): `https://proofready.app/proofready/favicon-96x96.png`

When placing the logo on a cream background, no card / drop-shadow needed. On dark `#1a1715`, give it a comfortable margin — no glow.

---

## 15. Voice & tone

- **Plain English, teacher-to-teacher.** Avoid ed-tech vendor language ("revolutionize", "AI-powered solution", "transform learning outcomes").
- **Specific over abstract.** "Saves a Head of PDHPE ~6 hours per assessment cycle" beats "saves teachers time".
- **Australian English** — *colour*, *organisation*, *programme* (not *program* when it's a syllabus programme).
- **Calm and credible.** ProofReady is not a hype product. The pitch is: "this works because it was built by a teacher who actually marks HSC papers, against the actual NESA materials."
- **Never overclaim AI.** Don't say "AI marks the work." Do say "AI gives draft feedback aligned to NESA marking standards."
- **Treat NESA terminology with care.** Bands, outcomes, criteria, directive verbs — use them precisely.

### Words/phrases to favour
- formative feedback, draft, redraft, criterion, outcome, marker voice, calibrated, NESA-aligned, KLA, faculty, cohort, longitudinal profile

### Words/phrases to avoid
- grade prediction, predicted band, rewrites your essay, AI tutor, replace teachers, learning revolution, transform education, automatic marking

---

## 16. Where to find more

- **Live site:** https://proofready.app
- **Pitch deck (HTML, with speaker notes — press N):** https://proofready.app/deck
- **Compliance & privacy pack:** https://proofready.app/compliance.html
- **Repo (private, request access):** `github.com/robsheahan/redraft`
- **Contact:** rob@proofready.app

---

## 17. Reusable taglines (pick any)

- **ProofReady — NESA-aligned formative feedback, in minutes.**
- **Teacher-quality draft feedback. Without the queue.**
- **Built by a teacher. Calibrated to NESA. Designed for HSC.**
- **Better drafts. Faster turnaround. The same standards.**
- **Feedback on every draft. Marks only when the teacher decides.**
