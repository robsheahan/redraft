# NESA Copyright Permission Request

**To:** copyright@nesa.nsw.edu.au
**Subject:** Permission request — use of HSC marking feedback for AI feedback tool style calibration

---

Dear NESA Copyright Team,

My name is Rob Sheahan. I am a NSW PDHPE teacher and the developer of **ProofReady** (https://proofready.app), a formative feedback tool that helps HSC students improve their assessment drafts before submission. I am writing to request permission for a specific and limited use of publicly available NESA HSC marking feedback.

## What the tool does

ProofReady is a web-based tool where teachers upload assessment tasks with their own marking criteria, and students paste in their draft responses. The tool then generates AI-powered formative feedback aligned to the teacher's criteria and NESA standards. The feedback is explicitly formative only — it is not a mark, and the tool clearly states this to students.

The tool is NESA-aligned: it uses the official NESA glossary of key words, references NESA marking principles, and gives feedback calibrated to the HSC band descriptors. It currently supports all 100+ Board Developed Courses.

## What I am requesting

I would like to use the publicly published "Marking feedback" content from the HSC exam papers pages at:

`https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers/{subject}/{year}`

Specifically, the "General feedback", "In better responses, students were able to..." and "Areas for students to improve include..." content.

## How it will be used

**Critical point:** this content will never be shown verbatim to students or teachers using ProofReady. It is used exclusively as a style reference for the AI system prompt, so that the AI's generated feedback adopts the tone, specificity, and calibration of authentic NESA markers.

Concretely:

1. The marking feedback text is stored server-side in a data file (not exposed via any API).
2. When a student submits a draft, the AI system prompt includes a small curated sample (6-8 general items + 5 "better responses" + 5 "areas to improve") labelled as a "marker voice reference".
3. The AI is explicitly instructed: *"Use these as STYLE AND TONE references for your own feedback — learn the phrasing patterns, the directness, the specificity. DO NOT quote or repeat these verbatim. Write feedback about the actual student draft in front of you using this voice."*
4. The student sees only AI-generated feedback about their own draft, not any extracted NESA text.

This is the minimum-impact way to achieve what I believe is an important educational goal: ensuring AI feedback sounds like authentic HSC markers rather than generic AI output.

## Why this matters

Generic AI feedback tools produce vague, hedging feedback that doesn't reflect what HSC markers actually write. By calibrating against real NESA marker voice, ProofReady can give students formative feedback that matches the expectations and phrasing they'll encounter in their actual HSC exams — helping them prepare more effectively and authentically.

## Safeguards

- No verbatim NESA text is ever shown to users.
- The data is not republished, shared, or made available via any public endpoint.
- Each source URL and scrape date is recorded for full attribution.
- If permission is declined, the data will be deleted and the system prompt will fall back to generic marker-style guidance.

## Scope

I am currently using the "Marking feedback" sections (HTML on the public exam pages) from 2021-2024 for these subjects:
- PDHPE, Community and Family Studies
- English Advanced, English Standard
- Biology, Chemistry, Physics
- Modern History, Ancient History
- Business Studies, Legal Studies, Economics, Geography

## Commercial status

ProofReady is currently in development and free for teacher testing. I intend to eventually offer it to schools on a paid basis. I am writing to you now, before commercial launch, specifically to ensure the tool operates on firm legal footing.

I would be very grateful for written permission for this specific use case. If you have any questions or need further clarification about the technical approach, I would welcome a call or email exchange.

Thank you for your time.

Kind regards,

Rob Sheahan
PDHPE Teacher, NSW
Developer, ProofReady
help@proofready.app
https://proofready.app
