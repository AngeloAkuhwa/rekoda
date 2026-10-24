/**
 * The Resend adapter, against a real HTTP server: what it puts on the wire,
 * and that a failure never carries the recipient or the body.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailSendError } from './email.port.js';
import { ResendEmailSender } from './resend.sender.js';

interface Recorded {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
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
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
  respond = (_req, res) => res.writeHead(200).end('{"id":"em_1"}');
});

const config = (replyTo: string | null = null) => ({
  apiKey: 'test-key-not-a-secret',
  from: 'Rekoda <billing@example.test>',
  replyTo,
  baseUrl,
});
const mail = { to: 'owner@example.test', subject: 'Confirm', text: 'link-body-text' };

describe('ResendEmailSender', () => {
  it('posts the configured sender, the recipient and the idempotency key, authenticated', async () => {
    await new ResendEmailSender(config('help@example.test')).send({
      ...mail,
      idempotencyKey: 'billing-email/abc',
    });
    expect(requests).toHaveLength(1);
    const [r] = requests;
    expect(r?.url).toBe('/emails');
    expect(r?.headers.authorization).toBe('Bearer test-key-not-a-secret');
    expect(r?.headers['idempotency-key']).toBe('billing-email/abc');
    expect(r?.body).toEqual({
      from: 'Rekoda <billing@example.test>',
      to: ['owner@example.test'],
      subject: 'Confirm',
      text: 'link-body-text',
      reply_to: 'help@example.test',
    });
  });

  it('omits reply_to and the idempotency header when none is configured', async () => {
    await new ResendEmailSender(config()).send(mail);
    expect(requests[0]?.body).not.toHaveProperty('reply_to');
    expect(requests[0]?.headers).not.toHaveProperty('idempotency-key');
  });

  it.each([
    [401, 'unauthorised'],
    [403, 'unauthorised'],
    [422, 'rejected'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s, with no recipient or body in the error', async (status, failure) => {
    respond = (_req, res) => res.writeHead(status).end(`{"echo":"owner@example.test"}`);
    const error = await new ResendEmailSender(config()).send(mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).failure).toBe(failure);
    expect((error as Error).message).not.toContain('owner@example.test');
    expect((error as Error).message).not.toContain('link-body-text');
  });

  it('treats an unreachable provider as unavailable', async () => {
    const dead = new ResendEmailSender({ ...config(), baseUrl: 'http://127.0.0.1:9' });
    await expect(dead.send(mail)).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('times out a provider that never answers', async () => {
    respond = () => undefined;
    const slow = new ResendEmailSender(config(), 50);
    await expect(slow.send(mail)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
