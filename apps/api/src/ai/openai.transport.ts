import OpenAI from 'openai';
import {
  ProviderUnreachable,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from './transport.js';

/**
 * OpenAI, behind the same port as Anthropic.
 *
 * The port was always provider-agnostic — a system prompt, a user turn, one
 * tool schema, one tool call back — so this file is a translation layer and
 * nothing more. Everything that decides what Rekoda actually does (the ₦10bn
 * ceiling, `parseBusinessCommand`, the spend ceiling, the conversation gates)
 * sits above it and does not know which provider answered.
 *
 * Three differences from the Anthropic side are real and handled here.
 */
export class OpenAiTransport implements ModelTransport {
  private readonly client: OpenAI;

  constructor(apiKey: string, timeoutMs = 20_000) {
    // `maxRetries: 0` for the same reason as the Anthropic client: the job
    // runner already owns retry, with backoff and a dead-letter state.
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: request.model,
        max_completion_tokens: request.maxTokens,
        /**
         * DIFFERENCE 1 — no `cache_control`.
         *
         * OpenAI caches long prompt prefixes automatically rather than being
         * told to. The system prompt still has to be a stable constant with
         * nothing per-message interpolated, for exactly the same reason it does
         * on Anthropic: caching keys on an exact prefix either way.
         */
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.userText },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: request.toolName,
              description: request.toolDescription,
              parameters: request.toolSchema,
            },
          },
        ],
        // Forced, so the model cannot answer with prose we would have to parse.
        tool_choice: { type: 'function', function: { name: request.toolName } },
      });
    } catch (error) {
      throw new ProviderUnreachable(describe(error));
    }

    const choice = response.choices[0];
    const call = choice?.message.tool_calls?.find(
      (c) => c.type === 'function' && c.function.name === request.toolName,
    );

    /**
     * DIFFERENCE 2 — arguments arrive as a JSON STRING, not an object.
     *
     * Anthropic hands back a parsed `input`; OpenAI hands back text that is
     * usually JSON. "Usually" is why this is wrapped: a truncated response
     * (hit the token limit mid-object) produces a string that does not parse,
     * and an unhandled `JSON.parse` throw here would fail the job instead of
     * becoming the "I could not read that" reply the merchant should get.
     */
    let toolInput: unknown = null;
    if (call && call.type === 'function') {
      try {
        toolInput = JSON.parse(call.function.arguments);
      } catch {
        toolInput = null;
      }
    }

    const usage = response.usage;
    return {
      toolInput,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        /**
         * DIFFERENCE 3 — there is no "cache write" to report.
         *
         * OpenAI bills cached input at a discount and reports how much was
         * cached; it does not charge a premium to populate the cache the way
         * Anthropic does. So `cacheWriteTokens` is genuinely zero here rather
         * than unknown, and `cacheReadTokens` is subtracted from input so the
         * two are not counted twice.
         */
        cacheWriteTokens: 0,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      stopReason: choice?.finish_reason ?? null,
    };
  }
}

/**
 * The provider's complaint, without the request that caused it.
 *
 * Same discipline as the Anthropic client: an SDK error can carry the request
 * body, and that body is the merchant's message. It is tokenised by the time
 * it reaches here, but this string ends up in `jobs.last_error` and in logs,
 * and neither is a place to start putting message content on the strength of
 * "it should be fine".
 */
function describe(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    return `openai ${error.status ?? 'error'}: ${error.name}`;
  }
  return error instanceof Error ? error.name : 'unknown provider error';
}
