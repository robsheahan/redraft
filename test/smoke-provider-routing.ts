/** Offline coverage for provider routing, usage normalisation, vision and fallback. */

import { callTool } from '../lib/anthropic-tool-call.js';

process.env.OPENAI_API_KEY = 'test-key';

let requestBody: any;
let openAIStatus = 200;
let responseArguments = '{"answer":"ok"}';
let responseKind: 'function' | 'refusal' = 'function';

globalThis.fetch = (async (_input: any, init?: any) => {
  requestBody = JSON.parse(String(init?.body || '{}'));
  if (openAIStatus !== 200) {
    return new Response(JSON.stringify({ error: { message: 'temporary outage', type: 'server_error' } }), {
      status: openAIStatus,
      headers: { 'content-type': 'application/json' },
    });
  }
  const output = responseKind === 'refusal'
    ? [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'synthetic refusal' }] }]
    : [{
        id: 'fc_test', type: 'function_call', call_id: 'call_test', name: 'return_result',
        arguments: responseArguments, status: 'completed',
      }];
  return new Response(JSON.stringify({
    id: 'resp_test', object: 'response', created_at: 0, status: 'completed', model: 'gpt-test',
    output,
    usage: {
      input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const tool = {
  name: 'return_result',
  description: 'Return a test result.',
  input_schema: {
    type: 'object' as const,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
};

const result = await callTool<{ answer: string }>({
  provider: 'openai', providerModel: 'gpt-test', model: 'claude-sonnet-test',
  max_tokens: 100, system: 'Return the result.', user: 'Test input', tool,
  requiredKeys: ['answer'], retries: 0,
});

if (result.value.answer !== 'ok') throw new Error('OpenAI function arguments were not parsed');
if (requestBody.store !== false) throw new Error('OpenAI response storage was not disabled');
if (requestBody.tool_choice?.name !== 'return_result') throw new Error('Tool choice was not forced');
if (result.usage?.input_tokens !== 5) throw new Error('OpenAI input usage buckets overlap');
if (result.usage?.cache_read_input_tokens !== 3) throw new Error('Cached usage was not mapped');
if (result.usage?.cache_creation_input_tokens !== 2) throw new Error('Cache-write usage was not mapped');

process.env.AI_FAST_PROVIDER = 'openai';
await callTool<{ answer: string }>({
  model: 'claude-haiku-test', providerModel: 'gpt-fast-test', max_tokens: 100,
  system: 'Read the image.',
  user: [
    { type: 'text', text: 'Transcribe.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ],
  tool, retries: 0,
});
if (requestBody.model !== 'gpt-fast-test') throw new Error('Fast-tier model override was not used');
const image = requestBody.input?.[0]?.content?.find((item: any) => item.type === 'input_image');
if (image?.image_url !== 'data:image/png;base64,aGVsbG8=') throw new Error('Vision input was not converted');

process.env.AI_FALLBACK_PROVIDER = 'anthropic';
openAIStatus = 500;
const anthropicClient = {
  messages: {
    create: async () => {
      anthropicCalls += 1;
      return ({
      content: [{ type: 'tool_use', name: 'return_result', input: { answer: 'fallback-ok' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  },
} as any;
let anthropicCalls = 0;
const fallback = await callTool<{ answer: string }>({
  client: anthropicClient, provider: 'openai', providerModel: 'gpt-test',
  model: 'claude-sonnet-test', max_tokens: 100, system: 'Return the result.',
  user: 'Test fallback.', tool, requiredKeys: ['answer'], retries: 0, allowFallback: true,
});
if (fallback.value.answer !== 'fallback-ok') throw new Error('Retryable OpenAI failure did not fall back');

openAIStatus = 200;
responseKind = 'refusal';
let refused = false;
try {
  await callTool({
    client: anthropicClient, provider: 'openai', providerModel: 'gpt-test',
    model: 'claude-sonnet-test', max_tokens: 100, system: 'Return the result.',
    user: 'Test refusal.', tool, retries: 0, allowFallback: true,
  });
} catch (error) {
  refused = /OpenAI refusal/.test(String((error as Error).message));
}
if (!refused) throw new Error('OpenAI refusal was not preserved');
if (anthropicCalls !== 1) throw new Error('OpenAI refusal incorrectly fell back to Anthropic');

console.log('Provider routing smoke test passed.');
