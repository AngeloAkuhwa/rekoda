/**
 * The G-134 request-shape probe: does the provider accept the requests the
 * API actually sends under tool_choice `auto`?
 *
 * Three requests, built by the production `AnthropicTransport` from the real
 * prompt, tool and schema constants, with a synthetic message (no merchant,
 * no customer, no record):
 *
 *   1. interpreter: AI_MODEL_DEFAULT, the business-command tool (non-strict);
 *   2. escalation:  AI_MODEL_ESCALATION, the same request;
 *   3. classifier:  AI_MODEL_CLASSIFIER, the document classifier (strict).
 *
 * The transport talks to a relay on 127.0.0.1 in this process. With `--plan`
 * the relay records each body and answers itself: nothing leaves the machine,
 * no key is needed, nothing is billed. With `--send` it forwards the same bytes
 * to AI_BASE_URL (Anthropic by default) and records the answer, so the verdict
 * is the production transport's own reading of a real response. From apps/api
 * after `pnpm turbo build`, with the deployment's AI configuration:
 *
 *   node dist/ai/eval/probe-tool-choice.js --plan   print the request bodies
 *   node dist/ai/eval/probe-tool-choice.js --send   three billed calls (cents)
 *
 * Prints one JSON line per request: status, stop reason, block types, tool
 * calls, whether the transport accepted tool input, whether the answer
 * passed the schema, token usage and elapsed time against the 20 s timeout.
 * Never prints the key. A provider error message is printed: it can only
 * quote this synthetic request. Never wire this into CI: `--send` spends.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { businessCommandToolSchema, parseBusinessCommand } from '@rekoda/contracts';
import { isEntrypoint } from '@rekoda/db';
import { loadConfig } from '../../config.js';
import { ANTHROPIC_DEFAULT_BASE_URL, AnthropicTransport } from '../anthropic.transport.js';
import {
  CLASSIFIER_SYSTEM,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_SCHEMA,
  parseDocumentClass,
} from '../classifier.js';
import { CLASSIFIER_MAX_TOKENS, COMMAND_MAX_TOKENS } from '../interpreter.service.js';
import { SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from '../prompt.js';
import { ProviderUnreachable, type ModelRequest } from '../transport.js';

/** A synthetic sale: an opaque customer token, as the privacy gateway sends it. */
export const PROBE_MESSAGE = 'sold 3 bags of rice to CUSTOMER_7K2 for 45k, paid 20k by transfer';
const PROBE_PAGE = 'MINI MART\nRice 5kg   12,500\nTOTAL     12,500\nPAID CASH\nThank you';

export interface ProbeCase {
  readonly name: 'interpreter' | 'escalation' | 'classifier';
  readonly request: ModelRequest;
  readonly accepts: (toolInput: unknown) => boolean;
}

export function probeCases(models: {
  interpreter: string;
  escalation: string;
  classifier: string;
}): ProbeCase[] {
  const command = (model: string): ModelRequest => ({
    model,
    system: SYSTEM_PROMPT,
    userText: PROBE_MESSAGE,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    toolSchema: businessCommandToolSchema(),
    maxTokens: COMMAND_MAX_TOKENS,
  });
  const isCommand = (input: unknown) =>
    parseBusinessCommand((input as { command?: unknown } | null)?.command).ok;
  return [
    { name: 'interpreter', request: command(models.interpreter), accepts: isCommand },
    { name: 'escalation', request: command(models.escalation), accepts: isCommand },
    {
      name: 'classifier',
      request: {
        model: models.classifier,
        system: CLASSIFIER_SYSTEM,
        userText: PROBE_PAGE,
        toolName: CLASSIFIER_TOOL_NAME,
        toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
        toolSchema: CLASSIFIER_TOOL_SCHEMA,
        maxTokens: CLASSIFIER_MAX_TOKENS,
      },
      accepts: (input) => parseDocumentClass(input) !== 'unsure',
    },
  ];
}

interface Exchange {
  body: Record<string, unknown>;
  relayFailed?: boolean;
  status?: number;
  response?: Record<string, unknown>;
}

