/**
 * Resend ingress and suppression (N7 slice 2), over a real app and database: the signature is
 * the admission check, only a permanent bounce or a complaint suppresses, a replayed delivery
 * changes nothing, and once an address is suppressed the sender refuses to mail it.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailSuppressionKey } from '@rekoda/core';
import { createDb, emailSuppressionsRepo, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MockEmailSender } from './email.port.js';
import { EmailSuppressedError, SuppressingEmailSender } from './suppressing.sender.js';

const KEY = 'resend-webhook-signing-key';
const SECRET = `whsec_${Buffer.from(KEY).toString('base64')}`;

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_EMAIL_PROVIDER'] = 'resend';
  process.env['RESEND_API_KEY'] = 're_test_key';
  process.env['REKODA_EMAIL_FROM'] = 'billing@example.com';
  process.env['RESEND_WEBHOOK_SECRET'] = SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(
  payload: unknown,
  opts: { id?: string; key?: string; timestamp?: string; raw?: string } = {},
) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const id = opts.id ?? 'msg_1';
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(opts.key ?? KEY))
    .update(`${id}.${timestamp}.${raw}`, 'utf8')
    .digest('base64');
  return app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  });
}

const bounced = (to: string, type: string) => ({
  type: 'email.bounced',
  data: { to: [to], bounce: { type } },
});

describe('Resend webhook admission', () => {
  it('rejects a forged signature and records nothing', async () => {
    const response = await post(bounced('a@example.com', 'Permanent'), { key: 'wrong' });
    expect(response.statusCode).toBe(401);
    expect(await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey('a@example.com'))).toBe(
      false,
    );
  });

  it('rejects a delivery with no signature headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend',
      payload: JSON.stringify(bounced('a@example.com', 'Permanent')),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a correctly signed delivery that is older than the tolerance', async () => {
    const response = await post(bounced('a@example.com', 'Permanent'), {
      timestamp: String(Math.floor(Date.now() / 1000) - 3600),
    });
    expect(response.statusCode).toBe(401);
    expect(await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey('a@example.com'))).toBe(
      false,
    );
  });
});

describe('what suppresses an address', () => {
  it('a permanent bounce suppresses, case-insensitively', async () => {
    const response = await post(bounced('Owner@Example.COM', 'Permanent'));
    expect(response.statusCode).toBe(200);
    expect(
      await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey('owner@example.com')),
    ).toBe(true);
  });

  it('a spam complaint suppresses', async () => {
    await post({ type: 'email.complained', data: { to: ['c@example.com'] } });
    expect(await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey('c@example.com'))).toBe(
      true,
    );
  });

  it('a transient or undetermined bounce, and other events, do not', async () => {
    await post(bounced('t@example.com', 'Transient'));
    await post(bounced('u@example.com', 'Undetermined'));
    await post({ type: 'email.delivered', data: { to: ['d@example.com'] } });
    for (const a of ['t@example.com', 'u@example.com', 'd@example.com']) {
      expect(await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey(a))).toBe(false);
    }
  });

  it('a replayed delivery is acknowledged and changes nothing', async () => {
    const event = bounced('r@example.com', 'Permanent');
    expect((await post(event, { id: 'msg_9' })).statusCode).toBe(200);
    expect((await post(event, { id: 'msg_9' })).statusCode).toBe(200);
    expect(await emailSuppressionsRepo.isSuppressed(db, emailSuppressionKey('r@example.com'))).toBe(
      true,
    );
  });

  it('a signed body of an unknown shape is acknowledged, not retried forever', async () => {
    expect((await post({ unexpected: true })).statusCode).toBe(200);
  });
});

describe('the sender refuses a suppressed address', () => {
  it('does not hand a suppressed recipient to the provider', async () => {
    await post(bounced('gone@example.com', 'Permanent'));
    const inner = new MockEmailSender();
    const sender = new SuppressingEmailSender(inner, db);
    await expect(
      sender.send({ to: 'GONE@example.com', subject: 's', text: 't' }),
    ).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(inner.outbox).toHaveLength(0);
  });

  it('still sends to an address that was never suppressed', async () => {
    const inner = new MockEmailSender();
    const sender = new SuppressingEmailSender(inner, db);
    await sender.send({ to: 'fine@example.com', subject: 's', text: 't' });
    expect(inner.outbox).toHaveLength(1);
  });
});
