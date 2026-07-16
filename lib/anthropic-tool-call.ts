/**
 * Forced-tool-call helper with retry on transient failures.
 *
 * Why this exists:
 * - Pre-tool-use, the feedback pipeline asked Claude for JSON in a prompt,
 *   then brace-walked + JSON.parsed the response. That occasionally failed
 *   (unescaped quotes from quoted student text, drift from the schema, etc.)
 *   and surfaced as "Could not parse feedback" to users.
 * - Tool calls with `tool_choice: { type: 'tool', name }` make the SDK return
 *   structured input that already conforms to the tool's input_schema. The
 *   parse step disappears.
 * - Network/rate-limit/transient API errors still happen; this helper retries
 *   them once with a small backoff so users never see them on a single
 *   pitch-meeting attempt.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type AIProvider = 'anthropic' | 'openai';

interface CallToolOptions {
  /** Optional injected Anthropic client (tests and the maths verifier). */
  client?: Anthropic;
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  /** Plain text, or content blocks (e.g. text + an image) for vision calls. */
  user: string | Anthropic.Messages.ContentBlockParam[];
  tool: Anthropic.Messages.Tool;
  /** Number of additional attempts after the first (default 3 → 4 attempts total). */
  retries?: number;
  /**
   * When true, the `system` string is sent as a cache_control:ephemeral block
   * so Anthropic caches the tools+system prefix (5-min TTL). The system prompt
   * for a given (course, stage) is byte-identical across every student, so a
   * classroom burst on the same task pays one cache write then cheap reads
   * (~10× cheaper input) for the rest. No effect on output quality — same
   * tokens, just cached. Caching only kicks in above Anthropic's minimum
   * cacheable prefix (~1024 tok for Sonnet); smaller prompts are a silent
   * no-op, so enabling it is always safe.
   */
  cacheSystem?: boolean;
  /** Short label for the usage log line (e.g. "feedback:holistic"). */
  label?: string;
  /**
   * Keys the tool output must contain (and be non-empty) to count as a usable
   * result. If any is missing — typically because a max_tokens truncation cut
   * into the student-facing fields — callTool throws instead of returning
   * gutted feedback that would persist and burn one of the student's drafts.
   * Optional fields (e.g. trailing skill_assessment, ordered last in the
   * schema so truncation drops them first) should NOT be listed here.
   */
  requiredKeys?: string[];
  /** Override environment-based provider routing (primarily for evaluations). */
  provider?: AIProvider;
  /** Override the provider-specific model selected from the environment. */
  providerModel?: string;
  /** Permit a retryable OpenAI failure to fall back to Anthropic. */
  allowFallback?: boolean;
}

interface CallTextOptions {
  client?: Anthropic;
  model: string;
  max_tokens: number;
  system: string;
  user: string;
  retries?: number;
  label?: string;
  provider?: AIProvider;
  providerModel?: string;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null
    || (typeof v === 'string' && v.trim() === '')
    || (Array.isArray(v) && v.length === 0);
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ToolCallResult<T> {
  value: T;
  attempts: number;
  stop_reason: string | null;
  usage: TokenUsage | null;
}

export async function callTool<T = unknown>(opts: CallToolOptions): Promise<ToolCallResult<T>> {
  const provider = resolveProvider(opts);
  try {
    return provider === 'openai'
      ? await callOpenAITool<T>(opts)
      : await callAnthropicTool<T>(opts);
  } catch (err) {
    if (!shouldFallbackToAnthropic(provider, opts.allowFallback, !!opts.client, err)) throw err;
    console.warn(
      `[provider-fallback] label=${opts.label || opts.tool.name} from=openai to=anthropic ` +
      `reason=${safeErrorSummary(err)}`,
    );
    return callAnthropicTool<T>({ ...opts, provider: 'anthropic' });
  }
}

async function callAnthropicTool<T = unknown>(opts: CallToolOptions): Promise<ToolCallResult<T>> {
  const { client = getAnthropicClient(), model, max_tokens, temperature, system, user, tool, retries = 3, cacheSystem, label, requiredKeys } = opts;
  const totalAttempts = retries + 1;
  let lastErr: unknown;

  // A cached system is sent as a single ephemeral text block; the cache key
  // covers everything before it in the prompt (tools + system).
  const systemParam: string | Anthropic.Messages.TextBlockParam[] = cacheSystem
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  // A soft output failure (no tool_use block, or output incomplete/truncated)
  // is billed on every attempt — the API call itself succeeded — so unlike a
  // network error it gets at most ONE retry.
  let softFailureRetried = false;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens,
        // Sonnet 5 rejects `temperature` (deprecated for the model); only send
        // it when a caller explicitly set one (e.g. the Haiku insights pass).
        ...(temperature !== undefined ? { temperature } : {}),
        system: systemParam,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: user }],
      });

      const usage = extractUsage(resp);
      logUsage(label || tool.name, model, usage);

      const stopReason = (resp as any).stop_reason || null;
      const block = resp.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`Model did not return a tool_use block for ${tool.name} (stop_reason=${stopReason || 'unknown'})`);
      }

      const value = block.input as T;
      // Required-key validation: a max_tokens truncation can return a partial
      // tool input. Reject it here so the caller doesn't persist gutted
      // feedback (which would also count as one of the student's 3 drafts).
      if (requiredKeys && requiredKeys.length) {
        const missing = requiredKeys.filter((k) => isEmptyValue((value as any)?.[k]));
        if (missing.length) {
          const trunc = stopReason === 'max_tokens' ? ' (output truncated at max_tokens)' : '';
          const returned = value && typeof value === 'object' ? Object.keys(value as any).join(', ') : typeof value;
          throw new Error(
            `Tool ${tool.name} returned incomplete output${trunc}; missing: ${missing.join(', ')}; ` +
            `stop_reason=${stopReason || 'unknown'}; returned_keys=[${returned}]`,
          );
        }
      }

      return {
        value,
        attempts: attempt,
        stop_reason: stopReason,
        usage,
      };
    } catch (err: any) {
      lastErr = err;
      if (attempt >= totalAttempts) break;
      if (!isTransient(err)) break;
      if (isSoftOutputFailure(err)) {
        if (softFailureRetried) break;
        softFailureRetried = true;
      }
      const base = 1000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }

  throw lastErr;
}

