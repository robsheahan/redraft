/**
 * Blind Anthropic/OpenAI comparison over ProofReady's calibration fixtures.
 *
 * Run: npm run compare-providers
 * Optional: npm run compare-providers -- --limit=3 --out=/tmp/my-comparison
 *
 * Writes two files:
 *   outputs.json — randomised A/B outputs for blind review
 *   answer-key.json — provider/model mapping and timing
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateQuestionFeedback } from '../lib/multi-question-feedback.js';
import { buildSystemPrompt } from '../prompts/feedback-system.js';
import { getDisciplineForCourse } from '../data/nesa-courses.js';
import { FIXTURES } from './calibration-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

for (const name of ['../.env', '../.env.local']) {
  try {
    for (const line of readFileSync(resolve(here, name), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const at = trimmed.indexOf('=');
      if (at < 1) continue;
      const key = trimmed.slice(0, at).trim();
      let value = trimmed.slice(at + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* optional */ }
}

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

const limit = Math.max(1, Number.parseInt(arg('limit') || String(FIXTURES.length), 10));
const fixtureFilter = arg('fixture')?.toLowerCase();
const selectedFixtures = fixtureFilter
  ? FIXTURES.filter((fixture) => fixture.label.toLowerCase().includes(fixtureFilter))
  : FIXTURES.slice(0, limit);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(arg('out') || `/tmp/proofready-provider-comparison-${stamp}`);

async function generate(provider: 'anthropic' | 'openai', fixture: (typeof FIXTURES)[number]) {
  process.env.AI_PRIMARY_PROVIDER = provider;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 0 });
  const discipline = getDisciplineForCourse(fixture.course) || null;
  const started = Date.now();
  const output = await generateQuestionFeedback({
    client,
    question: fixture.question as any,
    answerText: fixture.answer,
    course: fixture.course,
    discipline,
    yearLevel: fixture.yearLevel,
    outcomes: [],
    teacherNotes: null,
    taskType: null,
    holisticSystem: buildSystemPrompt(fixture.course, discipline || undefined, fixture.yearLevel),
    readiness: [],
    onError: (error, stage) => console.error(`[${provider}:${fixture.label}:${stage}]`, error),
  });
  if (!output.ok) {
    throw new Error(`${provider} did not return usable feedback for ${fixture.label}`);
  }
  return { output, latency_ms: Date.now() - started };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new Error('Both ANTHROPIC_API_KEY and OPENAI_API_KEY are required for comparison');
  }
  if (!selectedFixtures.length) {
    throw new Error(`No calibration fixture matched --fixture=${fixtureFilter}`);
  }

  const outputs: any[] = [];
  const answerKey: any[] = [];
  for (const fixture of selectedFixtures) {
    console.log(`Running ${fixture.label}…`);
    const anthropic = await generate('anthropic', fixture);
    const openai = await generate('openai', fixture);
    const anthropicIsA = Math.random() < 0.5;
    outputs.push({
      fixture: fixture.label,
      expected_level: fixture.level,
      course: fixture.course,
      question: fixture.question,
      student_answer: fixture.answer,
      A: anthropicIsA ? anthropic.output : openai.output,
      B: anthropicIsA ? openai.output : anthropic.output,
      scores: {
        A: { correctness: null, rubric_grounding: null, marker_voice: null, actionability: null, evidence_fidelity: null },
        B: { correctness: null, rubric_grounding: null, marker_voice: null, actionability: null, evidence_fidelity: null },
      },
      preferred: null,
      notes: '',
    });
    answerKey.push({
      fixture: fixture.label,
      A: anthropicIsA ? 'anthropic' : 'openai',
      B: anthropicIsA ? 'openai' : 'anthropic',
      anthropic: { model: 'claude-sonnet-5', latency_ms: anthropic.latency_ms },
      openai: { model: process.env.OPENAI_PRIMARY_MODEL || 'gpt-5.6-terra', latency_ms: openai.latency_ms },
    });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'outputs.json'), JSON.stringify(outputs, null, 2));
  writeFileSync(resolve(outDir, 'answer-key.json'), JSON.stringify(answerKey, null, 2));
  console.log(`\nBlind outputs: ${resolve(outDir, 'outputs.json')}`);
  console.log(`Answer key:    ${resolve(outDir, 'answer-key.json')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
