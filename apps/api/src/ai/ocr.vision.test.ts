/**
 * The vision text reader (ADR 0027), against a real HTTP server — pinning
 * that the image travels as base64 under a transcribe-only instruction, that
 * an unreadable page or an outage collapses to the one refusal the receipt
 * path already handles, and that a type the vision API cannot take is
 * refused HERE, before any bytes leave.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VisionTextExtraction } from './ocr.vision.js';
import { TextExtractionUnavailable } from './ocr.js';

let server: Server;
let baseUrl: string;
let lastBody: string;
let lastHeaders: import('node:http').IncomingHttpHeaders;
let requests: number;
let respond: (res: import('node:http').ServerResponse) => void;

function message(text: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests += 1;
      lastHeaders = req.headers;
      lastBody = Buffer.concat(chunks).toString('utf8');
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  lastBody = '';
  requests = 0;
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message('MAMA NKECHI STORES\nANKARA x2 4,500\nTOTAL 4,500')));
  };
});

const reader = () => new VisionTextExtraction('sk-ant-test', 'claude-sonnet-5', 5_000, baseUrl);
const PHOTO = Buffer.from('not-really-jpeg-bytes');

describe('reading a photographed receipt through the vision model', () => {
  it('carries the image as base64 under a transcribe-only instruction', async () => {
    const extracted = await reader().extract(PHOTO, 'image/jpeg');
    expect(extracted.text).toContain('MAMA NKECHI STORES');
    expect(extracted.confidence).toBeNull();
    /* The bill for the read travels WITH the text, so the caller can write
     * the cost row that puts hosted OCR inside the margin view. */
    expect(extracted.usage).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      tokens: { inputTokens: 100, outputTokens: 20 },
    });

    const sent = JSON.parse(lastBody) as {
      model: string;
      system: string;
      messages: Array<{ content: Array<{ type: string; source?: { data?: string } }> }>;
    };
    expect(sent.model).toBe('claude-sonnet-5');
    expect(sent.system).toContain('verbatim');
    const image = sent.messages[0]?.content.find((b) => b.type === 'image');
    expect(image?.source?.data).toBe(PHOTO.toString('base64'));
  });

  it('authenticates with X-Api-Key, as the transport does, for a gateway that checks only that header', async () => {
    await reader().extract(PHOTO, 'image/jpeg');
    expect(lastHeaders['x-api-key']).toBe('sk-ant-test');
    expect(lastHeaders.authorization).toBeUndefined();
    // API version 2026-10-21 answers 400 to any sampling parameter.
    const sent = JSON.parse(lastBody) as Record<string, unknown>;
    for (const key of ['temperature', 'top_p', 'top_k']) expect(sent, key).not.toHaveProperty(key);
    expect(lastHeaders['anthropic-version']).toBe('2026-10-21');
  });

  it('collapses an authentication failure to the refusal, without the key, and does not retry', async () => {
    respond = (res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid key sk-ant-test' },
        }),
      );
    };
    const failure = await reader()
      .extract(PHOTO, 'image/jpeg')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(TextExtractionUnavailable);
    expect((failure as Error).message).not.toContain('sk-ant-test');
    expect(requests).toBe(1);
  });

  it('refuses a type the vision API cannot take, before any bytes leave', async () => {
    await expect(reader().extract(PHOTO, 'application/pdf')).rejects.toBeInstanceOf(
      TextExtractionUnavailable,
    );
    expect(requests).toBe(0);
  });

  it('treats a page with no legible text as unreadable, not as an empty success', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(message('   ')));
    };
    await expect(reader().extract(PHOTO, 'image/png')).rejects.toBeInstanceOf(
      TextExtractionUnavailable,
    );
  });

  /* OWN-98 (G-134 review): a provider refusal is terminal. Whatever text
   * came back with it is never handed on as the page, so it can never reach
   * the classifier or the interpreter; the bill still travels with the
   * failure, as an unreadable page's does. */
  it('treats a refused image as unreadable, never passing on what came back with it', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...message('TOTAL 4,500 transcribed before the refusal'),
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'general_harms',
            explanation: 'EXPLAINED_WHY',
          },
        }),
      );
    };
    const failure = await reader()
      .extract(PHOTO, 'image/jpeg')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(TextExtractionUnavailable);
    const unavailable = failure as TextExtractionUnavailable;
    expect(unavailable.message).not.toContain('TOTAL');
    expect(unavailable.message).not.toContain('EXPLAINED_WHY');
    expect(unavailable.usage?.tokens).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(requests).toBe(1);
  });

  it('collapses a provider 5xx to the refusal the receipt path already handles', async () => {
    respond = (res) => {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
    };
    await expect(reader().extract(PHOTO, 'image/jpeg')).rejects.toMatchObject({
      name: 'TextExtractionUnavailable',
      /* An answered error billed nothing — no reconciliation row for it. */
      maybeBilled: false,
    });
  });

  it('flags a timeout as possibly billed, because the page may have been read', async () => {
    respond = (res) => {
      // Answer well after the client has given up waiting.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message('TOO LATE')));
      }, 500);
    };
    const impatient = new VisionTextExtraction('sk-ant-test', 'claude-sonnet-5', 100, baseUrl);
    await expect(impatient.extract(PHOTO, 'image/jpeg')).rejects.toMatchObject({
      name: 'TextExtractionUnavailable',
      maybeBilled: true,
    });
  });
});
