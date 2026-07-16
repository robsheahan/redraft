/**
 * Billable fabricated-data coverage for every OpenAI workload family that is
 * impractical to exercise through authenticated production endpoints.
 * Run only deliberately: npm run test-openai-live
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callText, callTool } from '../lib/anthropic-tool-call.js';
import {
  CLASS_FEEDBACK_TOOL,
  COMMON_GAPS_TOOL,
  DIFFERENTIATED_ACTIVITY_TOOL,
  INSIGHTS_SIGNALS_TOOL,
  MATHS_STRUCTURE_WORKING_TOOL,
} from '../lib/feedback-tools.js';
import { PROFILE_TOOL } from '../lib/student-profile.js';

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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* optional */ }
}

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const TEST_PNG = readFileSync(resolve(here, '../public/og-image.png')).toString('base64');

async function structured(name: string, model: string, tool: any, user: any, requireNonEmpty = true) {
  const started = Date.now();
  const result = await callTool<any>({
    provider: 'openai', model, max_tokens: 1800,
    system: 'This is a fabricated ProofReady integration test. Follow the function schema exactly. Keep every string concise and populate every required field with safe synthetic educational content.',
    user, tool, requiredKeys: requireNonEmpty && Array.isArray(tool.input_schema?.required) ? tool.input_schema.required : [],
    retries: 1, label: `coverage:${name}`,
  });
  console.log(`✓ ${name} ${Date.now() - started}ms keys=[${Object.keys(result.value || {}).join(',')}]`);
}

await structured('fast-insights-signals', 'claude-haiku-test', INSIGHTS_SIGNALS_TOOL,
  'Question: Explain why exercise supports wellbeing. Fabricated answer: Exercise strengthens the heart and can reduce stress. Return brief signals.');
await structured('maths-freeform-structuring', 'claude-haiku-test', MATHS_STRUCTURE_WORKING_TOOL,
  'Fabricated spoken working: two x plus three equals seven, subtract three, two x equals four, x equals two. Return maths lines.');
await structured('maths-vision', 'claude-sonnet-test', MATHS_STRUCTURE_WORKING_TOOL, [
  { type: 'text', text: 'The attached fabricated test image is intentionally blank. Return one line stating no readable working.' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEST_PNG } },
], false);
await structured('lesson-differentiator', 'claude-sonnet-test', DIFFERENTIATED_ACTIVITY_TOOL,
  'Fabricated task: Analyse how peers influence health. Provide a concise student focus, scaffolding and extension without changing the question.');
await structured('student-profile', 'claude-sonnet-test', PROFILE_TOOL,
  'Fabricated history: three submissions. Strength: clear examples. Priority: connect evidence to conclusions. Marks are intentionally omitted. Produce a developing profile.');
await structured('cohort-insights', 'claude-sonnet-test', COMMON_GAPS_TOOL,
  'Fabricated cohort of 12 submissions: six describe instead of analysing; four omit evidence; two lack conclusions. Return concise common gaps.');
await structured('class-feedback', 'claude-sonnet-test', CLASS_FEEDBACK_TOOL,
  'Fabricated class: students identify relevant ideas but need stronger causal explanation and evidence. Return concise class feedback.');

for (const [name, prompt] of [
  ['criteria-authoring', 'Create a concise five-band A–E rubric for a fabricated 10-mark analysis question. Plain text only.'],
  ['maths-guideline-authoring', 'Create a concise descending three-mark guideline for solving 2x+3=7. Plain text only.'],
] as const) {
  const started = Date.now();
  const result = await callText({
    provider: 'openai', model: 'claude-sonnet-test', max_tokens: 600,
    system: 'Return concise plain text only for this fabricated ProofReady integration test.',
    user: prompt, retries: 1, label: `coverage:${name}`,
  });
  if (!result.value.trim()) throw new Error(`${name} returned empty output`);
  console.log(`✓ ${name} ${Date.now() - started}ms chars=${result.value.length}`);
}

console.log('Live OpenAI workload coverage passed.');
