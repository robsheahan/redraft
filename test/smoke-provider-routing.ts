/** Offline smoke test for OpenAI request routing and function-call parsing. */

import Anthropic from '@anthropic-ai/sdk';
import { callTool } from '../lib/anthropic-tool-call.js';

process.env.OPENAI_API_KEY = 'test-key';

let requestBody: any;
globalThis.fetch = (async (_input: any, init?: any) => {
  requestBody = JSON.parse(String(init?.body || '{}'));
  return new Response(JSON.stringify({
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'gpt-test',
    output: [{
      id: 'fc_test',
      type: 'function_call',
      call_id: 'call_test',
      name: 'return_result',
      arguments: '{"answer":"ok"}',
      status: 'completed',
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const result = await callTool<{ answer: string }>({
  client: new Anthropic({ apiKey: 'unused-test-key' }),
  provider: 'openai',
  providerModel: 'gpt-test',
  model: 'claude-sonnet-test',
  max_tokens: 100,
  system: 'Return the result.',
  user: 'Test input',
  tool: {
    name: 'return_result',
    description: 'Return a test result.',
    input_schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  },
  requiredKeys: ['answer'],
  retries: 0,
});

if (result.value.answer !== 'ok') throw new Error('OpenAI function arguments were not parsed');
if (requestBody.store !== false) throw new Error('OpenAI response storage was not disabled');
if (requestBody.tool_choice?.name !== 'return_result') throw new Error('Tool choice was not forced');
if (result.usage?.cache_read_input_tokens !== 3) throw new Error('Cached usage was not mapped');

console.log('Provider routing smoke test passed.');
