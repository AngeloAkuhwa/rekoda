/**
 * Shared setup for the Meta webhook suites, split from meta.integration.test.ts: one
 * running app over a real PostgreSQL, the stubs the jobs use, and the payload helpers.
 *
 * Each suite calls `useMetaWebhookHarness()` once at its top level. Vitest gives every test
 * file its own copy of this module, so each suite boots its own app and pools, and the stubs
 * are reset before every test here, in one place.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createDb, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls, settlementDb } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunnerDeps } from '../jobs/jobs.module.js';
import { issueRepo } from '@rekoda/db';
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
import { loadConfig, type ApiConfig } from '../config.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

export const APP_SECRET = 'meta-app-secret-for-tests';
export const VERIFY_TOKEN = 'meta-verify-token-for-tests';

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

export let urls: Urls;
export let app: NestFastifyApplication;
export let db: Db;
export let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorkerDb: () => Promise<void>;
export let deps: RunnerDeps;
export let stubTransport: StubTransport;
export let stubSender: StubSender;
export let stubStt: StubSpeechToText;
export let stubOcr: StubTextExtraction;
export const intentsProvider = new StubPaymentProvider();

/** Registers the suite hooks: the app and pools before all, a clean database and stubs before each. */
export function useMetaWebhookHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);

    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
    process.env['REKODA_API_SECRET'] = 'test-secret-at-least-32-characters-long';
    process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
    process.env['REKODA_WEB_URL'] = 'https://books.example.test';
    process.env['META_APP_SECRET'] = APP_SECRET;
    process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
    /* Rekoda's own Chat number (PR-059): the fixtures below arrive on PNID,
     * so pinning it makes the routing decision explicit — anything else is a
     * merchant's WABA or a refusal, never a guess. */
    process.env['META_PHONE_NUMBER_ID'] = 'PNID';
    // 64 hex characters each, derived per run rather than written down.
    process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
    process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
    /* The merchant-WABA credential key (PR-058): the W3 gate sends into a
     * customer's thread on the merchant's own number, which needs the stored
     * token to decrypt. */
    process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
    delete process.env['NODE_ENV'];

    const { createApp } = await import('../main.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
    ({ db: workerDb, close: closeWorkerDb } = createDb(urls.worker, { max: 2 }));
    const config: ApiConfig = loadConfig();
    stubTransport = StubTransport.answering({
      intent: 'Unclear',
      clarification: 'How many wigs?',
    });
    stubSender = new StubSender();
    stubStt = new StubSpeechToText();
    stubOcr = new StubTextExtraction();
    deps = {
      settlementDb: settlementDb(),
      gateway: new PrivacyGateway(db, config),
      interpreter: new Interpreter(db, config, stubTransport),
      replySender: new ReplySender(config, stubSender),
      // A real filesystem storage, not a mock: the render job's assertions are
      // about bytes actually landing somewhere and being readable back.
      storage: new LocalStorage(storageRoot),
      sender: stubSender,
      config,
      /* ONE stub for both the mint and the verify: the W3 gate scripts a
       * verification against the same provider the checkout was raised on,
       * which is exactly how production holds them together. */
      paymentProvider: intentsProvider,
      paymentIntents: new PaymentIntentsService(config, db, intentsProvider),
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
    // `truncateAll` covers external_events — apps/api deliberately has no
    // `postgres` dependency, so the fixture reset is offered by @rekoda/db.
    await truncateAll(urls);
    // One stub is shared across this file, so its record of what was asked has
    // to be cleared too — otherwise "the model was never called" quietly means
    // "not called since the file started".
    stubTransport.reset();
    stubSender.reset();
    stubStt.reset();
    stubOcr.reset();
    intentsProvider.reset();
  });
}

/** A receipt photograph from `waId`, as Meta delivers it. */
export function photoPayload(
  waId: string,
  wamid: string,
  opts: { mediaId?: string | null; caption?: string } = {},
) {
  const mediaId = opts.mediaId === undefined ? 'photo-1' : opts.mediaId;
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
                  type: 'image',
                  ...(mediaId
                    ? {
                        image: {
                          id: mediaId,
                          mime_type: 'image/jpeg',
                          ...(opts.caption ? { caption: opts.caption } : {}),
                        },
                      }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function messagePayload(
  waId: string,
  wamid: string,
  text = 'Ada bought 3 wigs for 150k',
  phoneNumberId = 'PNID',
) {
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
              metadata: { phone_number_id: phoneNumberId },
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

export function invoiceCount(businessId: string): Promise<number> {
  return withBusiness(db, businessId, (tx) => issueRepo.invoiceCount(tx));
}

/** A delivery receipt: same envelope, `statuses` instead of `messages`. */
export function statusPayload(recipientId: string, wamid: string, status: string) {
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
              statuses: [{ id: wamid, status, recipient_id: recipientId }],
            },
          },
        ],
      },
    ],
  };
}

/**
 * The fields the suites read from an injected response. Named here because the
 * underlying type (light-my-request's Response) is not a direct dependency of
 * apps/api, so an exported helper cannot name it.
 */
export interface InjectedResponse {
  statusCode: number;
  body: string;
  payload: string;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = any>(): T;
}

/** Sends exactly the bytes it signs — as Meta does. */
export function post(
  payload: unknown,
  opts: { secret?: string; corrupt?: boolean } = {},
): Promise<InjectedResponse> {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', opts.secret ?? APP_SECRET)
    .update(raw, 'utf8')
    .digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: opts.corrupt ? `${raw} ` : raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
}

/* Shared by the cart describe (PR-087/088) and the W3 gate (PR-089). */
export function orderPayload(
  waId: string,
  wamid: string,
  phoneNumberId: string,
  items: Array<{ retailerId: string; quantity: number; liedPriceK?: number }>,
) {
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
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  id: wamid,
                  from: waId,
                  timestamp: '1700000000',
                  type: 'order',
                  order: {
                    catalog_id: 'cat-golden',
                    product_items: items.map((item) => ({
                      product_retailer_id: item.retailerId,
                      quantity: item.quantity,
                      /* The customer's device claims a price. It is a lie,
                       * and the parser never lets it in the door. */
                      item_price: item.liedPriceK ?? 1,
                      currency: 'NGN',
                    })),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
