import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderUnreachable,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from './transport.js';
import { buildAnthropicClient } from './anthropic.client.js';
import { strictToolSchema } from './strict-schema.js';

export { ANTHROPIC_DEFAULT_BASE_URL } from './anthropic.client.js';

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
 * **One tool, asked for, never forced.** `tool_choice` is `auto` with
 * parallel calls off, so the model calls the one tool at most once. It used
 * to name the tool (`type: 'tool'`), and Claude Sonnet 5.5, Claude Opus 5.5
 * and Claude Fable 5.1 and 5.2 refuse that with a 400 ("tool_choice: type
 * "tool" and "any" are not supported for this model"), which on staging
 * (20 Nov 2026) turned every interpretation into a failed call. `auto` is
 * accepted by every Claude model, so the request has one shape whatever the
 * configured model is, and no model ID ever selects a different contract.
 * The system prompt already demands exactly one call and no text.
 *
 * Without forcing, "the model answered in prose" is an ordinary outcome
 * rather than an impossible one, and the reader below treats it exactly as
 * before: no tool input, which the interpreter reports as unusable (and may
 * escalate once). Prose is never parsed.
 *
 * **Strict where the schema allows it.** A schema inside the strict-mode
 * limits is sent with `strict: true`, so the model's input matches it by
 * construction (`strict-schema.ts`). One outside them is sent as before,
 * without `strict`: the API refuses an over-limit strict schema with a 400.
 * Either way the caller parses the answer with its own schema, which stays
 * the only authority on whether a command exists.
 *
 * **Tool input only from a finished tool call.** Input is read only when the
 * model stopped BECAUSE it called the tool (`stop_reason: tool_use`), once,
 * under the offered name. A refusal, a cut-off answer, a second call or a
 * block naming any other tool yields no input at all.
 */
export class AnthropicTransport implements ModelTransport {
  private readonly client: Anthropic;

  constructor(apiKey: string, timeoutMs = 20_000, baseUrl?: string) {
    this.client = buildAnthropicClient(apiKey, timeoutMs, baseUrl);
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
        tools: [toolDefinition(request)],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: request.userText }],
      });
    } catch (error) {
      /**
       * Distinguished from a bad response: nothing was billed here,
       * so the caller hands the merchant's quota slot back — being unable to
       * reach a provider must not cost a merchant one of their daily calls.
       */
      throw new ProviderUnreachable(describe(error));
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
    );
    const [only] = toolUses;
    const toolInput =
      response.stop_reason === 'tool_use' &&
      toolUses.length === 1 &&
      only?.name === request.toolName
        ? only.input
        : null;

    return {
      toolInput,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      stopReason: response.stop_reason,
      ...(response.stop_reason === 'refusal'
        ? { refusalCategory: response.stop_details?.category ?? null }
        : {}),
    };
  }
}

/**
 * Strictness is decided once per schema object: the interpreter and the
 * classifier each pass the same constant on every call, and the tool
 * definition is part of the cached prompt prefix, so it must not vary.
 */
const strictForms = new WeakMap<object, ReturnType<typeof strictToolSchema>>();

function toolDefinition(request: ModelRequest): Anthropic.Messages.Tool {
  let strict = strictForms.get(request.toolSchema);
  if (!strict) {
    strict = strictToolSchema(request.toolSchema);
    strictForms.set(request.toolSchema, strict);
  }
  return strict.ok
    ? {
        name: request.toolName,
        description: request.toolDescription,
        input_schema: strict.schema as Anthropic.Messages.Tool['input_schema'],
        strict: true,
      }
    : {
        name: request.toolName,
        description: request.toolDescription,
        input_schema: request.toolSchema as Anthropic.Messages.Tool['input_schema'],
      };
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
    /* `type` is the API's fixed error vocabulary (`invalid_request_error`,
     * `overloaded_error`); the message is not, and can quote the request.
     * Staging logged "anthropic 400: Error" for a 400 whose type said why. */
    return `anthropic ${error.status ?? 'error'}: ${error.type ?? error.name}`;
  }
  return error instanceof Error ? error.name : 'unknown provider error';
}