/** Provider-routed plain-text generation for the few authoring endpoints that
 * intentionally do not use a structured tool schema. */
export async function callText(opts: CallTextOptions): Promise<ToolCallResult<string>> {
  const provider = resolveProvider(opts);
  const totalAttempts = (opts.retries ?? 3) + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      if (provider === 'openai') {
        const model = resolveOpenAIModel(opts);
        const resp = await getOpenAIClient().responses.create({
          model,
          instructions: opts.system,
          input: opts.user,
          max_output_tokens: opts.max_tokens,
          store: false,
        });
        const usage = extractOpenAIUsage(resp);
        logUsage(opts.label || 'text', model, usage, 'openai');
        const value = resp.output_text.trim();
        if (!value) throw new Error('Model returned empty text output');
        return { value, attempts: attempt, stop_reason: resp.status ?? null, usage };
      }

      const resp = await (opts.client ?? getAnthropicClient()).messages.create({
        model: opts.model,
        max_tokens: opts.max_tokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      });
      const usage = extractUsage(resp);
      logUsage(opts.label || 'text', opts.model, usage);
      const block = resp.content.find((item) => item.type === 'text');
      const value = block?.type === 'text' ? block.text.trim() : '';
      if (!value) throw new Error('Model returned empty text output');
      return { value, attempts: attempt, stop_reason: (resp as any).stop_reason ?? null, usage };
    } catch (err: any) {
      lastErr = err;
      if (attempt >= totalAttempts || !isTransient(err)) break;
      const base = 1000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, base + jitter));
    }
  }
  throw lastErr;
}

let openAIClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return anthropicClient;
}

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  if (!openAIClient) openAIClient = new OpenAI({ apiKey, maxRetries: 0 });
  return openAIClient;
}

function isFastWorkload(model: string): boolean {
  return /haiku|mini|nano/i.test(model);
}

function resolveProvider(opts: Pick<CallToolOptions, 'provider' | 'model'>): AIProvider {
  if (opts.provider) return opts.provider;
  const tierKey = isFastWorkload(opts.model) ? 'AI_FAST_PROVIDER' : 'AI_PRIMARY_PROVIDER';
  const configured = process.env[tierKey] || process.env.AI_PROVIDER || 'anthropic';
  if (configured !== 'anthropic' && configured !== 'openai') {
    throw new Error(`${tierKey} must be "anthropic" or "openai"`);
  }
  return configured;
}

function resolveOpenAIModel(opts: Pick<CallToolOptions, 'model' | 'providerModel'>): string {
  if (opts.providerModel) return opts.providerModel;
  return isFastWorkload(opts.model)
    ? process.env.OPENAI_FAST_MODEL || 'gpt-5.4-nano'
    : process.env.OPENAI_PRIMARY_MODEL || 'gpt-5.6-terra';
}

function openAIUserContent(user: CallToolOptions['user']): any {
  if (typeof user === 'string') return user;
  return user.map((block: any) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    if (block.type === 'image' && block.source?.type === 'base64') {
      return {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
      };
    }
    throw new Error(`Unsupported OpenAI input block: ${String(block.type)}`);
  });
}

