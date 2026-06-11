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

import type Anthropic from '@anthropic-ai/sdk';

interface CallToolOptions {
  client: Anthropic;
  model: string;
  max_tokens: number;
  temperature?: number;
  system: string;
  user: string;
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
  const { client, model, max_tokens, temperature, system, user, tool, retries = 3, cacheSystem, label, requiredKeys } = opts;
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
        temperature,
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
          throw new Error(`Tool ${tool.name} returned incomplete output${trunc}; missing: ${missing.join(', ')}`);
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

function extractUsage(resp: any): TokenUsage {
  const u = resp?.usage || {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Structured usage line for cost observability (Vercel logs). Cache-hit rate
 * and per-call token counts are the inputs to the real cost picture; without
 * this the only signal is the monthly Anthropic bill.
 */
function logUsage(label: string, model: string, u: TokenUsage): void {
  const cached = u.cache_read_input_tokens;
  const total = u.input_tokens + cached + u.cache_creation_input_tokens;
  const hitPct = total > 0 ? Math.round((cached / total) * 100) : 0;
  console.log(
    `[usage] ${label} model=${model} in=${u.input_tokens} out=${u.output_tokens} ` +
    `cache_read=${cached} cache_write=${u.cache_creation_input_tokens} cache_hit=${hitPct}%`,
  );
}

function isSoftOutputFailure(err: any): boolean {
  return /did not return a tool_use|incomplete output/i.test(String(err?.message || err || ''));
}

function isTransient(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const msg = String(err?.message || err || '');
  return /timeout|network|ETIMEDOUT|ECONN|fetch failed|tool_use|did not return|incomplete output|overloaded|rate.?limit/i.test(msg);
}
