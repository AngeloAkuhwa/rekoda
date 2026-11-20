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
 * **Tool input only from a finished tool call.** Input is read only from an
 * answer that finished (`FINISHED_STOPS`) with exactly one call, under the
 * offered name. A refusal, a cut-off answer, a second call or a block naming
 * any other tool yields no input at all.
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
      FINISHED_STOPS.has(response.stop_reason ?? '') &&
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
        ? { refusalCategory: refusalCategoryOf(response.stop_details?.category) }
        : {}),
    };
  }
}

/**
 * The stops after which a tool call is complete. The Anthropic API reports a
 * tool call as `tool_use`; a compatible gateway behind AI_BASE_URL may say
 * `end_turn` or `stop_sequence` for the same finished answer. Everything else
 * (`refusal`, `max_tokens`, `model_context_window_exceeded`, `pause_turn`,
 * an unknown value) is refused or incomplete, and yields no input.
 */
const FINISHED_STOPS = new Set(['tool_use', 'end_turn', 'stop_sequence']);

/**
 * The API's own error types. Anything else in that field came from somewhere
 * that is not the Anthropic API (a gateway can put any text there) and is not
 * repeated into logs or `jobs.last_error`.
 */
const KNOWN_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
]);

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
    /* Every SDK error is named "Error", so the class is what tells a timeout
     * (acceptance counts these for the G-134 latency decision) from a
     * dropped connection. Order matters: a timeout IS a connection error. */
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return 'anthropic timeout: APIConnectionTimeoutError';
    }
    if (error instanceof Anthropic.APIConnectionError) return 'anthropic error: APIConnectionError';
    const type = error.type && KNOWN_ERROR_TYPES.has(error.type) ? error.type : className(error);
    return `anthropic ${error.status ?? 'error'}: ${type}`;
  }
  return error instanceof Error ? error.name : 'unknown provider error';
}

/** The SDK's own error classes, by name: code, never text from a response. */
const ERROR_CLASSES: Array<[new (...args: never[]) => Error, string]> = [
  [Anthropic.BadRequestError, 'BadRequestError'],
  [Anthropic.AuthenticationError, 'AuthenticationError'],
  [Anthropic.PermissionDeniedError, 'PermissionDeniedError'],
  [Anthropic.NotFoundError, 'NotFoundError'],
  [Anthropic.ConflictError, 'ConflictError'],
  [Anthropic.UnprocessableEntityError, 'UnprocessableEntityError'],
  [Anthropic.RateLimitError, 'RateLimitError'],
  [Anthropic.InternalServerError, 'InternalServerError'],
];

function className(error: Error): string {
  return ERROR_CLASSES.find(([cls]) => error instanceof cls)?.[1] ?? 'APIError';
}

/**
 * The API's refusal categories. The value is stored on a usage row, so
 * anything outside this list (a gateway can put any text there) is stored as
 * `unrecognised`, never as itself.
 */
const REFUSAL_CATEGORIES = new Set([
  'cyber',
  'bio',
  'frontier_llm',
  'reasoning_extraction',
  'general_harms',
]);

function refusalCategoryOf(category: string | null | undefined): string | null {
  if (category === null || category === undefined) return null;
  return REFUSAL_CATEGORIES.has(category) ? category : 'unrecognised';
}
