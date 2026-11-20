/**
 * How the Anthropic transport asks for the tool and reads the answer (G-134),
 * against a real HTTP server.
 *
 * Staging (20 Nov 2026) ran claude-sonnet-5-5, which refuses a forced
 * tool_choice with a 400; every interpretation failed. These pin the request
 * every Claude model accepts (`auto`, one call at most, strict only where the
 * schema fits) and the rule that tool input comes only from one finished call
 * to the offered tool. The cost and credential properties of the same
 * transport are in transports.test.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicTransport } from './anthropic.transport.js';
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

  /* Staging, 20 Nov 2026: claude-sonnet-5-5 answered every interpretation with
   * 400 invalid_request_error "tool_choice: type "tool" and "any" are not
   * supported for this model." Claude Sonnet 5.5, Opus 5.5 and Fable 5.1/5.2
   * refuse forced tool choice; `auto` is accepted by every Claude model. */
  it('never forces the tool: auto with at most one call, which every Claude model accepts', async () => {
    respond = json(ANSWER);
    await transport().send(REQUEST);

    expect(bodies[0]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(bodies[0]?.tool_choice).not.toMatchObject({ type: 'tool' });
    expect(bodies[0]?.tool_choice).not.toMatchObject({ type: 'any' });
    // Parsing free text is the thing the whole schema exists to avoid.
    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: REQUEST.userText }]);
    expect(bodies[0]?.max_tokens).toBe(700);
  });

  it('builds the same request for every model: the Sonnet 5.5 primary and the Opus 5.5 escalation', async () => {
    respond = json(ANSWER);
    for (const model of [
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]) {
      await transport().send({ ...REQUEST, model });
    }
    const withoutModel = bodies.map(({ model: _model, ...rest }) => rest);
    expect(bodies.map((b) => b.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    /* No model-specific branch: one request shape, so a model ID can never
     * pick a different contract (the G-59 lesson about matching model names). */
    for (const body of withoutModel) expect(body).toEqual(withoutModel[0]);
  });

  it('marks a tool STRICT when its schema is within the strict-mode limits', async () => {
    respond = json(ANSWER);
    const schema = {
      type: 'object',
      properties: { type: { type: 'string', enum: ['receipt', 'invoice', 'unsure'] } },
      required: ['type'],
      additionalProperties: false,
    };
    await transport().send({ ...REQUEST, toolSchema: schema });

    expect(bodies[0]?.tools).toEqual([
      {
        name: 'record_business_command',
        description: 'Record what happened',
        input_schema: schema,
        strict: true,
      },
    ]);
  });

  it('sends a schema strict mode would reject WITHOUT strict, unchanged, rather than earn a 400', async () => {
    respond = json(ANSWER);
    /* Seventeen nullable fields: one more union-typed parameter than the
     * documented strict limit of 16, which the API refuses with a 400. */
    const properties = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [
        `f${i}`,
        { anyOf: [{ type: 'number' }, { type: 'null' }] },
      ]),
    );
    const schema = {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
    await transport().send({ ...REQUEST, toolSchema: schema });

    const [tool] = bodies[0]?.tools as Array<Record<string, unknown>>;
    expect(tool).not.toHaveProperty('strict');
    expect(tool?.input_schema).toEqual(schema);
  });

  it('reads no tool input from a refusal, even when a tool block came back with it', async () => {
    respond = json({
      ...ANSWER,
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'declined' },
    });
    const reply = await transport().send(REQUEST);

    /* A refused answer may not match the schema and is not the model's
     * reading of the message; nothing in it may become a command. */
    expect(reply.toolInput).toBeNull();
    expect(reply.stopReason).toBe('refusal');
    // The category is a fixed vocabulary; the free-text explanation is never kept.
    expect(reply.refusalCategory).toBe('general_harms');
    expect(JSON.stringify(reply)).not.toContain('declined');
  });

  it('keeps a refusal category only from the API vocabulary, never text a gateway put there', async () => {
    respond = json({
      ...ANSWER,
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'CUSTOMER_7K2 owes 50k', explanation: null },
    });
    const reply = await transport().send(REQUEST);
    expect(reply.refusalCategory).toBe('unrecognised');
  });

  it('reads no tool input from an answer cut off at max_tokens', async () => {
    respond = json({ ...ANSWER, stop_reason: 'max_tokens' });
    const reply = await transport().send(REQUEST);

    expect(reply.toolInput).toBeNull();
    expect(reply.stopReason).toBe('max_tokens');
  });

  it('reads no tool input when the model called the tool more than once', async () => {
    const block = ANSWER.content[0]!;
    respond = json({ ...ANSWER, content: [block, { ...block, id: 'tu_2' }] });
    const reply = await transport().send(REQUEST);

    // Two answers to one message is not one command; neither is chosen.
    expect(reply.toolInput).toBeNull();
  });

  it('reads no tool input from a block naming a tool that was never offered', async () => {
    respond = json({
      ...ANSWER,
      content: [{ ...ANSWER.content[0]!, name: 'delete_everything' }],
    });
    const reply = await transport().send(REQUEST);

    expect(reply.toolInput).toBeNull();
  });

  /* An Anthropic-compatible gateway behind AI_BASE_URL may report a finished
   * single tool call as end_turn (review of bd9c5b3). A finished answer is
   * still read; only the incomplete and refused stops yield nothing. */
  it.each(['end_turn', 'stop_sequence'])(
    'reads a single tool call that finished as %s',
    async (stop) => {
      respond = json({ ...ANSWER, stop_reason: stop });
      const reply = await transport().send(REQUEST);
      expect(reply.toolInput).toEqual({ intent: 'RecordSale' });
    },
  );

  it.each(['pause_turn', 'model_context_window_exceeded'])(
    'reads no tool input from an answer that stopped as %s',
    async (stop) => {
      respond = json({ ...ANSWER, stop_reason: stop });
      const reply = await transport().send(REQUEST);
      expect(reply.toolInput).toBeNull();
    },
  );

  it('does not repeat an error type it does not recognise, which a gateway could fill with anything', async () => {
    respond = json({ type: 'error', error: { type: 'CUSTOMER_7K2 owes 50k', message: 'x' } }, 400);
    const error = await transport()
      .send(REQUEST)
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('CUSTOMER_7K2');
    expect((error as Error).message).toBe('anthropic 400: BadRequestError');
  });

  /* The SDK's errors all carry name "Error"; a timeout must still be told
   * apart from a dropped connection, because acceptance counts timeouts to
   * decide the latency question in G-134 (third review of G-134). */
  it('names a timeout as a timeout, apart from a dropped connection', async () => {
    respond = () => undefined; // never answers
    const slow = new AnthropicTransport('sk-test', 150, baseUrl);
    const timeout = await slow.send(REQUEST).catch((e: unknown) => e);
    expect((timeout as Error).message).toBe('anthropic timeout: APIConnectionTimeoutError');

    const unreachable = new AnthropicTransport('sk-test', 2_000, 'http://127.0.0.1:1');
    const dropped = await unreachable.send(REQUEST).catch((e: unknown) => e);
    expect((dropped as Error).message).toBe('anthropic error: APIConnectionError');
  });

  it('names the provider error type on a 400, never its message', async () => {
    respond = json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'tool_choice: type "tool" and "any" are not supported for this model.',
        },
      },
      400,
    );
    const error = await transport()
      .send(REQUEST)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderUnreachable);
    /* Staging recorded "anthropic 400: Error", which named nothing. The type
     * is a fixed vocabulary from the API; the message can quote the request. */
    expect((error as Error).message).toBe('anthropic 400: invalid_request_error');
  });
});