async function callOpenAITool<T>(opts: CallToolOptions): Promise<ToolCallResult<T>> {
  const { max_tokens, system, user, tool, retries = 3, label, requiredKeys } = opts;
  const model = resolveOpenAIModel(opts);
  const totalAttempts = retries + 1;
  let lastErr: unknown;
  let softFailureRetried = false;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const resp = await getOpenAIClient().responses.create({
        model,
        instructions: system,
        input: [{ role: 'user', content: openAIUserContent(user) }],
        max_output_tokens: max_tokens,
        tools: [{
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema as Record<string, unknown>,
          // Existing schemas intentionally contain optional fields. Non-strict
          // calling preserves them; required-key validation remains the final
          // persistence guard.
          strict: false,
        }],
        tool_choice: { type: 'function', name: tool.name },
        // Calls are independent and contain student work. Do not retain
        // response state server-side.
        store: false,
      });

      const usage = extractOpenAIUsage(resp);
      logUsage(label || tool.name, model, usage, 'openai');

      const call = resp.output.find((item: any) => item.type === 'function_call' && item.name === tool.name) as any;
      if (!call) {
        const refusal = resp.output
          .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
          .find((item: any) => item.type === 'refusal');
        if (refusal) {
          throw new Error(`OpenAI refusal: ${String(refusal.refusal || 'request refused').slice(0, 160)}`);
        }
        throw new Error(`Model did not return a function_call for ${tool.name} (status=${resp.status})`);
      }
      const value = JSON.parse(call.arguments) as T;
      if (requiredKeys?.length) {
        const missing = requiredKeys.filter((key) => isEmptyValue((value as any)?.[key]));
        if (missing.length) {
          const returned = value && typeof value === 'object' ? Object.keys(value as any).join(', ') : typeof value;
          throw new Error(
            `Tool ${tool.name} returned incomplete output; missing: ${missing.join(', ')}; ` +
            `status=${resp.status || 'unknown'}; returned_keys=[${returned}]`,
          );
        }
      }

      return { value, attempts: attempt, stop_reason: resp.status ?? null, usage };
    } catch (err: any) {
      lastErr = err;
      if (attempt >= totalAttempts || !isTransient(err)) break;
      if (isSoftOutputFailure(err)) {
        if (softFailureRetried) break;
        softFailureRetried = true;
      }
      const base = 1000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, base + jitter));
    }
  }
  throw lastErr;
}

function extractUsage(resp: any): TokenUsage {
  const u = resp?.usage || {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

function extractOpenAIUsage(resp: any): TokenUsage {
  const totalInput = resp?.usage?.input_tokens ?? 0;
  const cached = resp?.usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = resp?.usage?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    // OpenAI reports cached/written tokens as subsets of input_tokens, whereas
    // Anthropic reports them in separate top-level buckets. Normalise to the
    // Anthropic-style non-overlapping buckets used by ProofReady's logger.
    input_tokens: Math.max(0, totalInput - cached - cacheWrite),
    output_tokens: resp?.usage?.output_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
  };
}

/**
 * Structured usage line for cost observability (Vercel logs). Cache-hit rate
 * and per-call token counts are the inputs to the real cost picture; without
 * this the only signal is the monthly Anthropic bill.
 */
function logUsage(label: string, model: string, u: TokenUsage, provider: AIProvider = 'anthropic'): void {
  const cached = u.cache_read_input_tokens;
  const total = u.input_tokens + cached + u.cache_creation_input_tokens;
  const hitPct = total > 0 ? Math.round((cached / total) * 100) : 0;
  console.log(
    `[usage] ${label} provider=${provider} model=${model} in=${u.input_tokens} out=${u.output_tokens} ` +
    `cache_read=${cached} cache_write=${u.cache_creation_input_tokens} cache_hit=${hitPct}%`,
  );
}

function shouldFallbackToAnthropic(
  provider: AIProvider,
  allowed: boolean | undefined,
  hasInjectedClient: boolean,
  err: unknown,
): boolean {
  if (provider !== 'openai' || !allowed) return false;
  if (process.env.AI_FALLBACK_PROVIDER !== 'anthropic') return false;
  if (!process.env.ANTHROPIC_API_KEY && !hasInjectedClient) return false;
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  const message = String((err as any)?.message || err || '');
  if (/refusal|content.?filter|safety|policy/i.test(message)) return false;
  return isTransient(err);
}

function safeErrorSummary(err: unknown): string {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  const message = String((err as any)?.message || err || 'unknown').replace(/\s+/g, ' ').slice(0, 180);
  return `${status ? `status=${status} ` : ''}${message}`;
}

function isSoftOutputFailure(err: any): boolean {
  return /did not return a (tool_use|function_call)|incomplete output|empty text output|JSON/i.test(String(err?.message || err || ''));
}

function isTransient(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const msg = String(err?.message || err || '');
  return /timeout|network|ETIMEDOUT|ECONN|fetch failed|tool_use|function_call|did not return|incomplete output|empty text output|JSON|overloaded|rate.?limit/i.test(msg);
}
