/**
 * NESA HSC Marking Feedback Scraper
 *
 * Fetches the HTML pages at:
 *   https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers/{subject}/{year}
 *
 * Parses the "Marking feedback" section into structured data:
 *   - General feedback (top-of-page bullets)
 *   - Per-question feedback ("In better responses..." and "Areas for students to improve...")
 *
 * Output: data/nesa-marking-feedback/{subject}-{year}.json
 *
 * Usage:
 *   npx tsx scripts/scrape-nesa-feedback.ts
 *
 * Purpose: this data is used for AI style calibration only — feedback is fed
 * into the system prompt as examples of how HSC markers phrase things, NOT
 * embedded verbatim in user-facing output. See data/nesa-marking-feedback/README.md
 * for the licensing posture.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../data/nesa-marking-feedback');

// ── Subjects to scrape ──
// Map of display name → URL slug used by nsw.gov.au
const SUBJECTS: Record<string, string> = {
  'PDHPE': 'pdhpe',
  'English Advanced': 'english-advanced',
  'English Standard': 'english-standard',
  'Biology': 'biology',
  'Chemistry': 'chemistry',
  'Physics': 'physics',
  'Modern History': 'modern-history',
  'Ancient History': 'ancient-history',
  'Business Studies': 'business-studies',
  'Legal Studies': 'legal-studies',
  'Economics': 'economics',
  'Geography': 'geography',
  'Mathematics Advanced': 'mathematics-advanced',
  'Mathematics Standard 2': 'mathematics-standard-2',
  'Community and Family Studies': 'community-and-family-studies',
};

// Years to scrape (most recent have richest content)
const YEARS = [2024, 2023, 2022, 2021];

interface QuestionFeedback {
  questionNumber: string;
  betterResponses: string[];
  areasToImprove: string[];
}

interface MarkerFeedback {
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

/**
 * Extract all text content from an HTML fragment, preserving structure.
 * Strips tags but keeps spacing sensible.
 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract bullet list items from a <ul>...</ul> block.
 */
function extractListItems(html: string): string[] {
  const items: string[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = liRegex.exec(html)) !== null) {
    const text = stripTags(match[1]);
    if (text) items.push(text);
  }
  return items;
}

/**
 * Parse the marking feedback section from a NESA page.
 */
function parseMarkingFeedback(html: string): { generalFeedback: string[]; sections: Array<{ name: string; questions: QuestionFeedback[] }> } {
  const result = {
    generalFeedback: [] as string[],
    sections: [] as Array<{ name: string; questions: QuestionFeedback[] }>,
  };

  // Find the "Feedback on written exam" accordion block
  const feedbackBlockMatch = html.match(/<h3>Feedback on written exam<\/h3>([\s\S]*?)<\/div><\/div><\/div><\/div><\/div>/);
  if (!feedbackBlockMatch) return result;

  const feedbackBlock = feedbackBlockMatch[1];

  // Split on accordion titles — each section is bounded by title markers.
  // We find all title positions, then slice between them.
  const titleRegex = /<div class="nsw-accordion__title[^"]*">([^<]+)<\/div>/g;
  const titles: Array<{ name: string; start: number; end: number }> = [];
  let titleMatch;
  while ((titleMatch = titleRegex.exec(feedbackBlock)) !== null) {
    titles.push({
      name: stripTags(titleMatch[1]),
      start: titleMatch.index,
      end: titleMatch.index + titleMatch[0].length,
    });
  }

  // For each title, the section content spans from the end of this title
  // to the start of the next title (or end of feedback block).
  for (let i = 0; i < titles.length; i++) {
    const sectionName = titles[i].name;
    const contentStart = titles[i].end;
    const contentEnd = i + 1 < titles.length ? titles[i + 1].start : feedbackBlock.length;
    const sectionContent = feedbackBlock.slice(contentStart, contentEnd);

    if (/general/i.test(sectionName)) {
      // Extract bullets from the general feedback section
      const ulMatch = sectionContent.match(/<ul>([\s\S]*?)<\/ul>/);
      if (ulMatch) {
        result.generalFeedback = extractListItems(ulMatch[0]);
      }
      continue;
    }

    // Per-question sections (Section I Part B, Section II, etc.)
    const questions: QuestionFeedback[] = [];

    // Match each question: <h4>Question N</h4> ... <h4>Question N+1</h4>
    const questionRegex = /<h4>\s*(Question\s+[^<]+?)\s*<\/h4>([\s\S]*?)(?=<h4>|$)/g;
    let qMatch;
    while ((qMatch = questionRegex.exec(sectionContent)) !== null) {
      const questionNumber = stripTags(qMatch[1]).replace(/^Question\s+/i, '');
      const questionContent = qMatch[2];

      // Split by "In better responses..." and "Areas for students to improve..."
      const betterMatch = questionContent.match(/In better responses[^<]*<\/p>\s*<ul>([\s\S]*?)<\/ul>/i);
      const improveMatch = questionContent.match(/Areas for students to improve[^<]*<\/p>\s*<ul>([\s\S]*?)<\/ul>/i);

      questions.push({
        questionNumber,
        betterResponses: betterMatch ? extractListItems(betterMatch[0]) : [],
        areasToImprove: improveMatch ? extractListItems(improveMatch[0]) : [],
      });
    }

    if (questions.length > 0) {
      result.sections.push({ name: sectionName, questions });
    }
  }

  return result;
}

async function scrapeSubjectYear(subject: string, slug: string, year: number): Promise<MarkerFeedback | null> {
  const url = `https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers/${slug}/${year}`;
  console.log(`  Fetching ${url}`);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ProofReady/0.1 (research; contact help@proofready.app)' },
    });
    if (!res.ok) {
      console.log(`    ✗ HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const parsed = parseMarkingFeedback(html);

    if (parsed.sections.length === 0 && parsed.generalFeedback.length === 0) {
      console.log(`    ✗ No feedback content found`);
      return null;
    }

    const totalQuestions = parsed.sections.reduce((sum, s) => sum + s.questions.length, 0);
    console.log(`    ✓ ${parsed.generalFeedback.length} general items, ${totalQuestions} questions across ${parsed.sections.length} sections`);

    return {
      subject,
      slug,
      year,
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      generalFeedback: parsed.generalFeedback,
      sections: parsed.sections,
    };
  } catch (err: any) {
    console.log(`    ✗ Error: ${err.message}`);
    return null;
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`\nScraping NESA marking feedback for ${Object.keys(SUBJECTS).length} subjects × ${YEARS.length} years\n`);

  let successCount = 0;
  let totalCount = 0;

  for (const [subject, slug] of Object.entries(SUBJECTS)) {
    console.log(`\n${subject}:`);
    for (const year of YEARS) {
      totalCount++;
      const data = await scrapeSubjectYear(subject, slug, year);
      if (data) {
        const outputPath = resolve(OUTPUT_DIR, `${slug}-${year}.json`);
        await writeFile(outputPath, JSON.stringify(data, null, 2));
        successCount++;
      }
      // Be polite — small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`\n\nDone: ${successCount}/${totalCount} pages scraped successfully`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
