/**
 * The hosted transcriber (ADR 0027), against a real HTTP server — because the
 * claims worth having are about the wire: the model named in the form, the
 * duration taken from the PROVIDER's answer rather than estimated, and every
 * failure collapsing to the one error the voice path already handles as an
 * outage.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiSpeechToText } from './stt.openai.js';
import { TranscriptionUnavailable } from './stt.js';

let server: Server;
let baseUrl: string;
let lastBody: string;
let respond: (res: import('node:http').ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('latin1');
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  lastBody = '';
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'sold 3 wigs to ada', duration: 12.4 }));
  };
});

const stt = () => new OpenAiSpeechToText('sk-test', 'whisper-1', 5_000, baseUrl);
const NOTE = Buffer.from('not-really-ogg-bytes');

describe('transcribing a voice note through the hosted API', () => {
  it('sends the configured model and answers with the provider`s own duration, rounded up', async () => {
    const transcript = await stt().transcribe(NOTE, 'audio/ogg');
    expect(transcript).toEqual({
      text: 'sold 3 wigs to ada',
      seconds: 13,
      confidence: null,
      /* Who charged us and on which rate card, so the caller can price the
       * call — the duration it prices from is `seconds` above. */
      usage: { provider: 'openai', model: 'whisper-1' },
    });
    // The multipart form named the model and carried the file.
    expect(lastBody).toContain('whisper-1');
    expect(lastBody).toContain('note.ogg');
  });

  it('rounds a sub-second answer UP to one billable second', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'yes', duration: 0.4 }));
    };
    expect((await stt().transcribe(NOTE, 'audio/ogg')).seconds).toBe(1);
  });

  it('refuses an answer with no text — silence is an outage, not a message', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '   ', duration: 3 }));
    };
    await expect(stt().transcribe(NOTE, 'audio/ogg')).rejects.toBeInstanceOf(
      TranscriptionUnavailable,
    );
  });

  it('refuses an answer with no duration — the meter never bills an estimate', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'sold 3 wigs' }));
    };
    await expect(stt().transcribe(NOTE, 'audio/ogg')).rejects.toBeInstanceOf(
      TranscriptionUnavailable,
    );
  });

  it('collapses a provider 5xx to the outage the voice path already handles', async () => {
    respond = (res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    };
    await expect(stt().transcribe(NOTE, 'audio/ogg')).rejects.toMatchObject({
      name: 'TranscriptionUnavailable',
      /* An answered error billed nothing — no reconciliation row for it. */
      maybeBilled: false,
    });
  });

  it('flags a timeout as possibly billed, because the work may have finished', async () => {
    respond = (res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'too late', duration: 3 }));
      }, 500);
    };
    const impatient = new OpenAiSpeechToText('sk-test', 'whisper-1', 100, baseUrl);
    await expect(impatient.transcribe(NOTE, 'audio/ogg')).rejects.toMatchObject({
      name: 'TranscriptionUnavailable',
      maybeBilled: true,
    });
  });
});
