/**
 * Marker Voice Loader
 *
 * Loads NESA HSC marking feedback examples for a given subject and selects
 * a representative sample to inject into the system prompt as STYLE reference.
 *
 * The AI is instructed to learn the tone and phrasing patterns, NOT to repeat
 * the text verbatim. Students never see this content directly.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEEDBACK_DIR = resolve(__dirname, 'nesa-marking-feedback');

interface QuestionFeedback {
  questionNumber: string;
  betterResponses: string[];
  areasToImprove: string[];
}

interface MarkerFeedbackFile {
  subject: string;
  slug: string;
  year: number;
  sourceUrl: string;
  scrapedAt: string;
  generalFeedback: string[];
  sections: Array<{
    name: string;
    questions: QuestionFeedback[];
  }>;
}

// Map from discipline/course name patterns → scraper file slugs
const SLUG_MAP: Array<{ match: RegExp; slugs: string[] }> = [
  { match: /health and movement|pdhpe|community and family/i, slugs: ['pdhpe', 'community-and-family-studies'] },
  { match: /english advanced/i, slugs: ['english-advanced'] },
  { match: /english standard/i, slugs: ['english-standard'] },
  { match: /english/i, slugs: ['english-advanced', 'english-standard'] },
  { match: /biology/i, slugs: ['biology'] },
  { match: /chemistry/i, slugs: ['chemistry'] },
  { match: /physics/i, slugs: ['physics'] },
  { match: /modern history/i, slugs: ['modern-history'] },
  { match: /ancient history/i, slugs: ['ancient-history'] },
  { match: /business studies/i, slugs: ['business-studies'] },
  { match: /legal studies/i, slugs: ['legal-studies'] },
  { match: /economics/i, slugs: ['economics'] },
  { match: /geography/i, slugs: ['geography'] },
];

// Fallback slugs by discipline category (used when course name doesn't match directly)
const DISCIPLINE_FALLBACK: Record<string, string[]> = {
  PDHPE: ['pdhpe', 'community-and-family-studies'],
  English: ['english-advanced', 'english-standard'],
  Science: ['biology', 'chemistry', 'physics'],
  HSIE: ['modern-history', 'ancient-history', 'business-studies', 'legal-studies', 'economics', 'geography'],
  Mathematics: [],
  'Creative Arts': [],
  TAS: [],
  Languages: [],
  VET: [],
};

/**
 * Load all feedback files matching a subject's slugs (across all years).
 * Prefers most recent years.
 */
function loadFilesForSlugs(slugs: string[]): MarkerFeedbackFile[] {
  const files: MarkerFeedbackFile[] = [];
  if (!existsSync(FEEDBACK_DIR)) return files;

  const allFiles = readdirSync(FEEDBACK_DIR);

  for (const slug of slugs) {
    const matching = allFiles
      .filter(f => f.startsWith(`${slug}-`) && f.endsWith('.json'))
      .sort()
      .reverse(); // Most recent year first

    for (const filename of matching) {
      try {
        const content = readFileSync(resolve(FEEDBACK_DIR, filename), 'utf-8');
        files.push(JSON.parse(content));
      } catch { /* skip malformed */ }
    }
  }

  return files;
}

/**
 * Pick slugs for a given course name + discipline.
 */
function getSlugsForCourse(courseName?: string, discipline?: string): string[] {
  if (courseName) {
    for (const { match, slugs } of SLUG_MAP) {
      if (match.test(courseName)) return slugs;
    }
  }
  if (discipline && DISCIPLINE_FALLBACK[discipline]) {
    return DISCIPLINE_FALLBACK[discipline];
  }
  return [];
}

/**
 * Build a curated marker voice block for the system prompt.
 * Returns empty string if no feedback data available for this subject.
 *
 * Takes a small sample (not everything) to avoid bloating the prompt:
 * - 6-8 general feedback items
 * - 4-5 question-level "better responses" examples
 * - 4-5 question-level "areas to improve" examples
 */
export function buildMarkerVoiceReference(courseName?: string, discipline?: string): string {
  const slugs = getSlugsForCourse(courseName, discipline);
  if (slugs.length === 0) return '';

  const files = loadFilesForSlugs(slugs);
  if (files.length === 0) return '';

  // Collect unique samples — preferring the most recent year
  const generalItems = new Set<string>();
  const betterExamples: string[] = [];
  const improveExamples: string[] = [];

  for (const file of files) {
    // Add general items (capped)
    for (const item of file.generalFeedback) {
      if (generalItems.size < 8) generalItems.add(item);
    }
    // Grab one example from each question
    for (const section of file.sections) {
      for (const q of section.questions) {
        if (betterExamples.length < 5 && q.betterResponses.length > 0) {
          betterExamples.push(q.betterResponses[0]);
        }
        if (improveExamples.length < 5 && q.areasToImprove.length > 0) {
          improveExamples.push(q.areasToImprove[0]);
        }
        if (betterExamples.length >= 5 && improveExamples.length >= 5) break;
      }
      if (betterExamples.length >= 5 && improveExamples.length >= 5) break;
    }
    if (betterExamples.length >= 5 && improveExamples.length >= 5 && generalItems.size >= 8) break;
  }

  if (generalItems.size === 0 && betterExamples.length === 0 && improveExamples.length === 0) {
    return '';
  }

  const subjectLabel = files[0].subject;

  let block = `\n\nMARKER VOICE REFERENCE (${subjectLabel}):
The following are examples of how experienced NESA HSC markers phrase their feedback. Use these as STYLE AND TONE references for your own feedback — learn the phrasing patterns, the directness, the specificity, the use of concrete examples. DO NOT quote or repeat these verbatim. Write feedback about the actual student draft in front of you using this voice.

General observations markers make about strong students:`;

  for (const item of Array.from(generalItems).slice(0, 8)) {
    block += `\n- ${item}`;
  }

  if (betterExamples.length > 0) {
    block += `\n\nHow markers phrase what better responses do:`;
    for (const item of betterExamples) {
      block += `\n- "${item}"`;
    }
  }

  if (improveExamples.length > 0) {
    block += `\n\nHow markers phrase areas for improvement:`;
    for (const item of improveExamples) {
      block += `\n- "${item}"`;
    }
  }

  block += `\n\nNote the patterns: markers are specific (they reference actual content), actionable (they describe what to do), and calibrated (they distinguish levels of performance). Match this register — don't be vague, don't be generic, don't hedge.`;

  return block;
}
