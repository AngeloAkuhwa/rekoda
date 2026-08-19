import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderUnreachable,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from './transport.js';

/**
 * The real client.
 *
 * Two things here are not incidental.
 *
 * **Prompt caching.** The system prompt carries `cache_control: ephemeral`, so
 * after the first call of a five-minute window it is served from cache at a
 * tenth of the input price. It is the largest and most stable part of every
 * request, which is exactly what caching is for — and why the prompt is a
 * constant with nothing per-message interpolated into it. One merchant's name
 * in there would break the prefix for everybody.
 *
 * **Forced tool use.** `tool_choice` names the tool, so the model cannot
 * answer with prose. A free-text reply would have to be parsed by us, and
 * parsing free text is the thing this whole schema exists to avoid.
 */
export class AnthropicTransport implements ModelTransport {
  private readonly client: Anthropic;

  constructor(apiKey: string, timeoutMs = 20_000) {
    /**
     * `maxRetries: 0` — the job runner already owns retry, with backoff and a
     * dead-letter state. Two retry layers means a merchant waits through both,
     * and a call the SDK silently retried is a call we were billed for twice
     * and recorded once.
     */
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  }

  async send(request: ModelRequest): Promise<ModelReply> {
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: 'text',
            text: request.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: request.toolName,
            description: request.toolDescription,
            input_schema: request.toolSchema as Anthropic.Messages.Tool['input_schema'],
          },
        ],
        tool_choice: { type: 'tool', name: request.toolName },
        messages: [{ role: 'user', content: request.userText }],
      });
    } catch (error) {
      /**
       * Distinguished from a bad response on purpose. Nothing was billed here,
       * so the caller hands the merchant's quota slot back — being unable to
       * reach a provider must not cost a merchant one of their daily calls.
       */
      throw new ProviderUnreachable(describe(error));
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock =>
        block.type === 'tool_use' && block.name === request.toolName,
    );

    return {
      toolInput: toolUse?.input ?? null,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      stopReason: response.stop_reason,
    };
  }
}

/**
 * The provider's complaint, without the request that caused it.
 *
 * An SDK error can carry the request body, and the request body is the
 * merchant's message. It is tokenised by the time it gets here, but this
 * string ends up in `jobs.last_error` and in logs, and neither is a place to
 * start putting message content on the strength of "it should be fine".
 */
function describe(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return `anthropic ${error.status ?? 'error'}: ${error.name}`;
  }
  return error instanceof Error ? error.name : 'unknown provider error';
}
