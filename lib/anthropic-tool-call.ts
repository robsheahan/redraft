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
}

export interface ToolCallResult<T> {
  value: T;
  attempts: number;
  stop_reason: string | null;
}

export async function callTool<T = unknown>(opts: CallToolOptions): Promise<ToolCallResult<T>> {
  const { client, model, max_tokens, temperature, system, user, tool, retries = 3 } = opts;
  const totalAttempts = retries + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens,
        temperature,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: user }],
      });

      const block = resp.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(`Model did not return a tool_use block for ${tool.name} (stop_reason=${(resp as any).stop_reason || 'unknown'})`);
      }

      return {
        value: block.input as T,
        attempts: attempt,
        stop_reason: (resp as any).stop_reason || null,
      };
    } catch (err: any) {
      lastErr = err;
      if (attempt >= totalAttempts) break;
      if (!isTransient(err)) break;
      const base = 1000 * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }

  throw lastErr;
}

function isTransient(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const msg = String(err?.message || err || '');
  return /timeout|network|ETIMEDOUT|ECONN|fetch failed|tool_use|did not return|overloaded|rate.?limit/i.test(msg);
}
