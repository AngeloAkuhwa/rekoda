/**
 * The two model transports, against a real HTTP server.
 *
 * The properties worth pinning here are COST properties, and cost regressions
 * are silent by nature: nothing fails, the bill just goes up. `cache_control`
 * on the system prompt is the sharpest of them - it is what makes the largest
 * and most stable part of every request cost a tenth after the first call of
 * a window, and if it stopped being sent, every test in this repository would
 * still pass while the margin quietly inverted.
 *
 * Two correctness properties ride along. `tool_choice` names the tool, so the
 * model cannot answer with prose nobody is prepared to parse; and a provider
 * that cannot be reached raises `ProviderUnreachable` rather than a bad
 * answer, because the caller hands a merchant's quota slot back on that path
 * and must not hand it back on any other.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANTHROPIC_DEFAULT_BASE_URL, AnthropicTransport } from './anthropic.transport.js';
import { OPENAI_DEFAULT_BASE_URL, OpenAiTransport } from './openai.transport.js';
import { VisionTextExtraction } from './ocr.vision.js';
import { OpenAiSpeechToText } from './stt.openai.js';
import { ProviderUnreachable, type ModelRequest } from './transport.js';

let server: Server;
let baseUrl: string;
let bodies: Array<Record<string, unknown>>;
let respond: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies = [];
});

const REQUEST: ModelRequest = {
  model: 'claude-haiku-4-5',
  maxTokens: 700,
  system: 'You are Rekoda.',
  userText: 'CUSTOMER_7K2 bought 3 wigs for 150k',
  toolName: 'record_business_command',
  toolDescription: 'Record what happened',
  toolSchema: { type: 'object', properties: {} },
};

const json =
  (payload: unknown, status = 200) =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

describe('the Anthropic transport', () => {
  const transport = () => new AnthropicTransport('sk-test', 2_000, baseUrl);

  const ANSWER = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'record_business_command',
        input: { intent: 'RecordSale' },
      },
    ],
    usage: {
      input_tokens: 1_800,
      output_tokens: 120,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 700,
    },
  };

  it('marks the system prompt CACHEABLE, which is the whole margin', async () => {
    respond = json(ANSWER);
    await transport().send(REQUEST);

    /* If this silently stopped being sent, every test here would still pass
     * while input cost rose tenfold on the largest part of every request. */
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: 'You are Rekoda.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('FORCES the tool, so the model cannot answer with prose', async () => {
    respond = json(ANSWER);
    await transport().send(REQUEST);

    expect(bodies[0]?.tool_choice).toEqual({ type: 'tool', name: 'record_business_command' });
    // Parsing free text is the thing the whole schema exists to avoid.
    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: REQUEST.userText }]);
    expect(bodies[0]?.max_tokens).toBe(700);
  });

  it('reads the tool input and every usage counter, cache included', async () => {
    respond = json(ANSWER);
    const reply = await transport().send(REQUEST);

    expect(reply.toolInput).toEqual({ intent: 'RecordSale' });
    expect(reply.stopReason).toBe('tool_use');
    /* The cache counters are what the margin report is built from. Reading
     * them as zero would report a cost that never happened. */
    expect(reply.usage).toEqual({
      inputTokens: 1_800,
      outputTokens: 120,
      cacheWriteTokens: 900,
      cacheReadTokens: 700,
    });
  });

  it('answers null when the model returned no tool block, rather than guessing', async () => {
    respond = json({
      ...ANSWER,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I think she bought something' }],
    });
    const reply = await transport().send(REQUEST);
    // The caller treats this as unusable and refunds the merchant's unit.
    expect(reply.toolInput).toBeNull();
  });

  it('raises ProviderUnreachable on a provider error, so the quota slot goes back', async () => {
    respond = json({ type: 'error', error: { type: 'overloaded_error' } }, 529);
    await expect(transport().send(REQUEST)).rejects.toBeInstanceOf(ProviderUnreachable);
  });

  it('does NOT retry: the job runner owns retry, with backoff and a dead letter', async () => {
    respond = json({ type: 'error', error: { type: 'api_error' } }, 500);
    await expect(transport().send(REQUEST)).rejects.toBeInstanceOf(ProviderUnreachable);
    /* Two retry layers means a merchant waits through both, and a call the
     * SDK silently retried is one we were billed for twice. */
    expect(bodies).toHaveLength(1);
  });

  it('never puts the merchant text in the error it reports', async () => {
    respond = json({ type: 'error', error: { type: 'invalid_request_error' } }, 400);
    await expect(transport().send(REQUEST)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('CUSTOMER_7K2') as unknown as string,
      }),
    );
  });
});