/** What the relay answers in `--plan`: a well-formed tool call, never billed. */
function cannedReply(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body['tools'] as Array<{ name: string }>;
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: body['model'],
    content: [{ type: 'tool_use', id: 'toolu_probe', name: tools[0]?.name, input: {} }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Runs each case through the production transport against the relay and
 * returns what was sent, what came back and what the transport made of it.
 * `upstream` null means plan mode.
 */
export async function runProbe(
  cases: readonly ProbeCase[],
  upstream: { baseUrl: string; apiKey: string } | null,
  /** The transport's timeout; the production default. Tests shorten it. */
  timeoutMs = 20_000,
): Promise<Array<Record<string, unknown>>> {
  /* One secret per case, which the transport presents to the relay as its
   * key. It does two jobs:
   *   - the relay serves only POST /v1/messages carrying a token it issued,
   *     so no other local process can make billed calls through it or have
   *     the real key sent to a host of its choosing;
   *   - each request is recorded under its own case's token, never under a
   *     shared "current" slot, so a case that timed out and answers (or
   *     even arrives) late can only ever land on its own result. */
  const exchanges = new Map<string, Exchange | null>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const token = String(req.headers['x-api-key'] ?? '');
    if (req.method !== 'POST' || req.url !== '/v1/messages' || !exchanges.has(token)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'relay_refused', message: 'relay' } }),
      );
      return;
    }
    let exchange: Exchange | null = null;
    void (async () => {
      const raw = await readBody(req);
      exchange = { body: JSON.parse(raw) as Record<string, unknown> };
      exchanges.set(token, exchange);
      if (!upstream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(cannedReply(exchange.body)));
        return;
      }
      /* The SDK appends the path to the base URL, so a gateway's own path
       * prefix is kept here too. */
      const forwarded = await fetch(`${upstream.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'application/json',
          'x-api-key': upstream.apiKey,
          'anthropic-version': String(req.headers['anthropic-version'] ?? ''),
        },
        body: raw,
      });
      const text = await forwarded.text();
      exchange.status = forwarded.status;
      try {
        exchange.response = JSON.parse(text) as Record<string, unknown>;
      } catch {
        exchange.response = { unparsable: true };
      }
      res.writeHead(forwarded.status, { 'content-type': 'application/json' });
      res.end(text);
    })().catch(() => {
      /* The relay's own failure (upstream unreachable, or no answer in 30 s),
       * marked as such so it is never read as Anthropic's. */
      if (exchange) exchange.relayFailed = true;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'relay_failed', message: 'relay' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const results: Array<Record<string, unknown>> = [];
  try {
    for (const probe of cases) {
      /* The key the transport sends goes only to the relay in this process;
       * the relay checks it and sends the real one upstream. */
      const caseToken = randomBytes(24).toString('hex');
      exchanges.set(caseToken, null);
      const transport = new AnthropicTransport(caseToken, timeoutMs, relay);
      const started = Date.now();
      let verdict: Record<string, unknown>;
      try {
        const reply = await transport.send(probe.request);
        verdict = {
          transportToolInput: reply.toolInput !== null,
          schemaValid: reply.toolInput !== null && probe.accepts(reply.toolInput),
          stopReason: reply.stopReason,
          ...(reply.refusalCategory === undefined
            ? {}
            : { refusalCategory: reply.refusalCategory }),
          usage: reply.usage,
        };
      } catch (error) {
        verdict = {
          transportError: error instanceof ProviderUnreachable ? error.message : String(error),
        };
      }
      const elapsedMs = Date.now() - started;
      const exchange = exchanges.get(caseToken) ?? null;
      const response = exchange?.response;
      const content = (response?.['content'] as Array<{ type: string; name?: string }>) ?? [];
      const error = response?.['error'] as { type?: string; message?: string } | undefined;
      results.push({
        case: probe.name,
        model: probe.request.model,
        ...(upstream
          ? {
              status: exchange?.status ?? null,
              ...(exchange?.relayFailed ? { relayFailed: true } : {}),
              blocks: content.map((block) => block.type),
              toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => b.name),
              ...(error ? { error: { type: error.type, message: error.message } } : {}),
              elapsedMs,
              withinTimeout: elapsedMs < timeoutMs,
            }
          : { requestBody: exchange?.body ?? null }),
        ...verdict,
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return results;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const send = args.has('--send');
  if (!send && !args.has('--plan')) {
    console.error('usage: probe-tool-choice.js --plan | --send');
    return 2;
  }
  const config = loadConfig();
  if (config.aiProvider !== 'anthropic') {
    console.error(`AI_PROVIDER is ${config.aiProvider}; this probe covers the Anthropic transport`);
    return 2;
  }
  if (send && !config.anthropicApiKey) {
    console.error('ANTHROPIC_API_KEY is not set; --send needs the deployment key');
    return 2;
  }
  const cases = probeCases({
    interpreter: config.aiModelDefault,
    escalation: config.aiModelEscalation,
    classifier: config.aiModelClassifier,
  });
  const results = await runProbe(
    cases,
    send
      ? {
          baseUrl: config.aiBaseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
          apiKey: config.anthropicApiKey,
        }
      : null,
  );
  for (const result of results) console.log(JSON.stringify(result));
  if (!send) return 0;
  const accepted = results.every((r) => r['status'] === 200 && r['schemaValid'] === true);
  return accepted ? 0 : 1;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'probe failed');
      process.exitCode = 1;
    },
  );
}
