/**
 * NESA Stage 4-5 (Year 7-10) Reference Material Scraper — SCAFFOLD
 *
 * STATUS: This is a scaffold, not a working scraper. The HSC Marking Centre
 * Notes (already scraped via scrape-nesa-feedback.ts) live at a predictable
 * URL pattern per subject and year. Stage 4-5 reference material is more
 * scattered across NESA's website — subject syllabuses, ACARA achievement
 * standards, annotated work samples, A-E descriptor sheets — and the URL
 * structure varies by subject and material type.
 *
 * To make this into a runnable scraper:
 *   1. For each (subject, stage) pair, identify the source URL(s) on
 *      educationstandards.nsw.edu.au and/or australiancurriculum.edu.au.
 *   2. Inspect the page HTML structure and write subject-specific extraction.
 *   3. Output JSON per subject-stage at data/nesa-stage-4-5-feedback/{subject}-stage-{N}.json.
 *   4. Update data/marker-voice-loader.ts (or a new stage-4-5 loader) to read
 *      these files when the prompt is built for a non-HSC student.
 *
 * Target subjects (matches data/stage-4-5-reference.ts):
 *   - English (Stage 4, Stage 5)
 *   - Mathematics (Stage 4, Stage 5)
 *   - Science (Stage 4, Stage 5)
 *   - HSIE — History + Geography (Stage 4, Stage 5)
 *   - PDHPE (Stage 4, Stage 5)
 *
 * Target sources (best places to start):
 *   - https://curriculum.nsw.edu.au/learning-areas/{subject}
 *     Has stage statements, outcomes, content. Mostly clean HTML.
 *   - https://curriculum.nsw.edu.au/learning-areas/{subject}/{syllabus}/standards
 *     Where it exists: A-E descriptors per subject at end-of-Stage.
 *   - NESA standards materials packages (annotated work samples) — these are
 *     mostly PDFs and harder to extract.
 *   - https://www.australiancurriculum.edu.au/ for ACARA achievement standards
 *     as a supplement.
 *
 * Output JSON shape (suggested, mirrors HSC structure for consistency):
 *   {
 *     subject: "English",
 *     stage: 4,
 *     source_urls: [...],
 *     stage_statement: "...",
 *     a_e_descriptors: [
 *       { grade: "A", description: "...", source: "NESA / ACARA / ..." }
 *     ],
 *     annotated_samples: [
 *       { grade: "A", student_response: "...", marker_commentary: "...", source_url: "..." }
 *     ]
 *   }
 *
 * Loader integration:
 *   The existing buildMarkerVoiceReference() in data/marker-voice-loader.ts
 *   only runs for HSC (isHsc) in the prompt. A new buildStage45Reference()
 *   would load from data/nesa-stage-4-5-feedback/ when the student is
 *   Stage 4 or 5, and inject annotated work samples as marker-voice
 *   calibration in the same way.
 */

console.error(
  '[scrape-stage-4-5-feedback] Not implemented yet — this script is a scaffold.\n' +
  'See the header docs for the plan. Run scrape-nesa-feedback.ts as a reference\n' +
  'for the extraction pattern.'
);
process.exit(1);