describe('the OpenAI transport', () => {
  const transport = () => new OpenAiTransport('sk-test', 2_000, baseUrl);

  const ANSWER = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-4.1',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'record_business_command',
                arguments: JSON.stringify({ intent: 'RecordSale' }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1_800, completion_tokens: 120 },
  };

  it('forces the tool and reads its arguments back as an object', async () => {
    respond = json(ANSWER);
    const reply = await transport().send(REQUEST);

    expect(bodies[0]?.tool_choice).toMatchObject({
      type: 'function',
      function: { name: 'record_business_command' },
    });
    expect(reply.toolInput).toEqual({ intent: 'RecordSale' });
  });

  it('answers null on arguments that are not JSON, rather than throwing', async () => {
    respond = json({
      ...ANSWER,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'record_business_command', arguments: '{not json' },
              },
            ],
          },
        },
      ],
    });
    /* Unusable, not unreachable: the provider answered and billed us, so the
     * merchant's quota slot is NOT handed back on this path. */
    expect((await transport().send(REQUEST)).toolInput).toBeNull();
  });

  /* G-07: OpenAI's `prompt_tokens` INCLUDES the cached tokens
   * (`prompt_tokens_details.cached_tokens`, "cached tokens present in the
   * prompt"). Reported as both input and cache read, they were priced twice. */
  it('prices each input token once: cached tokens are not also ordinary input', async () => {
    respond = json({
      ...ANSWER,
      usage: {
        prompt_tokens: 2_006,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 1_920 },
      },
    });
    const { usage } = await transport().send(REQUEST);
    expect(usage.inputTokens).toBe(86);
    expect(usage.cacheReadTokens).toBe(1_920);
    expect(usage.inputTokens + (usage.cacheReadTokens ?? 0)).toBe(2_006);
  });

  it('raises ProviderUnreachable on a provider error', async () => {
    respond = json({ error: { message: 'boom' } }, 500);
    await expect(transport().send(REQUEST)).rejects.toBeInstanceOf(ProviderUnreachable);
  });
});

/**
 * With no AI_BASE_URL each SDK would read OPENAI_BASE_URL / ANTHROPIC_BASE_URL
 * from the process, so an exported proxy variable would silently redirect the
 * primary, or the "independent" OpenAI verifier, while the eval report named
 * the provider's own endpoint (final review on a98a294). The endpoint is what
 * Rekoda's configuration says, never what the environment happens to hold.
 */
describe('the endpoint a transport calls', () => {
  const endpointOf = (transport: object): string =>
    (transport as unknown as { client: { baseURL: string } }).client.baseURL;

  it('ignores OPENAI_BASE_URL and ANTHROPIC_BASE_URL in the environment', () => {
    const saved = {
      openai: process.env.OPENAI_BASE_URL,
      anthropic: process.env.ANTHROPIC_BASE_URL,
    };
    process.env.OPENAI_BASE_URL = 'https://proxy.example.test/v1';
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test';
    try {
      expect(endpointOf(new OpenAiTransport('sk-test'))).toBe(OPENAI_DEFAULT_BASE_URL);
      expect(endpointOf(new AnthropicTransport('sk-test'))).toBe(ANTHROPIC_DEFAULT_BASE_URL);
      /* The transcriber and the photo reader carry a merchant's audio and
       * images, so they are held to the same rule. */
      expect(endpointOf(new OpenAiSpeechToText('sk-test', 'whisper-1'))).toBe(
        OPENAI_DEFAULT_BASE_URL,
      );
      expect(endpointOf(new VisionTextExtraction('sk-test', 'claude-sonnet-5'))).toBe(
        ANTHROPIC_DEFAULT_BASE_URL,
      );
      /* A configured endpoint is still the one used. */
      expect(endpointOf(new OpenAiTransport('sk-test', 1_000, baseUrl))).toBe(baseUrl);
    } finally {
      for (const [name, value] of [
        ['OPENAI_BASE_URL', saved.openai],
        ['ANTHROPIC_BASE_URL', saved.anthropic],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('SDK telemetry', () => {
  const tracesOf = (transport: object): { enabled: boolean } =>
    (transport as unknown as { client: { openTelemetry: { traces: { enabled: boolean } } } }).client
      .openTelemetry.traces;

  /* The Anthropic SDK (0.134+) opens OpenTelemetry spans by default and can
   * carry message content when a provider is registered. Prompts and photos
   * are the merchant's data, so the clients opt out in code and no later APM
   * setup or environment variable can switch them back on (invariant 4). */
  it('keeps the Anthropic clients out of OpenTelemetry, whatever the environment says', () => {
    const saved = process.env.ANTHROPIC_OPEN_TELEMETRY;
    process.env.ANTHROPIC_OPEN_TELEMETRY = 'true';
    try {
      expect(tracesOf(new AnthropicTransport('sk-test')).enabled).toBe(false);
      expect(tracesOf(new VisionTextExtraction('sk-test', 'claude-sonnet-5')).enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_OPEN_TELEMETRY;
      else process.env.ANTHROPIC_OPEN_TELEMETRY = saved;
    }
  });
});
