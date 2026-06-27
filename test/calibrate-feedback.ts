/**
 * Calibration harness for take-home feedback register + volume.
 *
 * Runs the real per-question feedback engine (lib/multi-question-feedback.ts)
 * over the fixtures and prints each result, plus two measurable signals:
 *   - jargon hits: teacher-facing phrases a student shouldn't have to decode
 *   - avg words/sentence: a rough plainness proxy
 * Read the output by eye AND watch the jargon count drop after a register
 * change — without the strong-band feedback going hollow.
 *
 * Run: npm run calibrate-feedback
 * Requires: ANTHROPIC_API_KEY (loaded from .env / .env.local below).
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateQuestionFeedback } from '../lib/multi-question-feedback.js';
import { buildSystemPrompt } from '../prompts/feedback-system.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { FIXTURES } from './calibration-fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env then .env.local (no extra dependency), mirroring evaluate-sample.ts.
for (const name of ['../.env', '../.env.local']) {
  try {
    const envFile = readFileSync(resolve(__dirname, name), 'utf-8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* file optional */ }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not found in env / .env / .env.local');
  process.exit(1);
}

// Teacher-facing phrasing a Year 8 student shouldn't have to decode. Tunable —
// the point is a relative signal (fewer after a register change), not a verdict.
const JARGON = [
  'cause-and-effect chain', 'cause and effect chain', 'cause-and-effect',
  'ground your', 'grounding your', 'grounded in',
  'identification into', 'turn an identification', 'turns an identification',
  'operates at the depth', 'operate at the depth', 'the depth the',
  'success criteria', 'elaborate on', 'unpack', 'delve', 'articulate',
  'sophisticated', 'nuanced', 'cohesive', 'substantiate', 'holistic understanding',
];

function flatten(fb: any): string {
  const bits: string[] = [];
  const push = (x: any) => { if (typeof x === 'string') bits.push(x); else if (Array.isArray(x)) x.forEach(push); };
  push(fb.what_youve_done_well?.summary); push(fb.what_youve_done_well?.detail);
  push(fb.top_priority?.summary); push(fb.top_priority?.detail);
  push(fb.improvements?.summary); push(fb.improvements?.detail);
  push(fb.task_verb_check?.summary);
  (fb.criteria_feedback || []).forEach((c: any) => { push(c.strengths); push(c.improvements); });
  return bits.join(' ');
}

function jargonHits(text: string): string[] {
  const low = text.toLowerCase();
  return JARGON.filter((j) => low.includes(j));
}

function avgWordsPerSentence(text: string): number {
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return 0;
  const words = sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
  return Math.round((words / sentences.length) * 10) / 10;
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  let totalJargon = 0;

  for (const fx of FIXTURES) {
    const discipline = getDisciplineForCourse(fx.course) || null;
    const holisticSystem = buildSystemPrompt(fx.course, discipline || undefined, fx.yearLevel);
    const fb: any = await generateQuestionFeedback({
      client,
      question: fx.question as any,
      answerText: fx.answer,
      course: fx.course,
      discipline,
      yearLevel: fx.yearLevel,
      outcomes: [],
      teacherNotes: null,
      taskType: null,
      holisticSystem,
      readiness: [],
      onError: (err, stage) => console.error(`  [${stage}]`, (err as any)?.message || err),
    });

    const text = flatten(fb);
    const hits = jargonHits(text);
    totalJargon += hits.length;

    console.log('\n' + '═'.repeat(78));
    console.log(`${fx.label}   (${fx.question.marks} marks · depth=${fb.depth} · ok=${fb.ok})`);
    console.log('─'.repeat(78));
    console.log('WELL:', (fb.what_youve_done_well?.summary || []).map((s: string) => '\n  • ' + s).join(''));
    console.log('TOP PRIORITY:\n  → ' + (fb.top_priority?.summary || '(none)'));
    const imp = fb.improvements || {};
    console.log('IMPROVE (' + (imp.summary || []).length + '):',
      (imp.summary || []).map((s: string, i: number) => '\n  ' + (i + 1) + '. ' + s + (imp.detail && imp.detail[i] ? '\n     ' + imp.detail[i] : '')).join(''));
    if (fb.criteria_feedback && fb.criteria_feedback.length) {
      console.log('CRITERIA:', fb.criteria_feedback.map((c: any) => `\n  • ${c.criterion}: ${c.improvements}`).join(''));
    }
    console.log(`\nSIGNALS: jargon=${hits.length}${hits.length ? ' [' + hits.join(', ') + ']' : ''}  ·  avg words/sentence=${avgWordsPerSentence(text)}`);
  }

  console.log('\n' + '═'.repeat(78));
  console.log(`TOTAL jargon hits across ${FIXTURES.length} fixtures: ${totalJargon}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
