/**
 * Smoke test: verifies all four tool schemas are accepted by Anthropic and
 * that callTool returns the expected shape. Doesn't validate feedback
 * quality — that's evaluate-sample.ts's job. This just catches schema typos.
 *
 * Run: npx tsx test/smoke-tool-use.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, '../.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length > 0) process.env[key.trim()] = rest.join('=').trim();
  }
} catch {/* optional */}

import { callTool } from '../lib/anthropic-tool-call.js';
import {
  HOLISTIC_FEEDBACK_TOOL,
  CRITERIA_CHECK_TOOL,
  INLINE_SUGGESTIONS_TOOL,
  CLASS_FEEDBACK_TOOL,
} from '../lib/feedback-tools.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TINY_DRAFT = `Cardiovascular disease kills many Australians. The Ottawa Charter has five areas. Building healthy public policy means making laws.`;

async function check(name: string, p: Promise<any>) {
  const t0 = Date.now();
  try {
    const r = await p;
    const ms = Date.now() - t0;
    const keys = Object.keys(r.value || {});
    console.log(`✓ ${name} — ${ms}ms, attempts=${r.attempts}, keys=[${keys.join(', ')}]`);
  } catch (e: any) {
    console.error(`✗ ${name} —`, e?.message || e);
    process.exitCode = 1;
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('No ANTHROPIC_API_KEY in env');
    process.exit(1);
  }

  await check('HOLISTIC_FEEDBACK_TOOL', callTool({
    client,
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    temperature: 0,
    system: 'You are a HSC PDHPE teacher providing brief draft feedback. Use the tool.',
    user: `Question: Outline one risk factor for CVD.\n\nDraft:\n${TINY_DRAFT}\n\nProvide feedback.`,
    tool: HOLISTIC_FEEDBACK_TOOL,
  }));

  await check('CRITERIA_CHECK_TOOL', callTool({
    client,
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    temperature: 0,
    system: 'Assess against each criterion. Use the tool.',
    user: `MARKING CRITERIA:\n1. Knowledge of CVD (1 mark)\n\nDRAFT:\n${TINY_DRAFT}\n\nAssess each criterion.`,
    tool: CRITERIA_CHECK_TOOL,
  }));

  await check('INLINE_SUGGESTIONS_TOOL', callTool({
    client,
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    temperature: 0,
    system: 'You add inline annotations anchored to exact verbatim quotes. Use the tool.',
    user: `DRAFT:\n${TINY_DRAFT}\n\nAdd up to 3 annotations.`,
    tool: INLINE_SUGGESTIONS_TOOL,
  }));

  await check('CLASS_FEEDBACK_TOOL', callTool({
    client,
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    temperature: 0,
    system: 'Synthesise class-level feedback. Use the tool.',
    user: `Three students answered "Outline one risk factor for CVD". All described instead of outlining and didn't use data. Synthesise.`,
    tool: CLASS_FEEDBACK_TOOL,
  }));

  if (process.exitCode === 1) {
    console.error('\nSmoke test FAILED');
    process.exit(1);
  }
  console.log('\nAll four tools accepted by Anthropic and returned expected shape.');
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
