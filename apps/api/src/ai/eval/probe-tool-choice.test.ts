/**
 * The G-134 probe in plan mode: the bodies it would send are the production
 * transport's own, for the real prompt, tools and ceilings, and nothing
 * leaves the process.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PROBE_MESSAGE, probeCases, runProbe } from './probe-tool-choice.js';
import { SYSTEM_PROMPT, TOOL_NAME } from '../prompt.js';
import { CLASSIFIER_TOOL_NAME, DOCUMENT_CLASSES, parseDocumentClass } from '../classifier.js';
import { CLASSIFIER_MAX_TOKENS, COMMAND_MAX_TOKENS } from '../interpreter.service.js';

const MODELS = {
  interpreter: 'claude-sonnet-5-5',
  escalation: 'claude-opus-5-5',
  classifier: 'claude-haiku-4-5',
};

type Body = {
  model: string;
  max_tokens: number;
  system: Array<{ text: string }>;
  tools: Array<{ name: string; strict?: boolean; input_schema: Record<string, unknown> }>;
  tool_choice: unknown;
  messages: unknown;
};

async function bodies(): Promise<Map<string, Body>> {
  const results = await runProbe(probeCases(MODELS), null);
  return new Map(results.map((r) => [r['case'] as string, r['requestBody'] as Body]));
}

describe('the G-134 probe, in plan mode', () => {
  it('builds the interpreter and escalation requests the API sends, on their models', async () => {
    const sent = await bodies();
    for (const [name, model] of [
      ['interpreter', MODELS.interpreter],
      ['escalation', MODELS.escalation],
    ] as const) {
      const body = sent.get(name)!;
      expect(body.model).toBe(model);
      expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      expect(body.max_tokens).toBe(COMMAND_MAX_TOKENS);
      expect(body.system[0]?.text).toBe(SYSTEM_PROMPT);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]?.name).toBe(TOOL_NAME);
      // The full business-command schema goes non-strict: it is over the strict limits.
      expect(body.tools[0]).not.toHaveProperty('strict');
      expect(JSON.stringify(body.tools[0]?.input_schema)).toContain('"maximum"');
      expect(body.messages).toEqual([{ role: 'user', content: PROBE_MESSAGE }]);
    }
  });

  it('builds the classifier request strict, with its own ceiling', async () => {
    const body = (await bodies()).get('classifier')!;
    expect(body.model).toBe(MODELS.classifier);
    expect(body.tools[0]).toMatchObject({ name: CLASSIFIER_TOOL_NAME, strict: true });
    expect(body.max_tokens).toBe(CLASSIFIER_MAX_TOKENS);
  });

  it("claims no outcome in plan mode, where the answer is the relay's own stand-in", async () => {
    for (const result of await runProbe(probeCases(MODELS), null)) {
      expect(result).not.toHaveProperty('outcome');
    }
  });

  it('a synthetic message only: no phone number, no name, no amount beyond the sentence', () => {
    expect(PROBE_MESSAGE).not.toMatch(/\+?\d{10,}/);
    expect(PROBE_MESSAGE).toContain('CUSTOMER_7K2');
  });
});

describe('the G-134 probe, sending through the relay', () => {
  /** A stand-in provider that holds its answer to the models named in `hold`. */
  async function fakeUpstream(
    hold: Record<string, number>,
    /** Replaces the default answer (one call of the offered tool, input `{}`) for a model. */
    answer: Record<string, (tool: string) => { status: number; body: unknown }> = {},
  ) {
    const seen: Array<{ url: string; key: string; model: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          model: string;
          tools: Array<{ name: string }>;
        };
        seen.push({ url: req.url ?? '', key: String(req.headers['x-api-key']), model: body.model });
        setTimeout(() => {
          const custom = answer[body.model]?.(body.tools[0]?.name ?? '');
          if (custom) {
            res.writeHead(custom.status, {
              'content-type': 'application/json',
              connection: 'close',
            });
            res.end(JSON.stringify(custom.body));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
          res.end(
            JSON.stringify({
              id: 'msg_x',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'tool_use', id: 't', name: body.tools[0]?.name, input: {} }],
              stop_reason: 'tool_use',
              stop_sequence: null,
              stop_details: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        }, hold[body.model] ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}/gateway`,
      seen,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  /* The hazard: case 1's request reaches the relay's record AFTER case 1
   * has timed out, while case 2 is still waiting for its answer. With one
   * shared "current" slot that late record overwrote case 2's, and case 2
   * was reported with case 1's request. Timeline (ms): case 1 starts at 0
   * and times out at 1,200; its record is released at 1,700; case 2 starts
   * at about 1,200, its answer is held until about 2,100 and its own
   * timeout is at about 2,400. Every margin is at least 300 ms. */
  it(
    'attributes every result to its own case when a timed-out request lands during the next case',
    { timeout: 15_000 },
    async () => {
      const upstream = await fakeUpstream({ [MODELS.escalation]: 900 });
      try {
        const results = await runProbe(
          probeCases(MODELS),
          { baseUrl: upstream.baseUrl, apiKey: 'upstream-key' },
          {
            timeoutMs: 1_200,
            beforeRecord: (model) =>
              model === MODELS.interpreter
                ? new Promise((resolve) => setTimeout(resolve, 1_700))
                : Promise.resolve(),
          },
        );

        expect(results.map((r) => r['case'])).toEqual(['interpreter', 'escalation', 'classifier']);
        // Case 1 timed out before its request was recorded: nothing of its own, nobody else's.
        expect(results[0]).toMatchObject({
          model: MODELS.interpreter,
          status: null,
          servedModel: null,
        });
        expect(String(results[0]!['transportError'])).toMatch(/timeout/);
        // Case 2 carries its own answer, though case 1's record landed while it ran.
        expect(results[1]).toMatchObject({
          model: MODELS.escalation,
          servedModel: MODELS.escalation,
          status: 200,
          toolCalls: [TOOL_NAME],
        });
        expect(results[2]).toMatchObject({
          model: MODELS.classifier,
          servedModel: MODELS.classifier,
          status: 200,
          toolCalls: [CLASSIFIER_TOOL_NAME],
        });
        // The real key goes upstream, under the gateway's own path prefix, and is never printed.
        expect(new Set(upstream.seen.map((s) => `${s.url} ${s.key}`))).toEqual(
          new Set(['/gateway/v1/messages upstream-key']),
        );
        expect(JSON.stringify(results)).not.toContain('upstream-key');
      } finally {
        await upstream.close();
      }
    },
  );

  /** A finished answer holding one call of `tool` with `input`. */
  const toolAnswer = (model: string, input: unknown) => (tool: string) => ({
    status: 200,
    body: {
      id: 'msg_y',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: 't', name: tool, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  /* Finding N1 (owner review of 7602bb2): `unsure` is one of the classifier's
   * six classes, so a strict answer of { type: 'unsure' } is a valid tool
   * call. The probe judged it with parseDocumentClass(input) !== 'unsure',
   * which reported it as schemaValid false, the same as malformed input. */
  it('reports a valid "unsure" classification as valid, apart from malformed input, no tool call and a provider error', async () => {
    const run = async (classifier: (tool: string) => { status: number; body: unknown }) => {
      const upstream = await fakeUpstream({}, { [MODELS.classifier]: classifier });
      try {
        const results = await runProbe(probeCases(MODELS), {
          baseUrl: upstream.baseUrl,
          apiKey: 'upstream-key',
        });
        return results.find((r) => r['case'] === 'classifier')!;
      } finally {
        await upstream.close();
      }
    };

    expect(await run(toolAnswer(MODELS.classifier, { type: 'unsure' }))).toMatchObject({
      status: 200,
      transportToolInput: true,
      schemaValid: true,
      outcome: 'valid',
      documentClass: 'unsure',
    });
    expect(await run(toolAnswer(MODELS.classifier, { type: 'banana' }))).toMatchObject({
      transportToolInput: true,
      schemaValid: false,
      outcome: 'malformed_tool_input',
    });
    const prose = await run(() => ({
      status: 200,
      body: {
        id: 'msg_z',
        type: 'message',
        role: 'assistant',
        model: MODELS.classifier,
        content: [{ type: 'text', text: 'This looks like a receipt.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));
    expect(prose).toMatchObject({
      transportToolInput: false,
      schemaValid: false,
      outcome: 'no_tool_input',
      toolCalls: [],
    });
    expect(prose).not.toHaveProperty('documentClass');
    const refused = await run(() => ({
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
    }));
    expect(refused).toMatchObject({ status: 400, outcome: 'provider_error' });
    expect(String(refused['transportError'])).toBe('anthropic 400: invalid_request_error');
  });
});

describe("the G-134 probe's own reading of a classifier answer", () => {
  const accepts = probeCases(MODELS).find((c) => c.name === 'classifier')!.accepts;

  it('accepts every one of the six classes, "unsure" included (finding N1)', () => {
    for (const type of DOCUMENT_CLASSES) expect(accepts({ type })).toBe(true);
  });

  it('refuses what the strict schema refuses: an unknown class, a missing or extra key, a non-object', () => {
    for (const input of [
      { type: 'banana' },
      { type: 'UNSURE' },
      {},
      { type: 'receipt', confidence: 1 },
      { type: ['unsure'] },
      null,
      'unsure',
      ['unsure'],
    ]) {
      expect(accepts(input)).toBe(false);
    }
  });

  it('leaves production fail-open as it was: malformed input still reads as "unsure"', () => {
    expect(parseDocumentClass({ type: 'banana' })).toBe('unsure');
    expect(parseDocumentClass(null)).toBe('unsure');
  });
});
