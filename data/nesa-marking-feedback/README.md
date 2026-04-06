# NESA HSC Marking Feedback — Style Calibration Data

## Purpose

This directory contains structured data extracted from publicly available NESA HSC "Marking feedback" pages. The data is used **solely for AI style calibration** — as examples of how experienced HSC markers phrase their feedback, so that ProofReady's AI-generated feedback sounds authentic.

## Licensing posture

NESA materials are Crown copyright (NSW Education Standards Authority, © State of NSW). Per NESA's copyright policy at https://www.nsw.gov.au/education-and-training/nesa/copyright:

- Fair dealing exceptions permit use for "research or study".
- The non-commercial educational licence applies to NSW teachers using materials in their own teaching.

**ProofReady's use of this data complies with the following rules:**

1. **No verbatim output to students.** Extracted NESA text is never shown directly in user-facing feedback. It is injected into the AI system prompt as style reference, with explicit instructions to the AI to learn the tone and phrasing patterns — not to repeat the text.

2. **No redistribution.** The JSON files in this directory are not published, shared, or exposed via any public API. They live in the server-side data directory only.

3. **Attribution on source.** Each file records the source URL and scrape date.

4. **Commercial posture check before production.** Before ProofReady is sold to schools as a SaaS product, a written permission request will be sent to `copyright@nesa.nsw.edu.au` describing exactly this use case and posture. If NESA declines, this directory will be removed and the system prompt will fall back to generic marker-style guidance.

## Re-running the scraper

```bash
npx tsx scripts/scrape-nesa-feedback.ts
```

The scraper is polite (500ms between requests, identifies itself in User-Agent) and targets only publicly indexed HTML pages that NESA makes freely available to anyone on the internet.

## Data structure

Each JSON file follows:

```typescript
{
  subject: string;           // display name e.g. "PDHPE"
  slug: string;              // URL slug e.g. "pdhpe"
  year: number;              // HSC exam year
  sourceUrl: string;         // URL the content was scraped from
  scrapedAt: string;         // ISO timestamp
  generalFeedback: string[]; // top-level marker observations
  sections: [
    {
      name: string;          // e.g. "Section I – Part B", "Section II"
      questions: [
        {
          questionNumber: string;    // e.g. "21", "28(a)"
          betterResponses: string[]; // from "In better responses, students were able to..."
          areasToImprove: string[];  // from "Areas for students to improve include..."
        }
      ]
    }
  ]
}
```
