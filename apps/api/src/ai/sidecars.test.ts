/**
 * The two self-hosted sidecars, against a real HTTP server.
 *
 * Their contracts have existed only as a sentence in a comment and a line in
 * `.env.example`, which is a poor thing to hand somebody who is about to
 * build the service on the other end. These tests ARE the contract: the path,
 * the multipart field name, the shape of the answer, and what happens to a
 * merchant when the answer is wrong.
 *
 * The behaviour that matters most is shared by both and is a privacy rule
 * rather than a transport one: when a sidecar cannot answer, the failure is
 * the answer. There is no second route for the audio and no second route for
 * the image, and `NoSpeechToTextConfigured` / `NoTextExtractionConfigured`
 * are what keep it that way when the URL is unset.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpSpeechToText, NoSpeechToTextConfigured } from './stt.http.js';
import { TranscriptionUnavailable } from './stt.js';
import { HttpTextExtraction, NoTextExtractionConfigured } from './ocr.http.js';
import { TextExtractionUnavailable } from './ocr.js';

interface Recorded {
  method: string;
  url: string;
  contentType: string | undefined;
  raw: string;
}

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'],
        raw: Buffer.concat(chunks).toString('binary'),
      });
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
  requests = [];
});

const json = (payload: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

describe('the transcription sidecar', () => {
  const stt = () => new HttpSpeechToText(baseUrl, 2_000);

  it('posts the audio to /transcribe as a `file` field', async () => {
    respond = json({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.94 });
    const result = await stt().transcribe(Buffer.from('OggS-voice'), 'audio/ogg');

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/transcribe');
    expect(requests[0]?.contentType).toMatch(/multipart\/form-data/);
    expect(requests[0]?.raw).toContain('name="file"');
    expect(requests[0]?.raw).toContain('OggS-voice');
    expect(result).toEqual({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.94 });
  });

  it('tolerates a trailing slash on the configured url', async () => {
    respond = json({ text: 'hello', seconds: 1 });
    await new HttpSpeechToText(`${baseUrl}/`, 2_000).transcribe(Buffer.from('x'), 'audio/ogg');
    expect(requests[0]?.url).toBe('/transcribe');
  });

  it('rounds seconds UP, so a short note is not billed as nothing', async () => {
    respond = json({ text: 'yes', seconds: 0.4 });
    // A meter that rounds these to zero sells an unlimited allowance to
    // anybody who speaks quickly.
    expect((await stt().transcribe(Buffer.from('x'), 'audio/ogg')).seconds).toBe(1);
  });

  it('reports "we do not know" as null rather than as certainty', async () => {
    respond = json({ text: 'hello', seconds: 2 });
    expect((await stt().transcribe(Buffer.from('x'), 'audio/ogg')).confidence).toBeNull();
  });

  it('treats an empty transcript as a failure, not as an empty message', async () => {
    respond = json({ text: '   ', seconds: 3 });
    /* A blank string handed onward would be interpreted as a message the
     * merchant never sent. */
    await expect(stt().transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toBeInstanceOf(
      TranscriptionUnavailable,
    );
  });

  it('fails as an outage when the sidecar errors', async () => {
    respond = (_req, res) => {
      res.writeHead(503);
      res.end('down');
    };
    await expect(stt().transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toThrow(/503/);
  });

  it('refuses honestly when STT_URL is unset, and names the variable', async () => {
    await expect(new NoSpeechToTextConfigured().transcribe()).rejects.toThrow(/STT_URL/);
  });
});

describe('the OCR sidecar', () => {
  const ocr = () => new HttpTextExtraction(baseUrl, 2_000);

  it('posts the image to /extract as a `file` field', async () => {
    respond = json({ text: 'TOTAL 12,000 diesel', confidence: 0.88 });
    const result = await ocr().extract(Buffer.from('JFIF-photo'), 'image/jpeg');

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/extract');
    expect(requests[0]?.contentType).toMatch(/multipart\/form-data/);
    expect(requests[0]?.raw).toContain('name="file"');
    expect(requests[0]?.raw).toContain('JFIF-photo');
    expect(result).toEqual({ text: 'TOTAL 12,000 diesel', confidence: 0.88 });
  });

  it('tolerates a trailing slash on the configured url', async () => {
    respond = json({ text: 'x' });
    await new HttpTextExtraction(`${baseUrl}/`, 2_000).extract(Buffer.from('x'), 'image/jpeg');
    expect(requests[0]?.url).toBe('/extract');
  });

  it('treats an empty page as a failure, not as an empty receipt', async () => {
    respond = json({ text: '' });
    await expect(ocr().extract(Buffer.from('x'), 'image/jpeg')).rejects.toBeInstanceOf(
      TextExtractionUnavailable,
    );
  });

  it('reports an absent confidence as null', async () => {
    respond = json({ text: 'TOTAL 500' });
    expect((await ocr().extract(Buffer.from('x'), 'image/jpeg')).confidence).toBeNull();
  });

  it('fails as an outage when the sidecar errors', async () => {
    respond = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };
    await expect(ocr().extract(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/500/);
  });

  it('refuses honestly when OCR_URL is unset, and names the variable', async () => {
    /* This class is what makes ADR 0024's no-fallback clause real. The
     * tempting shape here is one that posts the image to a vision model
     * instead; there is no such class and there must not be one. */
    await expect(new NoTextExtractionConfigured().extract()).rejects.toThrow(/OCR_URL/);
  });
});
