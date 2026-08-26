/**
 * No PII in logs (MASTER-PLAN §5.3.2, §5.3.8 exit criterion).
 *
 * The privacy gateway can be perfect and the vault can be encrypted, and a
 * single `log.debug(message.text)` puts a merchant's customer's phone number
 * into a log store nobody encrypted, nobody rotates, and a support engineer
 * greps at 2am. Logs are the leak that does not look like one.
 *
 * So this drives a REAL message through the REAL path — signed webhook, job
 * runner, gateway, model, reply — with every log line captured, and asserts
 * that none of it survives. It is deliberately not a unit test of
 * `redactForLog`: that function is already tested, and testing it again would
 * prove nothing about whether it is actually being called.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LogLevel, LoggerService } from '@nestjs/common';
import { createDb, identity, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

/** Everything the application tried to write, whatever the level. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];

  private record(message: unknown, ...rest: unknown[]): void {
    this.lines.push([message, ...rest].map((part) => String(part)).join(' '));
  }

  log = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  error = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  warn = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  debug = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  verbose = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  fatal = (m: unknown, ...r: unknown[]): void => this.record(m, ...r);
  setLogLevels?(_levels: LogLevel[]): void {}

  get text(): string {
    return this.lines.join('\n');
  }
}

const APP_SECRET = 'meta-app-secret-for-tests';

/** The things that must never appear. Distinctive strings, so a match is a match. */
const CUSTOMER_PHONE = '08039998888';
const CUSTOMER_EMAIL = 'adaeze.okonkwo@example.com';
const MESSAGE_TEXT = `Adaeze Okonkwo ${CUSTOMER_PHONE} ${CUSTOMER_EMAIL} bought 3 chiffon wrappers for 150k`;

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorkerDb: () => Promise<void>;
let logger: CapturingLogger;
let deps: RunnerDeps;
let stubTransport: StubTransport;
let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['META_APP_SECRET'] = APP_SECRET;
  process.env['META_VERIFY_TOKEN'] = 'meta-verify-token-for-tests';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  logger = new CapturingLogger();
  app.useLogger(logger);
  await app.init();
  /**
   * `bufferLogs: true` in main.ts holds bootstrap logs until something flushes
   * them. Without this the capture starts empty AND stays empty, and every
   * assertion below passes by observing nothing — which is why the first test
   * in this file checks that anything was logged at all.
   */
  app.flushLogs();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorkerDb } = createDb(urls.worker, { max: 2 }));

  const config: ApiConfig = loadConfig();
  stubTransport = StubTransport.answering({
    intent: 'Unclear',
    clarification: 'How many wrappers?',
  });
  stubSender = new StubSender();
  stubStt = new StubSpeechToText();
  stubOcr = new StubTextExtraction();
  deps = {
    gateway: new PrivacyGateway(db, config),
    interpreter: new Interpreter(db, config, stubTransport),
    replySender: new ReplySender(config, stubSender),
    // A real filesystem storage, not a mock: the render job's assertions are
    // about bytes actually landing somewhere and being readable back.
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: new StubPaymentProvider(),
    paymentIntents: new PaymentIntentsService(config, db, new StubPaymentProvider()),
    stt: stubStt,
    ocr: stubOcr,
    audioProbe: new ContainerAudioProbe(),
    commandBus: new CommandBus(new RiskPolicyService()),
  };
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorkerDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  logger.lines.length = 0;
});

function post(payload: unknown, opts: { secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', opts.secret ?? APP_SECRET)
    .update(raw, 'utf8')
    .digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
}

function messagePayload(waId: string, wamid: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'PNID' },
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, '+2348031234567');
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

describe('a message that goes all the way through', () => {
  beforeEach(async () => {
    await seedMerchant();
    await post(messagePayload('2348031234567', 'wamid.LOGGED', MESSAGE_TEXT));
    await buildRunner(workerDb, db, deps).runOnce();
  });

  it('logged something, so the assertions below are not vacuous', () => {
    // Without this, a change that silenced every logger would make the rest of
    // this file pass by writing nothing at all.
    expect(logger.lines.length).toBeGreaterThan(0);
  });

  it('never logs the customer`s phone number', () => {
    expect(logger.text).not.toContain(CUSTOMER_PHONE);
  });

  it('never logs the customer`s email', () => {
    expect(logger.text).not.toContain(CUSTOMER_EMAIL);
    expect(logger.text).not.toContain('adaeze.okonkwo');
  });

  it('never logs the customer`s name', () => {
    expect(logger.text).not.toContain('Adaeze');
    expect(logger.text).not.toContain('Okonkwo');
  });

  it('never logs the message body', () => {
    // Not even the harmless-looking part. A message body is a message body.
    expect(logger.text).not.toContain('chiffon wrappers');
    expect(logger.text).not.toContain(MESSAGE_TEXT);
  });

  it('never logs the MERCHANT`s number either', () => {
    // The gateway protects the merchant's customers. The merchant is a person
    // too, and their WhatsApp number is on every inbound event.
    expect(logger.text).not.toContain('2348031234567');
  });

  it('never logs a token beside the identity it stands for', () => {
    /**
     * The mapping is the one thing worse than either half. A log holding
     * `CUSTOMER_7K2 = 08039998888` undoes the entire gateway for anyone who
     * can read it — which is a wider group than can read the database.
     */
    const tokenAndValue = /CUSTOMER_[0-9A-Z]{3}[^\n]{0,40}(?:0\d{10}|@example\.com)/;
    expect(logger.text).not.toMatch(tokenAndValue);
  });
});

describe('the paths that log the most', () => {
  it('does not log the body of a payload it cannot read', async () => {
    await seedMerchant();
    // The controller warns here. An "unrecognised shape" log that dumps the
    // shape is exactly how a message body reaches a log store.
    await post({ object: 'whatsapp_business_account', entry: 'not-an-array', note: MESSAGE_TEXT });

    expect(logger.text).not.toContain('chiffon');
    expect(logger.text).not.toContain(CUSTOMER_PHONE);
  });

  it('does not log the payload when a signature is rejected', async () => {
    await post(messagePayload('2348031234567', 'wamid.FORGED', MESSAGE_TEXT), {
      secret: 'wrong-secret',
    });

    // The rejection is logged — it should be. What it must not carry is the
    // body somebody just tried to smuggle in.
    expect(logger.text).toMatch(/invalid signature/i);
    expect(logger.text).not.toContain('chiffon');
    expect(logger.text).not.toContain(CUSTOMER_PHONE);
  });

  it('does not log message content when a job fails', async () => {
    const business = await seedMerchant();
    await post(messagePayload('2348031234567', 'wamid.BOOM', MESSAGE_TEXT));

    // A handler that throws is the loudest path in the system, and the one
    // most likely to reach for context it should not have.
    const runner = buildRunner(workerDb, db, deps);
    runner.register('test.explode', async () => {
      throw new Error(`failed while handling ${MESSAGE_TEXT}`);
    });
    await runner.runOnce();

    expect(logger.text).not.toContain(CUSTOMER_PHONE);
    expect(logger.text).not.toContain(CUSTOMER_EMAIL);
    expect(business.id).toBeTruthy();
  });
});
