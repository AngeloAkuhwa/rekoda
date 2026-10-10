/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * The fixed order — signature → parse → idempotency → tenant → persist → 200 —
 * is only real if each step is proven against a running app and a real
 * database. Idempotency in particular cannot be tested any other way: it is a
 * claim about a unique constraint under concurrency.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  continuationsRepo,
  conversationsRepo,
  createDb,
  events,
  identity,
  jobsRepo,
  catalogueRepo,
  ordersRepo,
  quotaRepo,
  schema,
  usageRepo,
  stockRepo,
  wabaRepo,
  withBusiness,
  sql,
  type Db,
  suppliersRepo,
} from '@rekoda/db';
import { placeCatalogueOrderWork, validateCatalogueOrderWork } from '../commands/order-commands.js';
import { PLAN_ALLOWANCES, allowanceFor, replies, resolvePeriod, usagePeriod } from '@rekoda/core';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import {
  billingRepo,
  customersRepo,
  issueRepo,
  paymentsHub,
  reportsRepo,
  settleRepo,
  spendRepo,
} from '@rekoda/db';
import {
  decryptFacet,
  encryptFacet,
  matchKeyFor,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { TextExtractionUnavailable } from '../ai/ocr.js';
import { TranscriptionUnavailable } from '../ai/stt.js';
import { registerTranscriptionPrice } from '@rekoda/core';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { SecurityMetrics } from './security-metrics.service.js';
import { meterAllowance } from '../billing/plan-terms.js';

const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'meta-verify-token-for-tests';

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorkerDb: () => Promise<void>;
let deps: RunnerDeps;
let stubTransport: StubTransport;
let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;
const intentsProvider = new StubPaymentProvider();

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

function messagePayload(
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

/** A delivery receipt: same envelope, `statuses` instead of `messages`. */
function invoiceCount(businessId: string): Promise<number> {
  return withBusiness(db, businessId, (tx) => issueRepo.invoiceCount(tx));
}

function statusPayload(recipientId: string, wamid: string, status: string) {
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

/** Sends exactly the bytes it signs — as Meta does. */
function post(payload: unknown, opts: { secret?: string; corrupt?: boolean } = {}) {
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

describe('webhook body ceiling', () => {
  /**
   * The webhooks are exempt from the per-IP limiter, so an oversized body
   * must be refused before it is parsed or an HMAC is computed. A body past
   * the 128 KB cap comes back 413, whatever it carries.
   */
  it('refuses a body larger than the cap with 413, before parsing', async () => {
    const huge = 'x'.repeat(200 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: huge,
      headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('still accepts a normal signed payload', async () => {
    const res = await post({ object: 'whatsapp_business_account', entry: [] });
    expect(res.statusCode).toBe(200);
  });

  /**
   * The cap is only real if it cannot be sidestepped by dropping the header.
   * A chunked request with no Content-Length would otherwise reach the 2 MB
   * global bodyLimit - sixteen times the webhook cap - on the one
   * unauthenticated surface. Real providers always declare a length; a
   * webhook that does not is refused with 411 before the body is read.
   */
  it('refuses a webhook with no Content-Length with 411, before parsing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
    expect(res.statusCode).toBe(411);
  });
});

describe('the subscription handshake', () => {
  it('echoes the challenge for the right token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('refuses the wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A1'));
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('rejects an unsigned payload and stores nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: JSON.stringify(messagePayload('2348031234567', 'wamid.A2')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    // The endpoint is unauthenticated and world-reachable. Persisting
    // unsigned payloads "for forensics" would be an unbounded write for
    // anyone who finds the URL.
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a payload signed with someone else key', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A3'), { secret: 'not-ours' });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a body altered in flight, even by one byte', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A4'), { corrupt: true });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('counts a rejected signature so the ops alarm can fire (PR-108)', async () => {
    // The DB `badSignatures` is a structural zero (rejection is pre-persist);
    // the live counter is what an operator polling /v1/ops/health reads.
    const security = app.get(SecurityMetrics);
    const before = security.rejectedSignatures('meta');
    const res = await post(messagePayload('2348031234567', 'wamid.A5'), { secret: 'not-ours' });
    expect(res.statusCode).toBe(401);
    expect(security.rejectedSignatures('meta')).toBe(before + 1);
  });
});

describe('idempotency', () => {
  it('stores one row however many times Meta retries', async () => {
    const payload = messagePayload('2348031234567', 'wamid.RETRY');
    for (let i = 0; i < 4; i++) expect((await post(payload)).statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('holds under CONCURRENT delivery of the same message', async () => {
    // Meta retries in parallel. A select-then-insert loses this race and
    // records the same sale twice — the failure the unique constraint exists
    // to make impossible.
    const payload = messagePayload('2348031234567', 'wamid.PARALLEL');
    const results = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('keeps sent, delivered and read apart', async () => {
    await post({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.S', status: 'sent' },
                  { id: 'wamid.S', status: 'delivered' },
                  { id: 'wamid.S', status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(await events.eventCount(db)).toBe(3);
  });
});

/* Shared by the cart describe (PR-087/088) and the W3 gate (PR-089). */
function orderPayload(
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

describe('a catalogue cart becomes an order (spec §3.2; W3, PR-087)', () => {
  async function seedCommerceMerchant(phone: string, phoneNumberId: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId: business.id,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      }),
    );
    const wig = await withBusiness(db, business.id, (tx) =>
      catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 150_000 }),
    );
    return { businessId: business.id, wigId: wig.id };
  }

  const ordersOf = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{
        order_number: string;
        status: string;
        total_k: string;
        external_ref: string | null;
        customer_id: string | null;
        invoice_id: string | null;
      }>(sql`
        SELECT order_number, status, total_k::bigint AS total_k, external_ref,
               customer_id, invoice_id
        FROM orders WHERE business_id = ${businessId}::uuid
      `),
    );

  it('prices the cart off the merchant’s own rows, never off the message', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002221', 'PN-CART-1');

    /* The device claims each wig costs 1 kobo. */
    expect(
      (
        await post(
          orderPayload('2349097771111', 'wamid.CART.1', 'PN-CART-1', [
            { retailerId: wigId, quantity: 2, liedPriceK: 1 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const placed = [...(await ordersOf(businessId))];
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      /* PLACED then VALIDATED in the same transaction (PR-088): the
       * §5.2 validation ran against the real catalogue and real shelf
       * before any figure could be shown. */
      status: 'validated',
      external_ref: 'meta:wamid.CART.1',
      /* 2 × the MERCHANT'S 150,000 — the claimed 1 kobo never existed. */
      total_k: '300000',
    });
    /* The customer exists, anchored on their own phone. */
    expect(placed[0]!.customer_id).not.toBeNull();
    /* Validation issued the invoice: a receivable exists NOW, not before. */
    expect(placed[0]!.invoice_id).not.toBeNull();
    const invoice = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ total_k: string; balance_due_k: string; source_type: string }>(sql`
        SELECT total_k::bigint AS total_k, balance_due_k::bigint AS balance_due_k, source_type
        FROM invoices WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...invoice]).toEqual([
      { total_k: '300000', balance_due_k: '300000', source_type: 'waba_catalogue' },
    ]);

    /* The lines carry the shelf's names and prices. */
    const lines = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ name: string; unit_price_k: string; quantity: number }>(sql`
        SELECT name, unit_price_k::bigint AS unit_price_k, quantity::int AS quantity
        FROM order_items WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...lines]).toEqual([{ name: 'wig', unit_price_k: '150000', quantity: 2 }]);

    /* The announcement went out with the fact. */
    const announced = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*) AS n FROM outbox_events
        WHERE business_id = ${businessId}::uuid AND type = 'order.placed'
      `),
    );
    expect([...announced][0]!.n).toBe('1');

    /* And the cart landed on the CUSTOMER's thread as a fact, priceless. */
    const recorded = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*) AS n FROM conversation_messages
        WHERE business_id = ${businessId}::uuid AND body = '[order message]'
      `),
    );
    expect([...recorded][0]!.n).toBe('1');
  });

  /**
   * The door pays what the other doors pay.
   *
   * A cart arriving through WhatsApp becomes the same order and the same
   * invoice a storefront cart becomes, and until now it was the only one of
   * the three that cost the merchant nothing. A merchant on Integrate was
   * metered when the order came through their shop and free when the
   * identical order came through WhatsApp, which made the allowance a
   * number on the pricing page rather than a boundary in the code.
   */
  it('consumes an order unit and a document unit, as the other doors do', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002261', 'PN-METER-1');
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776111', 'wamid.METER.1', 'PN-METER-1', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  /* Idempotency and metering have to agree: Meta redelivers, and a second
   * delivery that places no second order must not charge for one either. */
  it('charges nothing twice for a redelivered webhook', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002262', 'PN-METER-2');
    const period = usagePeriod(new Date());
    const payload = orderPayload('2349097776222', 'wamid.METER.2', 'PN-METER-2', [
      { retailerId: wigId, quantity: 1 },
    ]);

    await post(payload);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(payload);
    await buildRunner(workerDb, db, deps).runOnce();

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  /**
   * A used-up allowance stops the order rather than taking it for free.
   *
   * The counter is spent through the same door the confirmation spends it,
   * so the refusal below is the real one rather than a simulated state.
   */
  it('takes no order once the orders allowance is used up, and charges nothing', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002263', 'PN-METER-3');
    const period = usagePeriod(new Date());
    const orderAllowance = allowanceFor('trial', 'CATALOGUE_ORDERS');
    for (let taken = 0; taken < orderAllowance; taken += 1) {
      expect(
        await withBusiness(db, businessId, (tx) =>
          usageRepo.consumeUnit(tx, businessId, period, 'CATALOGUE_ORDERS', orderAllowance),
        ),
      ).toBe(true);
    }

    await post(
      orderPayload('2349097776333', 'wamid.METER.3', 'PN-METER-3', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* No order, no invoice, and the document unit was never taken: the
     * refusal happens before anything is reserved beyond the order unit
     * the counter itself refused. */
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(orderAllowance);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /**
   * A plan that does not sell takes nothing at all.
   *
   * Chat carries no `REKODA_INTEGRATE`, and the gate answers before the
   * meter so the merchant is not charged for discovering that their plan
   * cannot capture orders.
   */
  it('takes no order and charges nothing on a plan without Integrate', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002264', 'PN-METER-4');
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:test',
    });
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776444', 'wamid.METER.4', 'PN-METER-4', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  /* A cart the shelf cannot serve is refused before the meter, so a
   * customer naming something that does not exist cannot spend the
   * merchant's allowance. */
  it('charges nothing for a cart naming an item the shelf does not sell', async () => {
    const { businessId } = await seedCommerceMerchant('+2348030002265', 'PN-METER-5');
    const period = usagePeriod(new Date());

    await post(
      orderPayload('2349097776555', 'wamid.METER.5', 'PN-METER-5', [
        { retailerId: 'not-a-product-of-this-shop', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  it('a redelivered webhook places nothing twice', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002222', 'PN-CART-2');
    const payload = orderPayload('2349097772222', 'wamid.CART.2', 'PN-CART-2', [
      { retailerId: wigId, quantity: 1 },
    ]);

    await post(payload);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(payload);
    await buildRunner(workerDb, db, deps).runOnce();

    expect([...(await ordersOf(businessId))]).toHaveLength(1);
  });

  it('refuses a cart the counted shelf cannot serve, leaving the order visibly cancelled', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002224', 'PN-CART-4');
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 1,
        costK: 20_000,
        sourceType: 'chat',
      });
    });

    await post(
      orderPayload('2349097774444', 'wamid.CART.4', 'PN-CART-4', [
        { retailerId: wigId, quantity: 3 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The request stands, visibly refused; nothing financial exists. */
    const refused = [...(await ordersOf(businessId))];
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 'cancelled', invoice_id: null });
    const ledger = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...ledger][0]!.n).toBe('0');
  });

  it('a counted shelf serves the cart, commits the goods, and the fee lands as a record', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002225', 'PN-CART-5');
    await withBusiness(db, businessId, async (tx) => {
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 5,
        costK: 100_000,
        sourceType: 'chat',
      });
      await paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' });
    });

    await post(
      orderPayload('2349097775555', 'wamid.CART.5', 'PN-CART-5', [
        { retailerId: wigId, quantity: 2 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Goods committed at their cost: 2 off the shelf, COGS 2 × 20,000. */
    const shelf = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'wig'),
    );
    expect(shelf).toMatchObject({ onHand: 3 });
    const cogs = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code = '5000'
      `),
    );
    expect([...cogs][0]!.k).toBe('40000');

    /* §19.1: the provider's expected fee is a RECORD — estimated from the
     * observed rate card (1% capped ₦300), merchant-borne, resolved to
     * actual by settlement. 1% of 300,000 kobo = 3,000. */
    const charges = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        type: string;
        amount_minor: string;
        beneficiary: string;
        economic_bearer: string;
        actual_or_estimated: string;
      }>(sql`
        SELECT type, amount_minor::bigint AS amount_minor, beneficiary, economic_bearer,
               actual_or_estimated
        FROM payment_charges WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...charges]).toEqual([
      {
        type: 'PAYMENT_PROCESSING',
        amount_minor: '3000',
        beneficiary: 'PROVIDER',
        economic_bearer: 'MERCHANT',
        actual_or_estimated: 'ESTIMATED',
      },
    ]);
  });

  it('a price moved between placement and validation refuses rather than re-quotes', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002226', 'PN-CART-6');

    const rejected = await withBusiness(db, businessId, async (tx) => {
      const placed = await placeCatalogueOrderWork(tx, {
        businessId,
        customerId: null,
        lines: [
          { productId: wigId, name: 'wig', quantity: 1, unitPriceK: 150_000, lineTotalK: 150_000 },
        ],
        totalK: 150_000,
        externalRef: 'meta:wamid.CART.6',
        sourceId: 'wamid.CART.6',
      });
      /* The merchant moves the price while the order sits PLACED. */
      await catalogueRepo.editProduct(tx, businessId, wigId, { unitPriceK: 175_000 });
      return validateCatalogueOrderWork(tx, {
        businessId,
        orderId: placed.orderId,
        actor: 'customer:waba',
      });
    });
    expect(rejected).toEqual({ outcome: 'rejected', reason: 'price_changed' });
    expect([...(await ordersOf(businessId))][0]).toMatchObject({
      status: 'cancelled',
      invoice_id: null,
    });
  });

  it('refuses the WHOLE cart when it names an item the shelf does not sell', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002223', 'PN-CART-3');

    await post(
      orderPayload('2349097773333', 'wamid.CART.3', 'PN-CART-3', [
        { retailerId: wigId, quantity: 1 },
        { retailerId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* No partial order: a customer shown an order they did not compose
     * would pay for a guess. The message still landed on their thread. */
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
  });

  it('refuses a cart naming a SKU rather than crashing on it (remediation R3)', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002224', 'PN-CART-4');

    /* A merchant whose Meta catalog was built outside Rekoda sends their own
     * SKU. It reached `inArray(products.id, ...)` on a uuid column, so the
     * job died with `invalid input syntax for type uuid` and the customer
     * heard nothing at all. A string nothing matches is a refusal. */
    await post(
      orderPayload('2349097773444', 'wamid.CART.4', 'PN-CART-4', [
        { retailerId: wigId, quantity: 1 },
        { retailerId: 'BLACK-SHOE-XL', quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    /* The job finished. A crash would have left it pending for a retry that
     * fails the same way five times. */
    const live = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM jobs
               WHERE business_id = ${businessId}::uuid AND state <> 'done'`,
        ),
      )),
    ];
    expect(live[0]!.n).toBe('0');
  });

  it("prices a cart off the merchant's own SKU when the shelf carries one", async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002225', 'PN-CART-5');
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE products SET external_catalogue_id = 'WIG-001'
             WHERE business_id = ${businessId}::uuid AND id = ${wigId}::uuid`,
      ),
    );

    await post(
      orderPayload('2349097773555', 'wamid.CART.5R3', 'PN-CART-5', [
        { retailerId: 'WIG-001', quantity: 2 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const placed = [...(await ordersOf(businessId))];
    expect(placed).toHaveLength(1);
    /* 2 x the merchant's own 150,000, read off their row as always. */
    expect(placed[0]).toMatchObject({ total_k: '300000', external_ref: 'meta:wamid.CART.5R3' });
  });
});

/**
 * The WABA catalogue door and the storefront door are now the same door
 * (remediation R2).
 *
 * Before this, `REKODA_COMMAND_PLACE_ORDER` was off unless an environment
 * set it, and both ingresses kept an else branch that called the work
 * function directly. The storefront's branch at least checked entitlement
 * itself; the WABA branch checked nothing. Which gates a customer's order
 * passed through depended on which door they walked in by.
 */
describe('every order ingress goes through PlaceOrder (remediation R2)', () => {
  async function seedCatalogueMerchant(
    phone: string,
    phoneNumberId: string,
    plan: 'integrate' | 'chat',
  ) {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    /* A fresh trial business holds BOTH capabilities, so refusing one has to
     * be done by pinning the plan rather than by not granting (the same find
     * PR-025 recorded for the storefront). */
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan,
      expiresAt: null,
      actor: 'operator:test',
    });
    const wig = await withBusiness(db, business.id, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId: business.id,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      });
      return catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 150_000 });
    });
    return { businessId: business.id, wigId: wig.id };
  }

  const orderCount = async (businessId: string) =>
    [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM orders WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ][0]!.n;

  it('refuses a catalogue order from a plan that does not carry Integrate, and takes nothing', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002261',
      'PN-R2-REFUSE',
      'chat',
    );

    expect(
      (
        await post(
          orderPayload('2349097776111', 'wamid.R2.REFUSE', 'PN-R2-REFUSE', [
            { retailerId: wigId, quantity: 1 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* §4.3 rule 1: a refused request consumes nothing. Entitlement runs
     * before the idempotency key, so there is no claim either. */
    expect(await orderCount(businessId)).toBe('0');
    const claims = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM idempotency_records
               WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    expect(claims[0]!.n).toBe('0');
  });

  it('claims an idempotency key for a catalogue order, which the legacy branch never did', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002262',
      'PN-R2-KEY',
      'integrate',
    );

    await post(
      orderPayload('2349097776222', 'wamid.R2.KEY', 'PN-R2-KEY', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(await orderCount(businessId)).toBe('1');
    const claims = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ key: string; command_name: string }>(
          sql`SELECT key, command_name FROM idempotency_records
               WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    /* The webhook's own message id is the retry identity, the same one the
     * ingress already dedupes on. */
    expect(claims).toEqual([{ key: 'meta:wamid.R2.KEY', command_name: 'PlaceOrder' }]);
  });

  it('refuses to place through the legacy branch when the flag is switched off', async () => {
    const { businessId, wigId } = await seedCatalogueMerchant(
      '+2348030002263',
      'PN-R2-LEGACY',
      'integrate',
    );

    await post(
      orderPayload('2349097776333', 'wamid.R2.LEGACY', 'PN-R2-LEGACY', [
        { retailerId: wigId, quantity: 1 },
      ]),
    );
    /* PlaceOrder's 0 is not a rollback (OD-4, OWN-22): the legacy branch was
     * retired, and it must refuse rather than quietly take an order. */
    expect(
      await buildRunner(workerDb, db, {
        ...deps,
        config: { ...deps.config, commandPlaceOrder: false },
      }).runOnce(),
    ).toBe(true);

    expect(await orderCount(businessId)).toBe('0');
    const failed = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<{ last_error: string | null }>(
          sql`SELECT last_error FROM jobs WHERE business_id = ${businessId}::uuid`,
        ),
      )),
    ];
    expect(failed[0]?.last_error).toContain('REKODA_COMMAND_PLACE_ORDER');
  });
});

describe('the W3 completion gate: catalogue to receipt (spec §3.2; PR-089)', () => {
  const OWNER = '+2348030002230';
  const CUSTOMER_WA = '2349097779999';

  /**
   * The whole storefront, stood up the way production stands it up: a
   * merchant on the Integrate plan with a CONNECTED WABA whose token
   * actually decrypts, a counted shelf, an ACTIVE Paystack connection
   * (which provisions its own clearing account, PR-053), and SERVICE
   * capacity granted as a bonus because SERVICE_MESSAGE is sold on no
   * plan until the pricing decision, and 0 means zero.
   */
  async function seedGateMerchant(
    phoneNumberId: string,
    opts: { email?: boolean; capacity?: boolean } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });

    const wigId = await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      const wig = await catalogueRepo.createProduct(tx, businessId, {
        name: 'wig',
        unitPriceK: 150_000,
      });
      const shelfRow = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: shelfRow,
        quantity: 5,
        costK: 100_000,
        sourceType: 'chat',
      });
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
      const period = usagePeriod(new Date());
      if (opts.capacity === false) {
        /* Spend the month, rather than assume the plan sells none. Integrate
         * sells 5,000 SERVICE_MESSAGE since PR-117, so "no capacity" is now
         * a merchant who has USED theirs, which is the state the fallback
         * below actually exists for. The figure is read rather than
         * retyped, so a repricing does not silently stop exhausting it. */
        const sold = await meterAllowance(
          deps.config,
          tx,
          businessId,
          'integrate',
          'SERVICE_MESSAGE',
        );
        if (sold > 0) {
          await usageRepo.consumeUnit(tx, businessId, period, 'SERVICE_MESSAGE', sold, sold);
        }
      } else {
        await usageRepo.creditBonus(tx, businessId, period, 'SERVICE_MESSAGE', 5);
      }
      return wig.id;
    });

    /* The customer exists BEFORE the cart, the way a repeat buyer does —
     * same phone anchor the webhook resolves, so the cart lands on this
     * very record. The email is what the Paystack mint needs; it is on
     * file because the merchant saved it, never invented. */
    const resolved = await deps.gateway.resolveStorefrontCustomer(
      businessId,
      'Chidi',
      `+${CUSTOMER_WA}`,
    );
    if (!resolved) throw new Error('fixture: customer did not resolve');
    if (opts.email !== false) {
      await customersRepo.addIdentityFacet(db, businessId, resolved.customerId, {
        facet: 'email',
        ciphertext: encryptFacet('chidi@example.com', deps.config.vaultKey, `${businessId}:email`),
        matchKey: null,
      });
    }
    return { businessId, wigId };
  }

  async function drainAll(): Promise<number> {
    const runner = buildRunner(workerDb, db, deps);
    let ran = 0;
    while (await runner.runOnce()) ran += 1;
    return ran;
  }

  const invoiceOf = async (businessId: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        id: string;
        invoice_number: string;
        status: string;
        total_k: string;
        balance_due_k: string;
      }>(sql`
        SELECT id, invoice_number, status, total_k::bigint AS total_k,
               balance_due_k::bigint AS balance_due_k
        FROM invoices WHERE business_id = ${businessId}::uuid
      `),
    );
    return [...rows][0] ?? null;
  };

  const roleBalance = async (businessId: string, role: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.system_role = ${role}
      `),
    );
    return Number([...rows][0]!.k);
  };

  it('an order from the catalogue reaches a receipt in the merchant thread, books correct end to end', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-1');

    /* 1 ── the cart, through the real webhook ingress. */
    expect(
      (
        await post(
          orderPayload(CUSTOMER_WA, 'wamid.GATE.1', 'PN-GATE-1', [
            { retailerId: wigId, quantity: 2 },
          ]),
        )
      ).statusCode,
    ).toBe(200);
    await drainAll();

    /* 2 ── validated, invoiced, and the CHECKOUT is with the customer, in
     * their own thread on the merchant's number: the server's figure and
     * the payable link, nothing their device claimed. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued', total_k: '300000', balance_due_k: '300000' });
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-GATE-1',
      accessToken: 'EAAG-merchant-token',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain(invoice!.invoice_number);
    expect(stubSender.connectionTexts[0]!.text).toContain('₦3,000');
    expect(stubSender.connectionTexts[0]!.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);

    /* The merchant's notice says the link is WITH the customer, not
     * "forward it": the system knows what it just did. */
    const notice = stubSender.sent.find((m) => m.text.includes('New WhatsApp order'));
    expect(notice?.to).toBe(OWNER);
    expect(notice?.text).toContain(invoice!.invoice_number);
    expect(notice?.text).toContain('with your customer');

    /* 3 ── the customer pays: charge.success on the SAME reference the
     * checkout was raised with, verified server-side (§6.3) before one
     * kobo is booked. */
    const intent = await withBusiness(db, businessId, (tx) =>
      paymentsHub.liveIntentForInvoice(tx, businessId, invoice!.id),
    );
    expect(intent).not.toBeNull();
    intentsProvider.willVerify(intent!.reference, { amountK: 300_000, providerFeeK: 4_500 });
    const body = {
      event: 'charge.success',
      data: {
        id: 77_001,
        reference: intent!.reference,
        amount: 300_000,
        currency: 'NGN',
        status: 'success',
        customer: { email: 'chidi@example.com' },
      },
    };
    await events.recordEvent(db, {
      provider: 'paystack',
      eventType: body.event,
      externalId: `77001:${body.event}`,
      payload: sealPayload(body, deps.config.vaultKey, 'paystack', `77001:${body.event}`),
      businessId: null,
    });
    expect(await pumpPaystackEvents({ workerDb, appDb: db, vaultKey: deps.config.vaultKey })).toBe(
      1,
    );
    await drainAll();

    /* 4 ── the gate: paid, receipted, and the receipt lands in the
     * MERCHANT'S OWN THREAD with the confirmed figure (§3.2's last line). */
    expect(await invoiceOf(businessId)).toMatchObject({ status: 'paid', balance_due_k: '0' });
    const delivered = stubSender.lastDocument;
    expect(delivered?.to).toBe(OWNER);
    expect(delivered?.caption).toContain('Money in ✅ ₦3,000 confirmed for');
    expect(delivered?.caption).toContain(invoice!.invoice_number);
    expect(delivered?.bytes.subarray(0, 5).toString()).toBe('%PDF-');

    /* 5 ── the accounting, held to §21.1 invariant 10: the money is where
     * the books say it is. Gross parks in the CONNECTION'S clearing
     * account (settlement moves it to bank with ACTUAL fees, §20); the
     * receivable opened by the invoice is cleared by the payment; no bank,
     * no fee expense yet; the §19.1 estimate is still a RECORD awaiting
     * its settlement. */
    expect(await roleBalance(businessId, 'PAYMENT_PROVIDER_CLEARING')).toBe(300_000);
    expect(await roleBalance(businessId, 'ACCOUNTS_RECEIVABLE')).toBe(0);
    const charges = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actual_or_estimated: string }>(
        sql`SELECT actual_or_estimated FROM payment_charges WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...charges].map((c) => c.actual_or_estimated)).toEqual(['ESTIMATED']);
  });

  it('no email on file: the customer still hears the order stands, the merchant hears no link exists', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-2', { email: false });

    await post(
      orderPayload(CUSTOMER_WA, 'wamid.GATE.2', 'PN-GATE-2', [{ retailerId: wigId, quantity: 1 }]),
    );
    await drainAll();

    /* §37 "missing customer email" is a product state, not an error: no
     * link is invented, the order's confirmation still carries the
     * server's figure, and the merchant hears the order landed. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued', total_k: '150000' });
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('Payment details will follow');
    expect(stubSender.connectionTexts[0]!.text).not.toContain('http');
    const notice = stubSender.sent.find((m) => m.text.includes('New WhatsApp order'));
    expect(notice?.to).toBe(OWNER);
    expect(notice?.text).toContain('could not raise a payment link');
  });

  it('capacity at zero: the checkout falls back to a forwardable link in the merchant thread', async () => {
    const { businessId, wigId } = await seedGateMerchant('PN-GATE-3', { capacity: false });

    await post(
      orderPayload(CUSTOMER_WA, 'wamid.GATE.3', 'PN-GATE-3', [{ retailerId: wigId, quantity: 1 }]),
    );
    await drainAll();

    /* The month's SERVICE_MESSAGE is spent, and spent means spent: the
     * customer leg refuses without consuming, and the link falls back to
     * the merchant to forward — the money can still move. */
    const invoice = await invoiceOf(businessId);
    expect(invoice).toMatchObject({ status: 'issued' });
    expect(stubSender.connectionTexts).toHaveLength(0);
    const forwardable = stubSender.sent.find((m) => m.text.includes('Payment link for'));
    expect(forwardable?.to).toBe(OWNER);
    expect(forwardable?.text).toContain('Forward it to your customer');
    expect(forwardable?.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });
});

describe('the away assistant (spec Appendix D; W4, PR-090)', () => {
  const CUSTOMER_WA = '2349097778888';

  async function seedAssistantMerchant(
    phoneNumberId: string,
    opts: { enabled?: boolean; limit?: number } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, '+2348030002240');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      await catalogueRepo.createProduct(tx, businessId, { name: 'wig', unitPriceK: 150_000 });
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 4,
        costK: 100_000,
        sourceType: 'chat',
      });
      await usageRepo.creditBonus(tx, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 5);
      await wabaRepo.setAssistantSettings(tx, businessId, {
        enabled: opts.enabled ?? true,
        dailyReplyLimit: opts.limit ?? 3,
      });
    });
    return businessId;
  }

  const ask = (phoneNumberId: string, wamid: string, text: string) =>
    post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId));

  it('answers price and availability off the merchant’s own rows, inside the window', async () => {
    const businessId = await seedAssistantMerchant('PN-AWAY-1');

    expect((await ask('PN-AWAY-1', 'wamid.AWAY.1', 'How much is the wig?')).statusCode).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-AWAY-1',
      text: 'wig: ₦1,500. In stock.',
    });
    /* Metered like every customer send, and counted against the ceiling. */
    const used = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COALESCE(SUM(replies), 0) AS n FROM away_assistant_replies WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...used][0]!.n).toBe('1');
    /* Text only: the assistant transacted nothing (Appendix D, absolute). */
    const ledger = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...ledger][0]!.n).toBe('0');
  });

  it('an assistant nobody enabled answers nobody', async () => {
    await seedAssistantMerchant('PN-AWAY-2', { enabled: false });

    await ask('PN-AWAY-2', 'wamid.AWAY.2', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(0);
  });

  it('past the ceiling the assistant hands off rather than going silent', async () => {
    await seedAssistantMerchant('PN-AWAY-3', { limit: 1 });

    await ask('PN-AWAY-3', 'wamid.AWAY.3A', 'wig price?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await ask('PN-AWAY-3', 'wamid.AWAY.3B', 'and the wig again?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The answer, then the handoff: beyond the merchant's own line a
     * human takes over, and the customer is TOLD so (PR-091). */
    expect(stubSender.connectionTexts).toHaveLength(2);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
    expect(stubSender.connectionTexts[1]!.text).toContain('reply to you personally');
  });

  it('hands off what the shelf cannot answer, and says it is doing so, once (PR-091)', async () => {
    await seedAssistantMerchant('PN-AWAY-4');

    await ask('PN-AWAY-4', 'wamid.AWAY.4A', 'when do you open tomorrow?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The customer hears a person will reply — no guess, no filler — on
     * the merchant's own number. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-AWAY-4',
      text: 'Thanks for your message. Someone from the shop will reply to you personally.',
    });
    /* And the merchant hears a customer is waiting, in their own thread,
     * with no customer identity riding the notice (F.3). */
    const notice = stubSender.sent.find((m) => m.text.includes('could not answer'));
    expect(notice?.to).toBe('+2348030002240');
    expect(notice?.text).toContain('waiting on your business WhatsApp');
    expect(notice?.text).not.toMatch(/234909/);

    /* A second unanswerable message the same day repeats NOTHING: the
     * promise was made, and a machine restating it is a machine stalling. */
    await ask('PN-AWAY-4', 'wamid.AWAY.4B', 'hello? are you there?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it('an assistant nobody enabled hands off nothing either', async () => {
    await seedAssistantMerchant('PN-AWAY-5', { enabled: false });

    await ask('PN-AWAY-5', 'wamid.AWAY.5', 'when do you open tomorrow?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The merchant handles their own WhatsApp; Rekoda adds no noise. */
    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.sent.find((m) => m.text.includes('could not answer'))).toBeUndefined();
  });
});

describe("a customer's own STOP (PR-135)", () => {
  /* The customer side of consent, kept deliberately apart from the merchant
   * side tested above. The same words, a different fact, a different table
   * and a different person: here it is somebody's CUSTOMER asking a shop to
   * stop, not a merchant asking Rekoda to stop. */
  const CUSTOMER_WA = '2349097771234';
  const OWNER = '+2348030002270';

  async function seedShop(phoneNumberId: string) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      await catalogueRepo.createProduct(tx, businessId, { name: 'wig', unitPriceK: 150_000 });
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 4,
        costK: 100_000,
        sourceType: 'chat',
      });
      await usageRepo.creditBonus(tx, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 20);
      /* The assistant ON, so "silent afterwards" means the suppression did
       * it and not the absence of anything to say. */
      await wabaRepo.setAssistantSettings(tx, businessId, { enabled: true, dailyReplyLimit: 10 });
    });
    return businessId;
  }

  const say = (phoneNumberId: string, wamid: string, text: string) =>
    post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId));

  const refusals = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string; opted_out_at: Date | null }>(sql`
        SELECT count(*)::text AS n, max(opted_out_at) AS opted_out_at
          FROM customer_message_optouts
         WHERE business_id = ${businessId}::uuid
      `),
    );

  it('STOP is acknowledged, recorded, and silences the shop afterwards', async () => {
    const businessId = await seedShop('PN-STOP-1');

    expect((await say('PN-STOP-1', 'wamid.STOP.C1', 'STOP')).statusCode).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* One acknowledgement, in the customer's own words: they are not a
     * Rekoda user and the sentence must not pretend they are. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-STOP-1',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');

    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();

    /* And the shop is quiet. The assistant would have answered this one
     * happily a moment ago; now nothing leaves at all. */
    await say('PN-STOP-1', 'wamid.STOP.C2', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it.each([
    ['*STOP*', 'PN-STOP-DEC-1'],
    ['🛑STOP🛑', 'PN-STOP-DEC-2'],
  ])('a decorated %j from a customer silences the shop (G-24)', async (text, pnid) => {
    const businessId = await seedShop(pnid);
    await say(pnid, `wamid.STOP.DEC.${pnid}`, text);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
  });

  it.each([
    ['abeg stop', 'PN-STOP-G80-1'],
    ['no send me again', 'PN-STOP-G80-2'],
    ['make una stop', 'PN-STOP-G80-3'],
  ])('a natural %j from a customer silences the shop as STOP does (G-80)', async (text, pnid) => {
    const businessId = await seedShop(pnid);
    await say(pnid, `wamid.STOP.G80.${pnid}`, text);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
    // No model reads a consent message, and none is metered.
    expect(stubTransport.requests).toHaveLength(0);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);

    /* And the shop is quiet afterwards. */
    await say(pnid, `wamid.STOP.G80.${pnid}.after`, 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
    // The merchant's own consent is untouched.
    expect(await identity.optedOutAt(db, OWNER)).toBeNull();
  });

  it('a customer sentence that merely contains a natural form is still a question (G-80)', async () => {
    const businessId = await seedShop('PN-STOP-G80-4');
    await say(
      'PN-STOP-G80-4',
      'wamid.STOP.G80.C4',
      'abeg stop the wig order, I go buy am tomorrow',
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect([...(await refusals(businessId))][0]!.n).toBe('0');
  });

  it('does not opt the MERCHANT out of anything', async () => {
    const businessId = await seedShop('PN-STOP-2');

    await say('PN-STOP-2', 'wamid.STOP.C3', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The merchant's own consent flag is a different column about a
     * different person, and a customer must not be able to reach it. */
    expect(await identity.optedOutAt(db, OWNER)).toBeNull();
    expect([...(await refusals(businessId))][0]!.n).toBe('1');
  });

  it('a merchant telling REKODA to stop leaves their customers reachable', async () => {
    /* The mirror of the test above, and the reason the two facts are two
     * tables: a merchant who stops their own notifications has not asked
     * their shop to stop serving anybody. */
    const businessId = await seedShop('PN-STOP-3');

    await post(messagePayload(OWNER.slice(1), 'wamid.STOP.M1', 'stop'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(await identity.optedOutAt(db, OWNER)).not.toBeNull();
    expect([...(await refusals(businessId))][0]!.n).toBe('0');

    /* The customer still gets served. */
    await say('PN-STOP-3', 'wamid.STOP.C4', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
  });

  it('repeating STOP changes nothing and says nothing more', async () => {
    const businessId = await seedShop('PN-STOP-4');

    await say('PN-STOP-4', 'wamid.STOP.C5', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const first = [...(await refusals(businessId))][0]!.opted_out_at;

    await say('PN-STOP-4', 'wamid.STOP.C6', 'unsubscribe');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The second acknowledgement is refused by the very rule the first one
     * created: somebody who asked to be left alone is left alone, and that
     * includes being left alone about having asked. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(new Date(row!.opted_out_at!).toISOString()).toBe(new Date(first!).toISOString());
  });

  it('START opens the shop back up, and is acknowledged', async () => {
    const businessId = await seedShop('PN-STOP-5');

    await say('PN-STOP-5', 'wamid.STOP.C7', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);

    await say('PN-STOP-5', 'wamid.STOP.C8', 'START');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Recorded BEFORE the acknowledgement, which is why the acknowledgement
     * can be sent at all: the opposite order would need a hole in the
     * suppression check. */
    expect(stubSender.connectionTexts).toHaveLength(2);
    expect(stubSender.connectionTexts[1]!.text).toContain('this shop');

    const [row] = [...(await refusals(businessId))];
    /* The row stays: that they once asked is itself worth keeping. */
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).toBeNull();

    await say('PN-STOP-5', 'wamid.STOP.C9', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(3);
    expect(stubSender.connectionTexts[2]!.text).toContain('wig');
  });

  it('a question that merely contains the word is still a question', async () => {
    await seedShop('PN-STOP-6');

    await say('PN-STOP-6', 'wamid.STOP.C10', 'do you stop selling wig soon?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Over-matching here would silence a shop's paying customer for good.
     * The handler asks the same tight recogniser the merchant path uses. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
  });

  /* ── a tap is a message too (remediation R11) ───────────────────────────
   * WhatsApp delivers a pressed button with no `text` at all, so before
   * this the opt-out gate never saw it and the tap fell through to the
   * assistant, which answered a person who had just asked to be left
   * alone. */
  const tapPayload = (phoneNumberId: string, wamid: string, message: Record<string, unknown>) => ({
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
              messages: [{ id: wamid, from: CUSTOMER_WA, timestamp: '1700000000', ...message }],
            },
          },
        ],
      },
    ],
  });

  it('a tapped template button is heard as STOP', async () => {
    const businessId = await seedShop('PN-STOP-7');

    await post(
      tapPayload('PN-STOP-7', 'wamid.STOP.C11', {
        type: 'button',
        button: { payload: 'stop', text: 'Stop messages' },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
    expect([...(await refusals(businessId))][0]!.opted_out_at).not.toBeNull();

    /* And the shop is quiet, which is the whole point of hearing it. */
    await say('PN-STOP-7', 'wamid.STOP.C12', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it('an interactive reply is heard, and tapping it twice changes nothing', async () => {
    const businessId = await seedShop('PN-STOP-8');

    await post(
      tapPayload('PN-STOP-8', 'wamid.STOP.C13', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'UNSUBSCRIBE' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const first = [...(await refusals(businessId))][0]!.opted_out_at;
    expect(first).not.toBeNull();

    await post(
      tapPayload('PN-STOP-8', 'wamid.STOP.C14', {
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'y', title: 'stop' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(new Date(row!.opted_out_at!).toISOString()).toBe(new Date(first!).toISOString());
  });

  it('a tapped START opens the shop back up', async () => {
    const businessId = await seedShop('PN-STOP-9');

    await say('PN-STOP-9', 'wamid.STOP.C15', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    await post(
      tapPayload('PN-STOP-9', 'wamid.STOP.C16', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'start', title: 'Yes please' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(2);
    expect([...(await refusals(businessId))][0]!.opted_out_at).toBeNull();
  });

  it('an ordinary button is an ordinary message', async () => {
    const businessId = await seedShop('PN-STOP-10');

    await post(
      tapPayload('PN-STOP-10', 'wamid.STOP.C17', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'see', title: 'See prices' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Nobody is silenced by pressing a button that did not say so. Reading
     * the id as well as the title is what makes this worth asserting: a
     * looser matcher would have found 'see' or 'prices' interesting. */
    expect([...(await refusals(businessId))][0]!.n).toBe('0');
  });
});

describe('one customer, both products (spec §5.3 X2; X1, PR-092)', () => {
  it('a Chat sale and a WABA order for the same phone land on ONE customer, one ledger, one AR', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030002250');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    const wigId = await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: 'waba-X2',
        phoneNumberId: 'PN-X2',
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      });
      const wig = await catalogueRepo.createProduct(tx, businessId, {
        name: 'wig',
        unitPriceK: 150_000,
      });
      return wig.id;
    });

    /* Week one: Chat records a walk-in sale to Chidi, anchored on the
     * phone the privacy gateway folds every identity onto. */
    const chidi = await deps.gateway.resolveStorefrontCustomer(
      businessId,
      'Chidi',
      '+2349097776666',
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: chidi!.customerId,
        customerToken: chidi!.token,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 150_000 }],
        subtotalK: 150_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 150_000,
        paidK: 0,
        balanceDueK: 150_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-x2',
        actor: 'owner',
      }),
    );

    /* Week two: the SAME phone sends a cart on the merchant's WABA. */
    await post(
      orderPayload('2349097776666', 'wamid.X2.1', 'PN-X2', [{ retailerId: wigId, quantity: 2 }]),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* ONE customer record: neither product holds its own customer table,
     * and identity resolved through the gateway in both directions. */
    const customers = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string; id: string }>(
        sql`SELECT COUNT(*) AS n, MIN(id::text) AS id FROM customers WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...customers][0]!.n).toBe('1');
    expect([...customers][0]!.id).toBe(chidi!.customerId);

    /* Both invoices hang off that one record — the Chat sale and the
     * validated WABA order. */
    const invoices = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer_id: string; source_type: string; balance_due_k: string }>(
        sql`SELECT customer_id, source_type, balance_due_k::bigint AS balance_due_k
            FROM invoices WHERE business_id = ${businessId}::uuid ORDER BY created_at`,
      ),
    );
    const rows = [...invoices];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source_type).sort()).toEqual(['chat', 'waba_catalogue']);
    expect(rows.every((r) => r.customer_id === chidi!.customerId)).toBe(true);

    /* ONE ledger, ONE AR balance: the receivable is the sum of both,
     * in one account, not a figure per product. */
    const ar = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ k: string }>(sql`
        SELECT COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint AS k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.system_role = 'ACCOUNTS_RECEIVABLE'
      `),
    );
    expect(Number([...ar][0]!.k)).toBe(150_000 + 300_000);
  });
});

describe('send payment details across products (spec §5.3 X1; PR-093)', () => {
  const OWNER = '+2348030002260';
  const CUSTOMER_PHONE = '+2349097775577';

  async function seedComplete(
    phoneNumberId: string,
    opts: { plan?: 'complete' | 'chat'; windowOpen?: boolean } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await billingRepo.setPlan(db, {
      businessId,
      plan: opts.plan ?? 'complete',
      expiresAt: null,
      actor: 'operator:test',
    });
    let connectionId = '';
    await withBusiness(db, businessId, async (tx) => {
      const connected = await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      if (connected.outcome === 'connected') connectionId = connected.id;
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
      await usageRepo.creditBonus(tx, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 5);
    });

    /* Chidi: phone-anchored through the gateway, email on file for the
     * mint, and (usually) a service window their last message opened. */
    const chidi = await deps.gateway.resolveStorefrontCustomer(businessId, 'Chidi', CUSTOMER_PHONE);
    await customersRepo.addIdentityFacet(db, businessId, chidi!.customerId, {
      facet: 'email',
      ciphertext: encryptFacet('chidi@example.com', deps.config.vaultKey, `${businessId}:email`),
      matchKey: null,
    });
    if (opts.windowOpen !== false) {
      const blindIndex = participantIndexFor(deps.config.matchKey, {
        businessId,
        channelAccountId: phoneNumberId,
        keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        normalisedParticipant: CUSTOMER_PHONE,
      });
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.touchServiceWindow(tx, {
          businessId,
          wabaConnectionId: connectionId,
          customerHash: blindIndex,
        }),
      );
    }

    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: chidi!.customerId,
        customerToken: chidi!.token,
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-x1',
        actor: 'owner',
      }),
    );
    return businessId;
  }

  async function ask(wamid: string) {
    await post(messagePayload(OWNER.slice(1), wamid, 'send payment details'));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  const intentCount = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx
        .execute<{
          n: string;
        }>(sql`SELECT COUNT(*) AS n FROM payment_intents WHERE business_id = ${businessId}::uuid`)
        .then((rows) => Number([...rows][0]!.n)),
    );

  it('a Complete business delivers into the customer thread: one intent, said plainly to both sides', async () => {
    const businessId = await seedComplete('PN-X1-1');

    await ask('wamid.X1.1');

    /* The customer holds the details, in their own thread on the
     * merchant's number: the figure and the link, nothing else. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: CUSTOMER_PHONE,
      phoneNumberId: 'PN-X1-1',
      accessToken: 'EAAG-merchant-token',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain('₦80,000 due');
    expect(stubSender.connectionTexts[0]!.text).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);

    /* The merchant hears where it WENT, never "forward it". */
    expect(stubSender.lastText).toContain('Sent ✅ payment details for INV');
    expect(stubSender.lastText).not.toContain('Forward it');

    /* ONE intent. A second ask reuses it — one obligation, one reference
     * — so when Chidi pays there is exactly one thing to reconcile. */
    expect(await intentCount(businessId)).toBe(1);
    await ask('wamid.X1.2');
    expect(await intentCount(businessId)).toBe(1);
    const first = stubSender.connectionTexts[0]!.text;
    const second = stubSender.connectionTexts[1]!.text;
    expect(second).toBe(first);
  });

  it('a Chat-only business gets the details in their own hands, and nothing enters the customer thread', async () => {
    await seedComplete('PN-X1-2', { plan: 'chat' });

    await ask('wamid.X1.3');

    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001/);
    expect(stubSender.lastText).toContain('Forward it to your customer');
  });

  it('a closed window falls back to the forwardable link rather than a send Meta will refuse', async () => {
    await seedComplete('PN-X1-3', { windowOpen: false });

    await ask('wamid.X1.4');

    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.lastText).toContain('Forward it to your customer');
  });
});

describe('phoneNumberId → BusinessId routing (spec §24; PR-059)', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function connectWabaFor(businessId: string, phoneNumberId: string) {
    return withBusiness(db, businessId, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      }),
    );
  }

  it("routes a customer's message to the WABA's owner and onto the customer's own thread", async () => {
    const merchant = await seedMerchant('+2348030001111', 'Ada Fashion');
    await connectWabaFor(merchant.id, 'PN-ADA-1');

    const res = await post(
      messagePayload('2349097775555', 'wamid.CUST.1', 'do you have the bone straight?', 'PN-ADA-1'),
    );
    expect(res.statusCode).toBe(200);

    /* The job is the customer handler's, never the interpreter's. */
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubTransport.requests).toHaveLength(0);

    const expectedIndex = participantIndexFor(deps.config.matchKey, {
      businessId: merchant.id,
      channelAccountId: 'PN-ADA-1',
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: '+2349097775555',
    });
    const thread = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'CUSTOMER',
        businessId: merchant.id,
        channel: 'meta',
        channelAccountId: 'PN-ADA-1',
        participantBlindIndex: expectedIndex,
        participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      }),
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.body).toBe('do you have the bone straight?');

    /* The raw number never landed in the conversation index (F.3/F.4). */
    const raw = await withBusiness(db, merchant.id, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM conversations
        WHERE participant_blind_index LIKE '%2349097775555%'
      `),
    );
    expect([...raw][0]!.n).toBe(0);

    /* And the merchant's own Chat thread heard nothing. */
    const merchantThread = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'MERCHANT',
        businessId: merchant.id,
        channel: 'meta',
      }),
    );
    expect(merchantThread).toHaveLength(0);
  });

  it("a customer's message OPENS their 24-hour window (§24; PR-061)", async () => {
    const merchant = await seedMerchant('+2348030005555', 'Efe Fabrics');
    await connectWabaFor(merchant.id, 'PN-EFE-1');

    await post(messagePayload('2349097778888', 'wamid.WIN.1', 'good evening', 'PN-EFE-1'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Keyed by the SAME F.4-scoped blind index the thread routes by, and
     * expiring 24 hours out by its own clock. */
    const hash = participantIndexFor(deps.config.matchKey, {
      businessId: merchant.id,
      channelAccountId: 'PN-EFE-1',
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: '+2349097778888',
    });
    const open = await withBusiness(db, merchant.id, async (tx) => {
      const connection = await wabaRepo.wabaConnectionFor(tx, merchant.id);
      return wabaRepo.serviceWindowOpen(tx, {
        businessId: merchant.id,
        wabaConnectionId: connection!.id,
        customerHash: hash,
      });
    });
    expect(open).toBe(true);
  });

  it('an unknown phoneNumberId is refused, never guessed by the sender (§24, pinned)', async () => {
    /* The sender IS a merchant — the exact person a sender-based fallback
     * would misfile. Their customer-of-somebody message must not become
     * their own bookkeeping. */
    const merchant = await seedMerchant('+2348030002222', 'Bola Threads');

    const res = await post(
      messagePayload('2348030002222', 'wamid.UNROUTED.1', 'sold 3 wigs', 'PN-NOBODY'),
    );
    expect(res.statusCode).toBe(200);

    /* Stored, durably, attributed to nobody; no job to run. */
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(1);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
    const heard = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesFor(tx, merchant.id),
    );
    expect(heard).toHaveLength(0);
  });

  it('a revoked connection refuses like an unknown number', async () => {
    const merchant = await seedMerchant('+2348030003333', 'Chidi Stores');
    await connectWabaFor(merchant.id, 'PN-CHIDI-1');
    await withBusiness(db, merchant.id, async (tx) => {
      const connection = await wabaRepo.wabaConnectionFor(tx, merchant.id);
      await wabaRepo.markWabaStatus(tx, {
        businessId: merchant.id,
        connectionId: connection!.id,
        status: 'REVOKED',
      });
    });

    await post(messagePayload('2349097776666', 'wamid.REVOKED.1', 'hello', 'PN-CHIDI-1'));

    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(1);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('two customers on one WABA get two threads; the same customer returns to theirs', async () => {
    const merchant = await seedMerchant('+2348030004444', 'Ngozi Beauty');
    await connectWabaFor(merchant.id, 'PN-NGOZI-1');

    await post(
      messagePayload('2349091110001', 'wamid.TWO.1', 'price of the 22 inch?', 'PN-NGOZI-1'),
    );
    await post(messagePayload('2349091110002', 'wamid.TWO.2', 'is the shop open?', 'PN-NGOZI-1'));
    await post(messagePayload('2349091110001', 'wamid.TWO.3', 'and in brown?', 'PN-NGOZI-1'));
    const runner = buildRunner(workerDb, db, deps);
    while (await runner.runOnce()) {
      /* drain the queue */
    }

    const threads = await withBusiness(db, merchant.id, (tx) =>
      tx.execute<{ id: string; n: number }>(sql`
        SELECT c.id, count(m.id)::int AS n
        FROM conversations c LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        WHERE c.conversation_kind = 'CUSTOMER'
        GROUP BY c.id ORDER BY n DESC
      `),
    );
    const counts = [...threads].map((t) => t.n);
    expect(counts).toEqual([2, 1]);
  });
});

describe('tenant resolution', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('attributes a message to the sender business', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWNED'));

    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row?.businessId).toBe(business.id);
  });

  it('stores a stranger message unattributed rather than dropping it', async () => {
    // Someone messaging Rekoda who has no account is an ordinary event, and
    // the reply layer should be able to offer them a signup.
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row).toBeDefined();
    expect(row?.businessId).toBeNull();
  });

  it('refuses to guess when a user has more than one business', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Logistics',
      businessType: null,
      ownerUserId: user.id,
    });

    await post(messagePayload('2348031234567', 'wamid.AMBIGUOUS'));

    // Picking the first membership is a coin toss that could file a sale into
    // the wrong set of books. Unattributed, for a human to resolve.
    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row?.businessId).toBeNull();
  });
});

describe('what happens after the 200', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('queues the message for a worker rather than processing it inline', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'inbound.message', state: 'pending' });
  });

  it('runs that job and closes the event out', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    // The registry the deploy uses, not a test-local one.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // `unprocessedEvents` is the backlog. Empty means the loop closed.
    expect(await events.unprocessedEvents(workerDb, 'meta')).toHaveLength(0);
    const [job] = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(job).toMatchObject({ state: 'done' });
  });

  it('queues nothing for a stranger — there is no tenant to run as', async () => {
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    // `jobs.business_id` is NOT NULL, so "run this for nobody" is not
    // expressible. The event is still stored for the reply layer.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues nothing for a delivery receipt — there is nothing to understand', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(statusPayload('2348031234567', 'wamid.SENT', 'delivered'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues ONE job when Meta delivers the same message eight times', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await Promise.all(
      Array.from({ length: 8 }, () => post(messagePayload('2348031234567', 'wamid.RETRIED'))),
    );

    // Two independent guards have to hold at once here: the unique index on
    // (provider, external_id), and the singleton key on the job. Recording a
    // sale twice is the failure this whole path exists to prevent.
    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
  });
});

describe('nothing raw is stored', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('seals the webhook payload — the message text never lands in plaintext', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(
      messagePayload('2348031234567', 'wamid.SEALED', 'Ada 08039998888 bought 3 wigs for 150k'),
    );

    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    const stored = JSON.stringify(row?.payload);

    /**
     * Storing a Meta body verbatim put the merchant's message AND the
     * sender's number in plaintext — while the table's own comment claimed
     * PII was redacted at write time. The seal is what makes that true. It is
     * not a substitute for the tenant policy 0130 added, nor made redundant
     * by it: the worker reads this table across every tenant by design.
     */
    expect(stored).not.toContain('bought 3 wigs');
    expect(stored).not.toContain('08039998888');
    expect(stored).not.toContain('2348031234567');
    expect(stored).toContain('sealed');
  });

  it('records a DETERMINISTIC message as its classification, not its words', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes please'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Inbound plus the reply it earned. The inbound one is what this asserts.
    expect(messages[0]).toMatchObject({ direction: 'inbound', body: '[affirm]' });

    // And the gateway never ran: no customer, no vault write, nothing left.
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.select().from(schema.customers),
    );
    expect(customers).toHaveLength(0);
  });

  it('records everything else TOKENISED', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.SALE', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const [message] = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(message!.body).not.toContain('08039998888');
    expect(message!.body).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
    // The goods and the count survive — they are the whole point of the message.
    expect(message!.body).toContain('3 wigs');
  });

  it('writes one conversation row when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'yes'));

    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    // A reclaimed lock or a re-enqueued job must not double the history.
    await withBusiness(db, business.id, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId: business.id,
        channel: 'meta',
        kind: 'text',
        body: '[affirm]',
        providerMessageId: 'wamid.ONCE',
      }),
    );

    const inbound = (
      await withBusiness(db, business.id, (tx) => conversationsRepo.messagesFor(tx, business.id))
    ).filter((m) => m.direction === 'inbound');
    expect(inbound).toHaveLength(1);
  });
});

describe('what the model understood', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('stores a draft for a message only the model could read', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DRAFT', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ intent: 'Unclear', state: 'pending' });
    // The command holds tokens, because tokens are all the model ever saw.
    expect(JSON.stringify(drafts[0]!.command)).not.toContain('08039998888');
  });

  it('does NOT call a model for a message the router already answered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.CHEAP', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // No request, no draft, no usage row, no naira spent.
    expect(stubTransport.requests).toHaveLength(0);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(0);
    // Scoped to anthropic: the outbound reply writes its own usage row, and
    // "no AI spend" is a different claim from "no cost at all".
    const spend = await withBusiness(db, business.id, (tx) =>
      quotaRepo.usageTotals(tx, 'anthropic'),
    );
    expect(spend.calls).toBe(0);
  });

  it('does not pay twice for one sentence when the job runs again', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'Ada bought 3 wigs'));

    // Captured before the run, because running it marks the event handled.
    const [event] = await events.unprocessedEvents(workerDb, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    /* TWO calls for one sentence is the escalation working, not a double
     * charge: the suite's default reply is Unclear, which buys one bounded
     * retry on the escalation model. The claim under test is that a RERUN
     * adds nothing to either. */
    expect(stubTransport.requests).toHaveLength(2);

    /**
     * Exactly what a reclaimed lock produces: the same event, queued again.
     * `recordInbound` reports `isNew: false` the second time, which is what
     * stops the model being paid for a sentence it has already read.
     */
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    expect(stubTransport.requests).toHaveLength(2);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
  });
});

describe('answering the merchant', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('answers a greeting without a model, a vault write, or a naira', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.HI', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.sent).toHaveLength(1);
    expect(stubSender.lastText).toMatch(/I keep your books/i);
    expect(stubTransport.requests).toHaveLength(0);

    // The reply is on record too, so an undelivered one is findable.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('tells a merchant plainly when there is nothing to say yes to', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Before the gates landed this was silence, because "yes" answers a
     * question and there was none to answer. Now that a draft can exist, a
     * "yes" with none pending is a real state worth naming — and the reply
     * says what WOULD produce something to confirm.
     */
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes/i);
    expect(stubSender.lastText).toMatch(/tell me a sale/i);
  });

  it('answers the debtor question from rows, never an invented figure', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWES', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // A book with no invoices has exactly one honest answer, and it carries
    // no figure at all. A bookkeeping assistant that makes up a debtor list
    // has destroyed the only thing it sells.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('passes the model`s clarifying question through as written', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ASK', 'Ada bought wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toBe('How many wigs?');
  });

  it('answers once when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.TWICE', 'good morning'));

    const [event] = await events.unprocessedEvents(workerDb, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);

    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    // One reply per retry is how a bug becomes a nuisance the merchant feels.
    expect(stubSender.sent).toHaveLength(1);
  });

  it('keeps the record when the reply cannot be delivered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DOWN', 'good morning'));
    stubSender.failWith();

    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Failing the job over an undelivered reply would roll the merchant's
     * message back and re-read it from scratch on the retry — paying for the
     * model twice to fix a delivery problem.
     */
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages).toHaveLength(2);
    // No provider id: a reply we owed and did not deliver, and findable as one.
    expect(messages[1]).toMatchObject({ direction: 'outbound', providerMessageId: null });
  });
});

describe("the plan's own example, end to end", () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  const THE_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  /**
   * Post a message and DRAIN the queue, which is what a real worker does.
   *
   * A single `runOnce()` was enough until issuing began enqueuing a render
   * job: the runner takes the oldest due job, so the render would be claimed
   * ahead of the next inbound message and the conversation would silently stop
   * advancing. The test failed in exactly that way, which is the right way for
   * it to fail.
   */
  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  it('turns a WhatsApp message into a confirmed, balanced, numbered record', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);

    // 1. The sale. CG2: previewed, not saved.
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    expect(stubSender.lastText).toContain('Please check this before I save it');
    expect(stubSender.lastText).toContain('Total: ₦150,000');
    expect(stubSender.lastText).toContain('Balance: ₦50,000');

    // Nothing issued yet — that is the entire point of the gate.
    expect(await invoiceCount(business.id)).toBe(0);

    // 2. The yes. CG3 claims the draft and the engine issues.
    await send('yes', 'wamid.YES');
    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    expect(stubSender.lastText).toContain('₦50,000 still owed');

    expect(await invoiceCount(business.id)).toBe(1);

    // 3. The books balance, read back out of the database.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(15_000_000);
  });

  /**
   * The same yes, with the RecordSale rollout flag ON (PR-021): the identical
   * record comes out, because the flag changes which gates run around the
   * work and never the work. What the bus adds is visible in the database —
   * the idempotency claim it took for the draft, snapshot completed in the
   * same transaction as the sale it answers for.
   */
  it('the RecordSale flag routes the same yes through the command bus', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);

    const flagged = { ...deps, config: { ...deps.config, commandRecordSale: true } };
    async function sendFlagged(text: string, wamid: string) {
      await post(messagePayload('2348031234567', wamid, text));
      const runner = buildRunner(workerDb, db, flagged);
      let worked = await runner.runOnce();
      expect(worked).toBe(true);
      while (worked) worked = await runner.runOnce();
    }

    await sendFlagged('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await sendFlagged('yes', 'wamid.YES');

    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    // The bus path names the receipt too (G-48), from the run's own result.
    expect(stubSender.lastText).toContain('Receipt RCT-2026-000001 is on its way.');
    expect(await invoiceCount(business.id)).toBe(1);

    const claims = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ key: string; command_name: string; response_snapshot: unknown }>(
        sql`SELECT key, command_name, response_snapshot FROM idempotency_records
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const claim = [...claims][0];
    expect([...claims]).toHaveLength(1);
    expect(claim?.command_name).toBe('RecordSale');
    expect(claim?.key).toMatch(/^draft:/);
    expect(claim?.response_snapshot).toMatchObject({
      invoiceNumber: 'INV-2026-000001',
      receiptNumber: 'RCT-2026-000001',
    });
  });

  it('renders and stores the PDF, and it opens', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // Issuing enqueues the render inside the same transaction, so draining the
    // queue after the confirmation is all it takes. Money was taken with the
    // sale (₦100,000 of ₦150,000), so the paper is its RECEIPT (G-48, journey
    // C5) — one document, not the invoice as well.
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'receipt_pdf', refNumber: 'RCT-2026-000001' });

    // The key is unguessable — a sequential one would let anyone holding one
    // document's URL walk the merchant's whole sales history by counting.
    expect(stored[0]!.storageKey).toMatch(
      new RegExp(`^documents/${business.id}/receipt_pdf/[0-9a-f]{32}\\.pdf$`),
    );

    // And the bytes are really there, and really a PDF.
    const bytes = await deps.storage.get(stored[0]!.storageKey);
    expect(bytes).not.toBeNull();
    expect(bytes!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes!.length).toBe(stored[0]!.bytes);
  });

  it('DELIVERS the document to the merchant', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    /**
     * The M2 exit criterion, end to end: a message became a confirmed record
     * and the merchant received the paper for it.
     */
    expect(stubSender.documents).toHaveLength(1);
    const sent = stubSender.lastDocument!;

    // Named so a merchant can find it again in three weeks, not by a uuid.
    // Money was taken with the sale, so it is the receipt (G-48, journey C5).
    expect(sent.filename).toBe('RCT-2026-000001.pdf');
    expect(sent.contentType).toBe('application/pdf');
    expect(sent.to).toBe('+2348031234567');
    // The merchant-recorded caption, naming the invoice it was paid against.
    // Never "confirmed": nobody verified this money with a provider (ADR 0014).
    expect(sent.caption).toBe(
      'Receipt RCT-2026-000001 for ₦100,000 on INV-2026-000001 is attached. ' +
        'Forward it to your customer.',
    );
    expect(sent.caption).not.toMatch(/confirm|verif/i);

    // The real bytes, not a link — a link would need the PDF to be publicly
    // reachable, which is what the unguessable key exists to avoid.
    expect(sent.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // And the merchant's history shows what they actually received.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.some((m) => m.kind === 'media' && m.direction === 'outbound')).toBe(true);
  });

  it('a sale on credit still delivers its INVOICE, and no receipt exists', async () => {
    // Journey C6: nothing was paid, so the invoice is the merchant's paper.
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({ ...THE_SALE, reportedPayment: null });
    await send('Ada bought 3 wigs for 150k, she will pay later', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    expect(stubSender.lastText).not.toContain('Receipt');
    expect(stubSender.documents).toHaveLength(1);
    expect(stubSender.lastDocument!.filename).toBe('INV-2026-000001.pdf');
    const receipts = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM receipts WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...receipts][0]?.n).toBe(0);
  });

  it('the yes for a paid sale names the receipt that follows', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    // One job: the reply is sent before the render is drained.
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);

    expect(stubSender.lastText).toBe(
      'Saved ✅ INV-2026-000001 for ₦150,000.\n₦50,000 still owed.\n' +
        'Receipt RCT-2026-000001 is on its way.',
    );
  });

  it('retries delivery rather than losing the document', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // Meta is down at the moment the document is ready. Targeted at documents
    // specifically: a one-shot failure would be consumed by the text reply
    // that precedes it, and the delivery would then succeed.
    stubSender.failDocumentsWith();
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubSender.documents).toHaveLength(0);

    /**
     * A failed reply is swallowed; a failed DELIVERY is not. The reply is a
     * sentence the merchant misses — the document is the thing they asked for,
     * and the PDF already exists in storage, so a retry is cheap and is the
     * only way they ever get it.
     */
    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued[0]).toMatchObject({ state: 'pending', attempts: 1 });

    // The invoice and its PDF survived the delivery failure untouched.
    expect(await invoiceCount(business.id)).toBe(1);
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not render two PDFs for one sale', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // A second yes finds nothing pending (CG3), so nothing is issued and no
    // second render is enqueued. Two PDFs with two storage keys for one sale
    // is a document a customer could be shown twice at different URLs.
    await send('yes', 'wamid.YES2');

    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not issue TWICE when the merchant taps yes twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('yes', 'wamid.YES1');
    await send('yes', 'wamid.YES2');

    // CG3. On WhatsApp a double-tap is not an edge case, it is Tuesday.
    expect(await invoiceCount(business.id)).toBe(1);
    // And the second yes is told the truth rather than apologised to.
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes|already saving/i);
  });

  it('questions an arithmetic mismatch instead of previewing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({ ...THE_SALE, statedTotal: 120_000, reportedPayment: null });

    await send('Ada bought 3 wigs, total 120k', 'wamid.ODD');

    // CG1 before CG2: a preview of numbers we know are wrong is a request to
    // approve a mistake.
    expect(stubSender.lastText).toContain('do not add up');
    expect(stubSender.lastText).toContain('₦30,000');
    expect(stubSender.lastText).not.toContain('Please check this before I save it');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('lets a correction replace the draft before anything is issued', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // CG5 — "no, 4 not 3" re-runs the draft rather than mutating anything.
    stubTransport.replyWith({
      ...THE_SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    await send('no, 4 not 3', 'wamid.FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain('Total: ₦200,000');

    await send('yes', 'wamid.YES');

    // One invoice, for the CORRECTED figure. Confirming the superseded draft
    // would be the failure CG5 exists to prevent.
    expect(await invoiceCount(business.id)).toBe(1);
    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(rows.map((r) => r.state).sort()).toEqual(['confirmed', 'superseded']);
  });

  it('discards the draft when the merchant says no', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('no', 'wamid.NO');
    expect(stubSender.lastText).toMatch(/cancelled/i);

    // A discarded draft must not be confirmable by an accidental yes later.
    await send('yes', 'wamid.LATE');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('closes an exhausted month with a doorway, not a wall (metering-v1 §3)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const allowance = PLAN_ALLOWANCES.trial.AI_ACTIONS;
    // The whole trial allowance, spent the atomic way fifty messages would.
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'AI_ACTIONS',
        allowance,
        allowance,
      ),
    );

    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.EXHAUSTED');

    // Three things, exactly: what ran out, nothing lost, two doors forward.
    expect(stubSender.lastText).toContain(`used all ${allowance} messages`);
    expect(stubSender.lastText).toContain('who owes me');
    expect(stubSender.lastText).toContain('upgrade');
    // And the model was never paid for a refused message.
    expect(stubTransport.requests).toHaveLength(0);

    // Reading stays free FOREVER at zero units — the router tier is not metered.
    await send('help', 'wamid.STILLFREE');
    expect(stubSender.lastText).toContain('Record a sale');
  });

  it('refunds the unit when Rekoda failed, not the merchant (metering-v1)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    // A reply the border checkpoint rejects: the model ran, Rekoda paid,
    // the merchant got nothing. Their meter must not move.
    stubTransport.replyWith({ intent: 'SomethingUnparseable' });
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.UNUSABLE');
    expect(stubSender.lastText).toContain('could not turn that into a record');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows[0]?.used ?? 0).toBe(0);
  });

  it('records an EXPENSE the same way: previewed, confirmed, balanced', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel for generator',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });

    // CG2: previewed, nothing in the books yet.
    await send('bought fuel for the gen, 12k', 'wamid.EXP');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    expect(stubSender.lastText).toContain('*Amount: ₦12,000*');
    expect(
      await withBusiness(db, business.id, (tx) => spendRepo.expensesFor(tx, business.id)),
    ).toHaveLength(0);

    // The yes. Row + posting land together; the reply claims books, not paper.
    await send('yes', 'wamid.EXPYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦12,000 expense: fuel for generator');

    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows).toHaveLength(1);
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'EXPENSES', debitK: 1_200_000 }),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    expect(debits).toBe(entries.reduce((n, e) => n + e.creditK, 0));
  });

  it('records a stock purchase on credit and says what is still owed', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'Mama Nkechi',
      description: 'ankara fabric',
      amount: 50_000,
      reportedPayment: 20_000,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
    });

    await send('bought ankara from Mama Nkechi 50k, paid 20k', 'wamid.PUR');
    expect(stubSender.lastText).toContain('Owing to supplier: ₦30,000');

    await send('yes', 'wamid.PURYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦50,000 stock purchase');
    expect(stubSender.lastText).toContain('₦30,000 still owed to your supplier');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'ACCOUNTS_PAYABLE', creditK: 3_000_000 }),
    );

    /* The supplier's NAME still stops at the preview — what the books keep
     * is a VAULT reference (migration 0050): the expense row points at a
     * supplier whose name exists only as a cipher. */
    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows[0]?.description).toBe('ankara fabric');
    expect(JSON.stringify(rows)).not.toContain('Nkechi');
    const supplierId = rows[0]?.supplierId;
    expect(supplierId).toBeTruthy();

    const ciphers = await withBusiness(db, business.id, (tx) =>
      suppliersRepo.supplierCiphersFor(tx, business.id, [supplierId!]),
    );
    const cipher = ciphers.get(supplierId!);
    expect(cipher).toBeTruthy();
    /* At rest it is a blob; only the vault key opens it. */
    expect(cipher).not.toContain('Nkechi');
    expect(decryptFacet(cipher!, deps.config.vaultKey, `${business.id}:supplier_name`)).toBe(
      'Mama Nkechi',
    );

    /* The same supplier, said sloppily, folds to the same row. */
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'MAMA   nkechi',
      description: 'more ankara',
      amount: 10_000,
      reportedPayment: 10_000,
      paymentMethod: 'cash',
      productMention: null,
      quantity: null,
    });
    await send('bought more ankara from MAMA nkechi 10k paid', 'wamid.PUR2');
    await send('yes', 'wamid.PUR2YES');
    const after = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.supplierId)).size).toBe(1);
  });
});

describe('collecting money from chat (payments-v1 §160)', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  async function activeConnection(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
    });
  }

  /** An open ₦80,000 invoice for a customer whose email is on file. */
  async function openInvoiceWithEmail(businessId: string, config: ApiConfig) {
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
      {
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey, `${businessId}:email`),
        matchKey: null,
      },
    ]);
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-pay',
        actor: 'system',
      }),
    );
  }

  it('who owes me answers from the ledger: numbers, totals, no names', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('who owes me', 'wamid.OWES');
    expect(stubSender.lastText).toContain('One invoice is unpaid: ₦80,000 owed to you');
    expect(stubSender.lastText).toMatch(/INV-\d{4}-000001: ₦80,000/);
    expect(stubSender.lastText).not.toContain('CUSTOMER_X81');
  });

  it('payment details with an active connection returns a forwardable link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    await send('send payment link', 'wamid.PAY1');
    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001: ₦80,000 outstanding/);
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details without a connection links the configured Payments page', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('payment details', 'wamid.PAY2');
    expect(stubSender.lastText).toContain('add your settlement account');
    /* REKODA_WEB_URL, through config.webUrl: the only link in the reply, and
     * the last thing in it. */
    expect((stubSender.lastText ?? '').match(/\S+:\/\/\S+/g)).toEqual([
      'https://books.example.test/app/payments',
    ]);
    expect(stubSender.lastText).toMatch(/\nhttps:\/\/books\.example\.test\/app\/payments$/);
    // No bare domain beside the link either.
    expect(
      (stubSender.lastText ?? '').replace('https://books.example.test/app/payments', ''),
    ).not.toMatch(/www\.|[a-z0-9-]\.[a-z]{2,}/i);
  });

  it('payment details without a connection or a web URL names no link at all', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await post(messagePayload('2348031234567', 'wamid.PAY2N', 'payment details'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();

    expect(stubSender.lastText).toContain('open your Rekoda dashboard and go to Payments');
    // No scheme, no www, and no bare `name.tld` a phone would still link.
    expect(stubSender.lastText).not.toMatch(/:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}/i);
  });

  it('a provider outage degrades to an honest sentence, and the next try works', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    intentsProvider.failNextInitializeWith(new Error('Paystack is down'));
    await send('payment details', 'wamid.PAYDOWN');
    expect(stubSender.lastText).toContain('could not reach your payment provider');
    expect(stubSender.lastText).not.toContain('http');

    // The job completed rather than dying in retries, so the next ask succeeds.
    await send('payment details', 'wamid.PAYUP');
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details with nothing owed says so', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await send('payment details', 'wamid.PAY3');
    expect(stubSender.lastText).toContain('nothing to collect');
  });
});

describe('acknowledging things we cannot use', () => {
  it('answers 200 to a payload whose shape we do not recognise', async () => {
    // Meta retries anything else, escalating until it disables the webhook.
    const res = await post({ object: 'whatsapp_business_account', entry: 'not-an-array' });
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('answers 200 to an empty envelope', async () => {
    expect((await post({ entry: [] })).statusCode).toBe(200);
  });
});

describe('records, resend and messages Rekoda cannot read', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  function audioPayload(waId: string, wamid: string) {
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
                messages: [{ id: wamid, from: waId, timestamp: '1700000000', type: 'audio' }],
              },
            },
          ],
        },
      ],
    };
  }

  it('answers "records" with real month figures and no model call', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await withBusiness(db, business.id, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: business.id,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd-rec',
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.REC', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Your books this month');
    expect(stubSender.lastText).toContain('Money out ₦12,000');
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('says the books are empty rather than reciting four zeros', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.REC0', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Nothing in your books yet this month');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('"resend" queues the newest document back through delivery, exactly once', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/unguessable-1',
        refNumber: 'INV-2026-000007',
        bytes: 1234,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESEND', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Sending INV-2026-000007 again');

    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued).toHaveLength(1);
    expect(doc.id).toBeTruthy();
  });

  it('"resend" with nothing ever issued is an honest miss', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.RESEND0', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('no document to resend yet');
  });

  /**
   * An audio message with NO media id: nothing to fetch, so nothing to
   * transcribe. Voice notes that carry one take the transcription path (see
   * the "a voice note" suite); this is the malformed remainder, and it still
   * must never become a paid model call on silence.
   */
  it('a voice note with nothing to fetch gets an honest sentence', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(audioPayload('2348031234567', 'wamid.VOICE'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('listen to voice notes');
    // The whole point: silence never becomes a paid interpretation call.
    expect(stubTransport.requests).toHaveLength(0);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Recorded as what it was, not as empty text.
    expect(messages[0]?.body).toBe('[audio message]');
  });
});

describe('consent (STOP/START) and erasure, as facts not sentences', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('STOP persists, suppresses proactive deliveries, and START undoes it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');

    await post(messagePayload('2348031234567', 'wamid.STOP1', 'stop'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('I will not message you again');
    expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();

    // A receipt delivery — the proactive send class — goes nowhere now.
    await deps.storage.put('test/suppressed-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'receipt_pdf',
        storageKey: 'test/suppressed-1',
        refNumber: 'RCT-2026-000009',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);

    // START clears the flag; the same delivery class flows again.
    await post(messagePayload('2348031234567', 'wamid.START1', 'start'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
  });

  it.each(['abeg stop', 'no send me again', 'stop o'])(
    'a natural %j persists, suppresses proactive deliveries, and START undoes it (G-80)',
    async (text) => {
      const business = await seedMerchant('+2348031234567', 'Ada Fashion');

      await post(messagePayload('2348031234567', 'wamid.G80-STOP1', text));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(0);

      // A receipt delivery, the proactive send class, goes nowhere now.
      await deps.storage.put('test/g80-suppressed', Buffer.from('%PDF-fake'), 'application/pdf');
      const doc = await withBusiness(db, business.id, (tx) =>
        issueRepo.recordDocument(tx, {
          businessId: business.id,
          kind: 'receipt_pdf',
          storageKey: 'test/g80-suppressed',
          refNumber: 'RCT-2026-000010',
          bytes: 9,
        }),
      );
      await withBusiness(db, business.id, (tx) =>
        jobsRepo.enqueue(tx, {
          businessId: business.id,
          kind: 'document.deliver',
          payload: { documentId: doc.id },
          singletonKey: `deliver:${doc.id}`,
        }),
      );
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.documents).toHaveLength(0);

      // Saying it again changes nothing and still answers the same way.
      await post(messagePayload('2348031234567', 'wamid.G80-STOP2', text));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();

      // START undoes it ("abeg start" does not; see the G-80 START test).
      await post(messagePayload('2348031234567', 'wamid.G80-START', 'START'));
      expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
      expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
    },
  );

  it('an explicit resend still delivers to an opted-out merchant — they asked', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await identity.setOptOut(db, '+2348031234567', new Date());

    await deps.storage.put('test/resend-1', Buffer.from('%PDF-fake'), 'application/pdf');
    await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/resend-1',
        refNumber: 'INV-2026-000011',
        bytes: 9,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESENDOPT', 'resend'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true); // the inbound command
    expect(await runner.runOnce()).toBe(true); // the delivery it queued
    expect(stubSender.documents).toHaveLength(1);
    expect(stubSender.lastDocument?.filename).toBe('INV-2026-000011.pdf');
  });

  it('erasure takes two exact asks, deletes every identity facet, and says how many', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T1',
      [
        { facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name' },
        { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone' },
      ],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL1', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await post(messagePayload('2348031234567', 'wamid.DEL2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('deleted (2 records)');
    /* The rest is on the deployment's own data deletion page: REKODA_WEB_URL,
     * through config.webUrl, the only link and the last thing in the reply. */
    expect((stubSender.lastText ?? '').match(/\S+:\/\/\S+/g)).toEqual([
      'https://books.example.test/data-deletion',
    ]);
    expect(stubSender.lastText).toMatch(/\nhttps:\/\/books\.example\.test\/data-deletion$/);
    // No bare domain beside the link either.
    expect(
      (stubSender.lastText ?? '').replace('https://books.example.test/data-deletion', ''),
    ).not.toMatch(/www\.|[a-z0-9-]\.[a-z]{2,}/i);

    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toEqual([]);
  });

  it('erasure with no web URL still deletes, and names no link at all', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T2',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone-2' }],
    );
    const noWeb = { ...deps, config: { ...deps.config, webUrl: null } };

    await post(messagePayload('2348031234567', 'wamid.DELN1', 'delete my data'));
    expect(await buildRunner(workerDb, db, noWeb).runOnce()).toBe(true);
    await post(messagePayload('2348031234567', 'wamid.DELN2', 'delete my data'));
    expect(await buildRunner(workerDb, db, noWeb).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('deleted (1 record)');
    expect(stubSender.lastText).toContain('Your conversations and account can be deleted too');
    // No scheme, no www, and no bare `name.tld` a phone would still link.
    expect(stubSender.lastText).not.toMatch(/:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}/i);
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toEqual([]);
  });

  /**
   * The same two asks with the EraseData flag ON (PR-027): identical
   * deletion, and the Appendix D machinery underneath — the first ask opened
   * a pending confirmation recording the consequence, the second claimed it
   * through the command bus.
   */
  it('erasure opens a confirmation the second ask claims, with no flag to turn it off', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_T9', [
      { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone-9' },
    ]);
    /* No flag. EraseData is HIGH_RISK, so the confirmation record is part of
     * the command and not of a rollout: this runs the default deps every
     * deployment uses. */
    await post(messagePayload('2348031234567', 'wamid.DELF1', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await post(messagePayload('2348031234567', 'wamid.DELF2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('deleted (1 record)');

    const confirmations = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: string; claimed_at: Date | null }>(
        sql`SELECT command, claimed_at FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...confirmations]).toHaveLength(1);
    expect([...confirmations][0]?.command).toBe('EraseData');
    expect([...confirmations][0]?.claimed_at).not.toBeNull();
  });

  /**
   * Owner only. This deletes every customer's contact details for the whole
   * business in one irreversible statement, which is not a thing an
   * accountant or a delegate should be able to do from a phone.
   */
  it('refuses erasure from a member who is not the owner', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name-9' }],
    );

    await post(messagePayload('2348039990001', 'wamid.DELX', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Only the business owner can delete');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);
  });

  /**
   * Asking to erase clears whatever was waiting for a yes, and the merchant
   * has to be told: a sale they previewed a minute ago silently vanishing is
   * how a shop ends up with a day's takings unrecorded.
   */
  it('says so when the erasure ask discards an entry waiting for a yes', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');

    stubTransport.replyWith({
      intent: 'RecordSale',
      customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
      statedTotal: 150_000,
      reportedPayment: 0,
      paymentMethod: 'transfer',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });
    await post(messagePayload('2348031234567', 'wamid.DELD1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DELD2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('waiting for your yes has been dropped');
  });

  it('a "yes" after the erasure prompt keeps everything — only the phrase confirms', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T2',
      [{ facet: 'name', ciphertext: 'sealed', matchKey: 'mk' }],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL3', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(messagePayload('2348031234567', 'wamid.DELYES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Kept');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);

    // And the claimed draft cannot be resurrected: a fresh ask starts over.
    await post(messagePayload('2348031234567', 'wamid.DEL4', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
  });
});

describe('the trial clock and the upgrade door', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  /** Age the trial past its date, as thirty days would. */
  async function expireTrial(businessId: string) {
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });
  }

  it('tells an expired trial the truth, and spends no model call doing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('30-day free trial has ended');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // The gate runs before the model: an expired trial costs nothing.
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('still answers the free read commands after the trial ends', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP2', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // Reading is never gated — the books stay theirs.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
  });

  it('records an upgrade request from chat and answers a human, not a dead link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.UPG1', 'upgrade'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('upgrade request');
    expect(stubSender.lastText).not.toContain('rekoda.app/pricing');

    const requests = await withBusiness(db, business.id, (tx) =>
      billingRepo.upgradeRequestsFor(tx, business.id),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fromPlan).toBe('expired');
  });

  it('recording works again the moment an operator moves them onto a plan', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 31 * 86_400_000),
      actor: 'operator:test',
    });

    await post(messagePayload('2348031234567', 'wamid.AFTER', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // Back to the ordinary path: the model ran and a preview came back.
    expect(stubTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).not.toContain('trial has ended');
  });
});

describe('metering the things that cost money', () => {
  /** A sale the stub will hand back, so the confirm path is reached. */
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  it('spends a documents unit per invoice, and refuses between transactions when they run out', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });

    // Burn the trial's 25 documents, leaving the allowance exactly spent.
    const period = usagePeriod(new Date());
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(tx, business.id, period, 'DOCUMENT_GENERATION', 25, 25),
    );

    stubTransport.replyWith(A_SALE);
    await post(messagePayload('2348031234567', 'wamid.DOC1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // The preview still happens: the message unit paid for reading it.
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DOC2', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('invoices and receipts');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // Nothing was booked: the refusal happened BEFORE the sale, so the
    // merchant lost neither the sale nor the draft.
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('records the Meta media cost when a document is delivered', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });

    await deps.storage.put('test/cost-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/cost-1',
        refNumber: 'INV-2026-000021',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(1);

    /* Media is chargeable from 1 October 2026. The row has to exist NOW or
     * the repricing arrives with no baseline for the expensive class. */
    const totals = await withBusiness(db, business.id, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(totals.calls).toBeGreaterThanOrEqual(1);
  });
});

/**
 * When the merchant says the money is expected, and what that turns into.
 *
 * The model has always captured the phrase and nothing ever read it: a
 * merchant told us their customer would pay on Friday and we threw it away,
 * which is the whole debtors book discarded at the door.
 */
describe('due dates from what the merchant said', () => {
  const A_SALE_DUE = (dueDescription: string | null) => ({
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function sell(wamid: string, dueDescription: string | null) {
    stubTransport.replyWith(A_SALE_DUE(dueDescription));
    await post(messagePayload('2348031234567', `${wamid}-sale`, 'Ada bought 3 wigs for 150k'));
    await drain();
    await post(messagePayload('2348031234567', `${wamid}-yes`, 'yes'));
    await drain();
  }

  it('turns a spoken day into a date on the invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE1', 'she will pay on Friday');

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeInstanceOf(Date);
  });

  /* Null is the honest answer and the common one. A guessed date puts a real
   * customer on an overdue list for a deadline nobody agreed. */
  it('leaves the date empty when nobody named one', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE2', null);

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeNull();
  });

  it('leaves the date empty for a phrase that names no day', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE3', 'when she can');

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeNull();
  });

  it('ages the debt into the right bucket once the day has passed', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE4', 'in 7 days');

    /* Read from far enough ahead that the promised day is long gone. The
     * ageing query takes `now`, so this needs no clock trickery. */
    const inFortyDays = new Date(Date.now() + 40 * 86_400_000);
    const ageing = await withBusiness(db, business.id, (tx) =>
      reportsRepo.ageingFor(tx, business.id, inFortyDays),
    );
    expect(ageing.d31_60K).toBe(15_000_000);
    expect(ageing.currentK).toBe(0);
    expect(ageing.overdueK).toBe(15_000_000);
  });

  it('tells the merchant in chat how late each debt is', async () => {
    const business = await seedMerchant('+2348031234567');
    /* Issued directly with a day already gone. The resolver deliberately
     * cannot produce a past due date from a phrase — "she will pay
     * yesterday" is not a thing anybody says — so the overdue state is
     * seeded rather than spoken. */
    await withBusiness(db, business.id, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: business.id,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-late',
        actor: 'system',
        dueDate: new Date(Date.now() - 5 * 86_400_000),
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.DUE5-ask', 'who owes me'));
    await drain();

    /* A debtors list is a work queue. Invoice numbers, never customer names:
     * this text crosses WhatsApp in the clear. */
    expect(stubSender.lastText).toMatch(/day(s)? late/);
    expect(stubSender.lastText).toContain('past the day it was promised');
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
  });

  it('says nothing about lateness when nothing is late', async () => {
    await seedMerchant('+2348031234567');
    await sell('wamid.DUE6', 'next month');

    await post(messagePayload('2348031234567', 'wamid.DUE6-ask', 'who owes me'));
    await drain();

    expect(stubSender.lastText).not.toContain('late');
    expect(stubSender.lastText).not.toContain('past the day it was promised');
  });
});

/**
 * The reminder a merchant forwards to the person who owes them.
 *
 * Two messages: ours to them, then theirs to forward. The second is written
 * to be read by a customer, so what it must NOT contain is as much of the
 * assertion as what it must.
 */
describe('chasing an overdue invoice', () => {
  async function seedMerchant(phone: string, name = 'Ada Fashion') {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name,
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /** An unpaid invoice, `daysLate` past the day it was promised. */
  async function overdueInvoice(businessId: string, daysLate: number, totalK = 15_000_000) {
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: totalK / 3 }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK: 0,
        balanceDueK: totalK,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: `draft-chase-${daysLate}`,
        actor: 'system',
        dueDate: new Date(Date.now() - daysLate * 86_400_000),
      }),
    );
  }

  it('hands over a forwardable reminder, as its own message', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 5);

    await post(messagePayload('2348031234567', 'wamid.CHASE1', `remind ${sale.invoiceNumber}`));
    await drain();

    /* Two messages: the forwardable one, then the instruction above it. The
     * merchant reads the instruction last and forwards what is under their
     * thumb. */
    const sent = stubSender.sent.map((m) => m.text);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain(sale.invoiceNumber);
    expect(sent[0]).toContain('₦150,000');
    expect(sent[0]).toContain('5 days overdue');
    expect(sent[1]).toContain('Forward the next message');
  });

  /**
   * The forwardable message is read by a CUSTOMER. It must not announce that
   * a robot wrote it, and it must not carry a token or anybody's name.
   */
  it('writes the reminder for the customer, not for the merchant', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 3);

    await post(messagePayload('2348031234567', 'wamid.CHASE2', `remind ${sale.invoiceNumber}`));
    await drain();

    const forwardable = stubSender.sent[0]!.text;
    expect(forwardable).toContain('Ada Fashion');
    expect(forwardable).not.toContain('CUSTOMER_');
    expect(forwardable).not.toContain('Rekoda');
    // Somebody who has already paid should not be accused of anything.
    expect(forwardable).toContain('If you have already sent it');
  });

  it('says there is nothing to chase on a settled invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 10);
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: sale.invoiceId,
        amountK: 15_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'settled',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.CHASE3', `remind ${sale.invoiceNumber}`));
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
  });

  it('says the same for an invoice that never existed', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.CHASE4', 'remind INV-2026-999999'));
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
  });

  /**
   * Tenant isolation on a command that names a document by number. Another
   * merchant's invoice number is not a secret, so the answer has to be the
   * same as for one that does not exist.
   */
  it('will not chase another business invoice', async () => {
    const ada = await seedMerchant('+2348031234567', 'Ada Fashion');
    const chidi = await seedMerchant('+2348039990002', 'Chidi Electronics');
    const chidiSale = await overdueInvoice(chidi.id, 8);
    expect(ada.id).not.toBe(chidi.id);

    await post(
      messagePayload('2348031234567', 'wamid.CHASE5', `remind ${chidiSale.invoiceNumber}`),
    );
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
    expect(stubSender.sent.every((m) => !m.text.includes('Chidi'))).toBe(true);
  });
});

/**
 * A voice note, end to end (ADR 0032).
 *
 * The claim that matters most here is a NEGATIVE one: the audio is fetched,
 * handed to the ONE configured transcriber, and dropped. "Rekoda does not
 * keep the audio" is a promise made out loud on the privacy page, and the
 * only way it stays true is if there is nowhere for the audio to persist.
 */
describe('a voice note', () => {
  const A_SPOKEN_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  function voicePayload(waId: string, wamid: string, mediaId = 'media-1') {
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
                    type: 'audio',
                    audio: { id: mediaId, mime_type: 'audio/ogg', voice: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /**
   * Audio the provider will hand back for `media-1`, of a REAL length.
   *
   * A single Ogg page whose granule position says how many samples it holds,
   * at Opus's 48 kHz. It has to be measurable now: the handler reads the
   * duration out of these bytes before it calls anything, so a placeholder
   * buffer is no longer a voice note, it is an unreadable file.
   */
  function arrangeAudio(seconds = 5) {
    stubSender.media.set('media-1', { bytes: oggOf(seconds), mimeType: 'audio/ogg' });
  }

  function oggOf(seconds: number): Buffer {
    const page = Buffer.alloc(28);
    page.write('OggS', 0, 'ascii');
    page.writeBigUInt64LE(BigInt(seconds * 48_000), 6);
    page.writeUInt32LE(1, 14);
    page.writeUInt8(1, 26);
    return page;
  }

  /** Move a business onto a plan, through the repository that owns the write. */
  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await billingRepo.setPlan(db, {
      businessId,
      plan,
      expiresAt: null,
      actor: 'operator:test-plan',
    });
  }

  const voiceUsed = async (businessId: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((row) => row.unit === 'VOICE_MINUTES')?.used ?? 0;
  };

  it('a voice note that says a natural opt-out opts out as a typed STOP does, with no model (G-80)', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'abeg stop', seconds: 2, confidence: 0.95 });

    await post(voicePayload('2348031234567', 'wamid.V-G80'));
    await drain();

    expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();
    expect(stubSender.lastText).toBe(replies.optedOut().text);
    expect(stubTransport.requests).toHaveLength(0);
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  /**
   * Spec §4.3 rule 2: nothing that costs money at a provider is dispatched
   * before authorisation. An Integrate-only merchant holds the customer-side
   * half of the product and not this one, and the transcriber is a bill.
   */
  it('never reaches the transcriber for a merchant whose plan has no Chat', async () => {
    const business = await seedMerchant('+2348031234567');
    await moveToPlan(business.id, 'integrate');
    arrangeAudio();
    stubStt.answerWith({ text: 'should never be reached', seconds: 9, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V20'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(await voiceUsed(business.id)).toBe(0);
    expect(stubSender.lastText).toContain('part of the Chat plan');
  });

  /**
   * Spec §4.3 rule 3, the case that used to leak: metering after the work
   * meant an exhausted merchant could send Rekoda's transcription budget a
   * voice note at a time and only be refused afterwards.
   */
  it('never reaches the transcriber once the voice allowance is gone', async () => {
    const business = await seedMerchant('+2348031234567');
    const allowance = allowanceFor('trial', 'VOICE_MINUTES');
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'VOICE_MINUTES',
        allowance,
        allowance,
      ),
    );
    arrangeAudio();
    stubStt.answerWith({ text: 'should never be reached', seconds: 9, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V21'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(await voiceUsed(business.id)).toBe(allowance);
    expect(stubSender.lastText).toContain('seconds of voice notes');
  });

  it('turns speech into the same preview a typed sentence would get', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.94 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V1'));
    await drain();

    /* The SAME conversation gate a typed message hits. Voice is an input
     * method, not a second product with its own rules. */
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(stubSender.lastText).toContain('₦150,000');
  });

  it('confirms into a real invoice, through the ordinary yes', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V2'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.V2-yes', 'yes'));
    await drain();

    expect(await invoiceCount(business.id)).toBe(1);
  });

  /**
   * The promise, asserted. The transcript is kept because it is what the
   * merchant said and the books are built from it; the audio is not, because
   * a recording of somebody's voice is the most identifying thing they can
   * send and we said it would not be kept.
   */
  it('keeps the transcript and never the audio', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(9);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V3'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id, 20),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('OggS');
    expect(dump).not.toContain('secret-voice');
    // The audio went to the configured transcriber and nowhere else.
    expect(stubStt.calls).toHaveLength(1);
    expect(stubStt.calls[0]?.mimeType).toBe('audio/ogg');
  });

  /**
   * The AUDIO is the source of truth for the length, not the transcriber.
   *
   * It used to be the transcriber's number, which meant the merchant could only
   * be charged after the spend. Reading it from the container first is what
   * lets the charge happen before the provider is called, and the number is
   * the same number either way: the audio says seventeen seconds and
   * seventeen is what is taken.
   */
  it('meters the seconds the AUDIO says, before the transcriber is called', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(17);
    /* Deliberately disagrees with the audio. The container wins. */
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 900, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V4'));
    await drain();

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(17);
  });

  /**
   * The commercial limit, enforced where it protects money.
   *
   * `VOICE_NOTE_MAX_DURATION_SECONDS` is a rejection limit, not a budget: a
   * note past it never reaches a transcription provider at all. That is the
   * whole reason it exists, and the reason it is checked here rather than
   * after a bill has been incurred.
   */
  it('refuses a note past the limit without calling the transcriber', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(300);
    stubStt.answerWith({ text: 'should never be reached', seconds: 300, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V30'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('shorter parts');
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  /* Exactly at the limit is inside it, which is what a limit means. */
  it('accepts a note exactly at the limit', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(120);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 120, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V31'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(120);
  });

  /**
   * Unreadable is not zero and not "send it anyway". Nothing was measured, so
   * nothing is metered and no provider is called; the merchant is asked to
   * send it again, which is a real recovery rather than a polite refusal.
   */
  it('asks for the note again when the audio cannot be measured', async () => {
    const business = await seedMerchant('+2348031234567');
    stubSender.media.set('media-1', {
      bytes: Buffer.from('this is not an ogg stream'),
      mimeType: 'audio/ogg',
    });
    stubStt.answerWith({ text: 'should never be reached', seconds: 4, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V32'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('record it again');
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  /* Our failure, so it costs the merchant nothing and says what to do. */
  it('answers honestly when the transcriber cannot be reached', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.failWith();

    await post(voicePayload('2348031234567', 'wamid.V5'));
    await drain();

    expect(stubSender.lastText).toContain('could not listen to that voice note');
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  it('answers honestly when the audio cannot be fetched', async () => {
    await seedMerchant('+2348031234567');
    // No media arranged: the provider has nothing for this id.
    stubStt.answerWith({ text: 'should never be reached', seconds: 3, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V6'));
    await drain();

    expect(stubSender.lastText).toContain('could not listen to that voice note');
    expect(stubStt.calls).toHaveLength(0);
  });

  it('does not transcribe, meter or answer twice for a redelivered webhook', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V7'));
    await drain();
    await post(voicePayload('2348031234567', 'wamid.V7'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(5);
  });

  /* Final review B on a1e54e3: the photo path already reads and bills
   * once across a job retry (A2); a voice note must too, or a reply that
   * fails after the transcriber answered charges the seconds again. */
  it('does not transcribe or meter twice when the job fails AFTER the transcriber answered', async () => {
    const business = await seedMerchant('+2348031234596');
    arrangeAudio();
    stubStt.answerWith({ text: 'how much did we sell this month', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });

    /* A failed WhatsApp send is swallowed and retries nothing, so the job is
     * made to fail where a real retry comes from: the reply's own usage row,
     * once, after the transcriber has answered. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS voice_retry_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION voice_retry_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('voice_retry_once') = 1 THEN
            RAISE EXCEPTION 'voice retry: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER voice_retry_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION voice_retry_fail_once()`);

      await post(voicePayload('2348031234596', 'wamid.V.LATE_FAILURE'));
      await drain();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();

      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect({ attempts: Number(job?.attempts), state: job?.state }).toEqual({
        attempts: 2,
        state: 'done',
      });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS voice_retry_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS voice_retry_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS voice_retry_once`);
      await close();
    }
    /* The note's seconds are taken once, however many passes the job makes. */
    expect(await voiceUsed(business.id)).toBe(5);
  });

  /* Final review B on 8816a40: the seconds a note holds go back when a
   * retry finds the transcriber down, whichever attempt took them. */
  it('gives the seconds back when a retry finds the transcriber down', async () => {
    const business = await seedMerchant('+2348031234593');
    arrangeAudio();
    stubStt.answerWith({ text: 'how much did we sell this month', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS voice_down_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION voice_down_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('voice_down_once') = 1 THEN
            RAISE EXCEPTION 'voice_down: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER voice_down_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION voice_down_fail_once()`);

      await post(voicePayload('2348031234593', 'wamid.V.RETRY_DOWN'));
      await drain();
      expect(await voiceUsed(business.id)).toBe(5);
      stubStt.failWith();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS voice_down_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS voice_down_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS voice_down_once`);
      await close();
    }
    /* The note was never answered: its seconds are back. */
    expect(await voiceUsed(business.id)).toBe(0);
  });

  /**
   * Item 7 of the AI hardening plan: a HOSTED transcription is provider
   * money, and provider money appears in usage_events — priced per minute,
   * role-tagged, carrying BOTH durations: the local probe's (what the
   * allowance reserved on) and the provider's (what the bill runs on).
   */
  it('puts a hosted transcription on the books with both durations', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(17);
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    stubStt.answerWith({
      text: 'Ada bought 3 wigs for 150k',
      seconds: 18, // The provider's own count, one second apart from the probe's.
      confidence: null,
      usage: { provider: 'openai', model: 'whisper-test' },
    });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V30'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{
        provider: string;
        quantity: number;
        provider_cost_micros: number;
        meta: Record<string, unknown>;
      }>(sql`
        SELECT provider, quantity, provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(row.provider).toBe('openai');
    expect(Number(row.quantity)).toBe(18);
    // 18 seconds at $0.006/min: 18 × 6,000 / 60 = 1,800 micros.
    expect(Number(row.provider_cost_micros)).toBe(1_800);
    expect(row.meta).toMatchObject({
      role: 'transcriber',
      model: 'whisper-test',
      priced: true,
      localSeconds: 17,
      providerSeconds: 18,
    });
  });

  it('writes no transcription cost row when the engine reports no usage', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(5);
    // No usage envelope: nothing to price, so no cost row.
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V31'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    expect([...rows]).toHaveLength(0);
  });

  it('leaves a priced:false trail when a hosted transcription times out mid-flight', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(9);
    stubStt.failWith(
      new TranscriptionUnavailable('transcription timed out', { maybeBilled: true }),
    );

    await post(voicePayload('2348031234567', 'wamid.V32'));
    await drain();

    /* The merchant's seconds went back — Rekoda's timeout, Rekoda's cost — */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);

    /* — and the maybe-billed call is on the books at zero, admitting it,
     * so reconciliation against the invoice has a row to tie to. */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(Number(row.provider_cost_micros)).toBe(0);
    expect(row.meta).toMatchObject({ role: 'transcriber', priced: false, localSeconds: 9 });
  });

  /**
   * The DAILY voice ceilings (remediation A4): reserved race-safe before
   * the transcriber, distinct from the monthly allowance.
   */
  it('refuses a note past the business voice day, before any transcriber call', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(8);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 8, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    const runnerWith = (perDay: number) =>
      buildRunner(workerDb, db, {
        ...deps,
        config: { ...deps.config, voiceSecondsPerBusinessPerDay: perDay },
      });

    // 8 seconds fit a 10-second day once.
    await post(voicePayload('2348031234567', 'wamid.V50'));
    let runner = runnerWith(10);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
    expect(stubStt.calls).toHaveLength(1);

    // The second 8-second note does not fit the remaining 2 seconds.
    await post(voicePayload('2348031234567', 'wamid.V51'));
    runner = runnerWith(10);
    worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubStt.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many voice minutes today');
    // And the monthly meter was never touched for the refused note.
    expect(await voiceUsed(business.id)).toBe(8);
  });

  it('answers a platform-full voice day as busy, not as the merchant`s limit', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio(8);
    stubStt.answerWith({ text: 'should never be reached', seconds: 8, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V52'));
    const runner = buildRunner(workerDb, db, {
      ...deps,
      config: { ...deps.config, voiceSecondsGlobalPerDay: 5 },
    });
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).not.toContain('midnight');
  });

  /**
   * The limit's exact edge (AI hardening item 6). A boundary nobody tested
   * drifts: "at most two minutes" and "under two minutes" differ by one
   * voice note, and the merchant sent that note.
   */
  it('accepts a note exactly AT the duration limit', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio(120); // VOICE_NOTE_MAX_DURATION_SECONDS defaults to 120
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 120, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V40'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
  });

  it('rejects a note ONE second over the limit, reaching no transcriber', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(121);
    stubStt.answerWith({ text: 'should never be reached', seconds: 121, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V41'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('shorter parts');
    expect(await voiceUsed(business.id)).toBe(0);
  });

  it('flags a duration disagreement on the cost row without touching the meter', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(10);
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    /* The provider claims triple the container's reading. Neither number is
     * silently preferred: the allowance stays charged on the local one, the
     * cost runs on the provider's, and the row says they disagreed. */
    stubStt.answerWith({
      text: 'Ada bought 3 wigs for 150k',
      seconds: 30,
      confidence: null,
      usage: { provider: 'openai', model: 'whisper-test' },
    });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V42'));
    await drain();

    expect(await voiceUsed(business.id)).toBe(10);
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ quantity: number; meta: Record<string, unknown> }>(sql`
        SELECT quantity, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(Number(row.quantity)).toBe(30);
    expect(row.meta).toMatchObject({
      durationMismatch: true,
      localSeconds: 10,
      providerSeconds: 30,
    });
  });

  /* A photo with no media id is not a receipt anybody can read. */
  it('answers an image with no media id with the honest capability line', async () => {
    await seedMerchant('+2348031234567');
    await post({
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
                  { id: 'wamid.V8', from: '2348031234567', timestamp: '1', type: 'image' },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();

    expect(stubSender.lastText).toContain('read photos of receipts');
    expect(stubStt.calls).toHaveLength(0);
  });

  /** What a view-only member's message must leave untouched (G-57). */
  async function g57Footprint(businessId: string) {
    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'DOCUMENTS_UNDERSTOOD') AS documents,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings`),
    );
    return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]));
  }

  const NOTHING_TOUCHED = {
    ai_actions: 0,
    documents: 0,
    drafts: 0,
    invoices: 0,
    payments: 0,
    postings: 0,
  };

  async function accountantOn(businessId: string) {
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, businessId, accountant.id, 'accountant');
  }

  /* G-57, OWN-25: a voice note cannot be judged before it is heard, so it is
   * transcribed under the voice policy as before (VOICE_MINUTES, the
   * transcriber). What it then asks decides the rest: a record is refused
   * before any unit of AI_ACTIONS or any model call. */
  it('transcribes a view-only member`s spoken sale, then refuses it before the model (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({ text: 'Record a sale of 50k cash', seconds: 4, confidence: 0.95 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348039990001', 'wamid.V-G57-W'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
    expect(stubStt.calls).toHaveLength(1);
    expect(await voiceUsed(business.id)).toBeGreaterThan(0);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  it('asks a view-only member for a question when the transcript could be either (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada 20k', seconds: 2, confidence: 0.95 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348039990001', 'wamid.V-G57-U'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubStt.calls).toHaveLength(1);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  it('answers a view-only member`s spoken question through the model as before (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({
      text: 'How much did we sell this month?',
      seconds: 3,
      confidence: 0.95,
    });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });

    await post(voicePayload('2348039990001', 'wamid.V-G57-R'));
    await drain();

    expect(stubSender.lastText).not.toBe(replies.viewOnlyRole().text);
    expect(stubSender.lastText).not.toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubTransport.requests.length).toBeGreaterThan(0);
    expect((await g57Footprint(business.id)).ai_actions).toBe(1);
  });
});

/**
 * One person, two records, and the question that joins them.
 *
 * A message naming somebody by phone AND email used to mint two customers
 * silently. Merging them automatically was never an option: "Ada 0803...,
 * send it to accounts@bigco.com" is the same shape to a regular expression,
 * and guessing would put one customer's address on another's invoice.
 *
 * So the merchant is asked, inside the preview they are already reading, and
 * one `yes` covers the sale and the link. What these tests pin is that the
 * question is really asked, that it is only asked where a `yes` would answer
 * it, and that nothing is joined without it.
 */
describe('two records for one person', () => {
  const A_SALE_TO_TOKEN = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_ONE' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /**
   * How many customers this pair of facets resolves to, asked the way the
   * product asks: by tokenising them again. Counting rows would prove the
   * same thing about the database; this proves it about the merchant, whose
   * complaint was seeing one person twice.
   */
  const distinctCustomers = async (businessId: string): Promise<number> => {
    const { text } = await deps.gateway.tokenise(
      businessId,
      'about 08031234567 and ada@example.com',
    );
    return new Set([...text.matchAll(/CUSTOMER_[0-9A-Z]{3}/g)].map((m) => m[0])).size;
  };

  it('asks in the preview, naming what the merchant actually typed', async () => {
    await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L1',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();

    /* Rehydrated on the way out, like every other reply that names a
     * customer: what they read is the number and the address they typed. */
    expect(stubSender.lastText).toContain('same customer');
    expect(stubSender.lastText).toContain('08031234567');
    expect(stubSender.lastText).toContain('ada@example.com');
    // And it is still a preview: nothing has been written.
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  it('joins them on yes, leaving ONE customer holding BOTH facets', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L2',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();
    expect(await distinctCustomers(business.id)).toBe(2);

    await post(messagePayload('2348031234567', 'wamid.L2-yes', 'yes'));
    await drain();

    // One person, one token, whichever way the merchant refers to them.
    expect(await distinctCustomers(business.id)).toBe(1);
    // And the sale the merchant actually asked for still happened.
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('joins nothing when the merchant says no', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L3',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();

    await post(messagePayload('2348031234567', 'wamid.L3-no', 'no'));
    await drain();

    // Two records, and no sale: `no` refuses the whole preview.
    expect(await distinctCustomers(business.id)).toBe(2);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('does not ask on an expense, where a yes would not be about a customer', async () => {
    await seedMerchant('+2348031234567');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'diesel',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L4',
        'paid 12k for diesel, tell 08031234567 and ada@example.com',
      ),
    );
    await drain();

    expect(stubSender.lastText).not.toContain('same customer');
  });
});

/**
 * A photograph of a receipt (ADR 0024, decision C9).
 *
 * The pipeline is photo, self-hosted OCR, PII tokenisation, then a model, and
 * the property that matters most is the one that is hardest to see in a diff:
 * there is NO other route for the image. Every failure below must produce a
 * sentence rather than a second attempt somewhere a photograph could reach a
 * third party.
 */
describe('a receipt photo', () => {
  const A_PHOTOGRAPHED_EXPENSE = {
    intent: 'RecordExpense',
    description: 'diesel',
    amount: 12_000,
    category: 'utilities',
    paymentMethod: 'cash',
  };

  function photoPayload(
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

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  function arrangePhoto(bytes = Buffer.from('JFIF-fake-photo')) {
    stubSender.media.set('photo-1', { bytes, mimeType: 'image/jpeg' });
  }

  /** Move a business onto a plan, through the repository that owns the write. */
  async function movePhotoMerchantToPlan(
    businessId: string,
    plan: 'chat' | 'integrate' | 'complete',
  ) {
    await billingRepo.setPlan(db, {
      businessId,
      plan,
      expiresAt: null,
      actor: 'operator:test-plan',
    });
  }

  const readsUsed = async (businessId: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((row) => row.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0;
  };

  /** Spec §4.3 rule 2: reading a receipt is a Chat capability, and a bill. */
  it('never reaches the OCR engine for a merchant whose plan has no Chat', async () => {
    const business = await seedMerchant('+2348031234567');
    await movePhotoMerchantToPlan(business.id, 'integrate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P20'));
    await drain();

    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(0);
    expect(stubSender.lastText).toContain('part of the Chat plan');
  });

  /**
   * Spec §4.3 rule 3, the case that used to leak: charging after the engine
   * had already read the page meant an exhausted merchant could spend
   * Rekoda's OCR budget one photograph at a time.
   */
  it('never reaches the OCR engine once the document allowance is gone', async () => {
    const business = await seedMerchant('+2348031234567');
    const allowance = allowanceFor('trial', 'DOCUMENTS_UNDERSTOOD');
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'DOCUMENTS_UNDERSTOOD',
        allowance,
        allowance,
      ),
    );
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P21'));
    await drain();

    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(allowance);
    expect(stubSender.lastText).toContain('document scans');
  });

  /**
   * Taking the unit first only moves the order, never the price: a page
   * nobody could read is still a page nobody pays for.
   */
  it('gives the unit back when the engine cannot be reached', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith();

    await post(photoPayload('2348031234567', 'wamid.P22'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    expect(await readsUsed(business.id)).toBe(0);
  });

  it('takes the SAME path a typed sentence takes, gates included', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.88 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P1'));
    await drain();

    // A photograph is an input method, not a second product with its own rules.
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(stubSender.lastText).toContain('₦12,000');
  });

  it('keeps the extracted text and NEVER the image', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto(Buffer.from('JFIF-secret-photo-of-adas-shop'));
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P2'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id, 20),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('JFIF');
    expect(dump).not.toContain('secret-photo');
    // The bytes went to the configured reader and nowhere else.
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubOcr.calls[0]?.mimeType).toBe('image/jpeg');
  });

  it('reaches no model at all when OCR fails, and costs the merchant nothing', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith();
    const modelCallsBefore = stubTransport.requests.length;

    await post(photoPayload('2348031234567', 'wamid.P3'));
    await drain();

    expect(stubSender.lastText).toContain('could not read that photo');
    /* THE point of ADR 0024's no-fallback clause. A failed extraction must
     * not become a photograph sent to a model provider, so the model is not
     * called at all. */
    expect(stubTransport.requests.length).toBe(modelCallsBefore);

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);
  });

  it('answers honestly when the image cannot be fetched, and reads nothing', async () => {
    await seedMerchant('+2348031234567');
    // No media arranged: the provider has nothing for this id.
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P4'));
    await drain();

    expect(stubSender.lastText).toContain('could not read that photo');
    expect(stubOcr.calls).toHaveLength(0);
  });

  it('meters one documents_understood unit per photograph read', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P5'));
    await drain();

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  it('puts the caption in front of the page, because it says what the page is for', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P6', { caption: 'this is my diesel receipt' }));
    await drain();

    const sentToModel = JSON.stringify(stubTransport.requests.at(-1));
    expect(sentToModel).toContain('this is my diesel receipt');
    expect(sentToModel).toContain('TOTAL 12,000');
  });

  it('does not read, meter or answer twice for a redelivered webhook', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P7'));
    await drain();
    await post(photoPayload('2348031234567', 'wamid.P7'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  /**
   * Item 7 of the AI hardening plan: a HOSTED read is provider money, and
   * provider money appears in usage_events — costed from the engine's own
   * token counts, tagged with the role the margin view groups by.
   */
  it('puts a hosted read on the books: one ocr_vision row, priced and role-tagged', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'TOTAL 12,000 diesel',
      confidence: null,
      usage: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        tokens: { inputTokens: 1_500, outputTokens: 80 },
      },
    });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P8'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{
        provider: string;
        provider_cost_micros: number;
        meta: Record<string, unknown>;
      }>(sql`
        SELECT provider, provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(row.provider).toBe('anthropic');
    // 1,500 in at $2/MTok + 80 out at $10/MTok = 3,000 + 800 micros.
    expect(Number(row.provider_cost_micros)).toBe(3_800);
    expect(row.meta).toMatchObject({
      role: 'vision',
      model: 'claude-sonnet-5',
      priced: true,
      inputTokens: 1_500,
      outputTokens: 80,
    });
  });

  it('writes no ocr_vision cost row when the reader reports no usage', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    // No usage envelope: nothing to price, so no cost row.
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P9'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    expect([...rows]).toHaveLength(0);
  });

  it('leaves a priced:false trail when a hosted read times out mid-flight', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(new TextExtractionUnavailable('extraction timed out', { maybeBilled: true }));

    await post(photoPayload('2348031234567', 'wamid.P10'));
    await drain();

    /* The merchant's unit went back — Rekoda's timeout, Rekoda's cost — */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);

    /* — and the maybe-billed call is on the books at zero, admitting it. */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(Number(row.provider_cost_micros)).toBe(0);
    expect(row.meta).toMatchObject({ role: 'vision', priced: false });
  });

  /** The same jobs, run under a tighter daily document ceiling. */
  async function drainWithDailyLimit(limit: number) {
    const runner = buildRunner(workerDb, db, {
      ...deps,
      config: { ...deps.config, aiDocExtractionsPerBusinessPerDay: limit },
    });
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /**
   * AI hardening item 4: `AI_DOC_EXTRACTIONS_PER_BUSINESS`, enforced. The
   * daily ceiling is operational, not commercial — the merchant may have
   * monthly scans left, and the refusal must say "today", not "upgrade".
   */
  it('refuses the photograph past the daily ceiling, before any engine is called', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P11'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(1);

    await post(photoPayload('2348031234567', 'wamid.P12'));
    await drainWithDailyLimit(1);

    /* The second photograph reached no engine and consumed no monthly unit
     * — the day is full, and the merchant is told when it reopens. */
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many as I can read in one day');
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  it('returns the daily slot when the engine was never reached', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(); // connection refused: nothing spent, nothing billed

    await post(photoPayload('2348031234567', 'wamid.P13'));
    await drainWithDailyLimit(1);
    expect(stubSender.lastText).toContain('could not read that photo');

    /* The slot went back, so the retry fits under the same limit of one. */
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    await post(photoPayload('2348031234567', 'wamid.P14'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(2);
  });

  it('keeps the daily slot when the engine billed us for an unreadable page', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(
      new TextExtractionUnavailable('the page had no legible text', {
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          tokens: { inputTokens: 1_500, outputTokens: 5 },
        },
      }),
    );

    await post(photoPayload('2348031234567', 'wamid.P15'));
    await drainWithDailyLimit(1);
    expect(stubSender.lastText).toContain('could not read that photo');

    /* Provider money was spent reading nothing: a PRICED row exists — */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    // 1,500 in at $2/MTok + 5 out at $10/MTok = 3,000 + 50 micros.
    expect(Number(row.provider_cost_micros)).toBe(3_050);
    expect(row.meta).toMatchObject({ role: 'vision', priced: true });

    /* — and the day of one stays spent: the ceiling bounds spend, not
     * success, so the next photograph is refused without an engine call. */
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    await post(photoPayload('2348031234567', 'wamid.P16'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many as I can read in one day');

    /* The merchant's own monthly unit went back both times: Rekoda's
     * engine trouble is never their bill. */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);
  });

  it('does not double-charge the daily ceiling for a redelivered webhook', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    /* The same wamid twice: idempotency stops the duplicate before any
     * meter, so a limit of one still has room for nothing — but the FIRST
     * delivery went through and the duplicate consumed no second slot. */
    await post(photoPayload('2348031234567', 'wamid.P17'));
    await drainWithDailyLimit(2);
    await post(photoPayload('2348031234567', 'wamid.P17'));
    await drainWithDailyLimit(2);
    expect(stubOcr.calls).toHaveLength(1);

    /* Room for exactly one more under the limit of two proves the
     * duplicate never reserved. */
    await post(photoPayload('2348031234567', 'wamid.P18'));
    await drainWithDailyLimit(2);
    expect(stubOcr.calls).toHaveLength(2);
  });

  it('answers a platform-full document day as busy, not as the merchant`s limit', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P40'));
    const runner = buildRunner(workerDb, db, {
      ...deps,
      config: { ...deps.config, aiDocExtractionsGlobalPerDay: 0 },
    });
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubOcr.calls).toHaveLength(0);
    /* Rekoda's busy day, not the merchant's ceiling: no "midnight". */
    expect(stubSender.lastText).not.toContain('as many as I can read in one day');
  });

  /**
   * The classifier gate (AI hardening item 1): the ONE place a cheap read
   * avoids expensive ones. Confident junk skips the interpreter entirely;
   * anything less proceeds as if no classifier existed.
   */
  it('lets the classifier stop a junk page before the interpreter is paid for', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'when the beat drops and nobody is ready', confidence: 0.9 });
    stubTransport.script({
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    });

    await post(photoPayload('2348031234567', 'wamid.P20'));
    await drain();

    /* ONE model call — the classifier — and the honest sentence. */
    expect(stubTransport.requests).toHaveLength(1);
    expect(stubTransport.requests[0]!.toolName).toBe('classify_document');
    expect(stubSender.lastText).toContain('does not look like a receipt');

    /* The merchant's monthly message unit was never consumed: being told a
     * poster is a poster is not a bookkeeping action they paid for. */
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  /**
   * Dual extraction end to end (AI hardening item 9): a photographed
   * document worth ₦750,000 is read twice, and when the readers disagree
   * on money the merchant gets the review sentence and NO draft exists to
   * say yes to.
   */
  it('blocks a high-value extraction disagreement from ever becoming a draft', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'INVOICE generator diesel 750,000', confidence: 0.9 });
    const bigExpense = { ...A_PHOTOGRAPHED_EXPENSE, amount: 750_000 };
    stubTransport.script(
      // The classifier's turn: not junk, proceed.
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      // The interpreter's reading.
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );
    // The INDEPENDENT reader disagrees on the amount by ₦90,000.
    const verifierTransport = new StubTransport([
      {
        toolInput: { command: { ...bigExpense, amount: 660_000 } },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    ]);
    const dualConfig = { ...deps.config, aiModelVisionVerifier: 'gpt-test-verifier' };
    const dualDeps = {
      ...deps,
      config: dualConfig,
      interpreter: new Interpreter(db, dualConfig, stubTransport, verifierTransport),
    };

    await post(photoPayload('2348031234567', 'wamid.P30'));
    const runner = buildRunner(workerDb, db, dualDeps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(verifierTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).toContain('do not agree about the amount');
    expect(stubSender.lastText).toContain('not recorded anything');
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(0);
  });

  it('previews normally when both high-value readings agree', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'INVOICE generator diesel 750,000', confidence: 0.9 });
    const bigExpense = { ...A_PHOTOGRAPHED_EXPENSE, amount: 750_000 };
    stubTransport.script(
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );
    const verifierTransport = new StubTransport([
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    ]);
    const dualConfig = { ...deps.config, aiModelVisionVerifier: 'gpt-test-verifier' };
    const dualDeps = {
      ...deps,
      config: dualConfig,
      interpreter: new Interpreter(db, dualConfig, stubTransport, verifierTransport),
    };

    await post(photoPayload('2348031234567', 'wamid.P31'));
    const runner = buildRunner(workerDb, db, dualDeps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(verifierTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  it('proceeds to the interpreter when the classifier is anything but sure', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.script(
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      {
        toolInput: { command: A_PHOTOGRAPHED_EXPENSE },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );

    await post(photoPayload('2348031234567', 'wamid.P21'));
    await drain();

    /* Classifier first, interpreter second — fail open, never a blocker. */
    expect(stubTransport.requests).toHaveLength(2);
    expect(stubTransport.requests[0]!.toolName).toBe('classify_document');
    expect(stubTransport.requests[1]!.toolName).toBe('record_business_command');
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  /**
   * A2, the probe the fix queue gated R5 on: does a retried media job buy a
   * second AI call and a second billed unit?
   *
   * The mechanism worth checking is specific. The runner makes the handler
   * and `markDone` ONE transaction, so a throw rolls back everything the
   * handler wrote — including the row that records the message as seen. But
   * the meter deliberately runs on its OWN connection, because a counter must
   * not be held open across a network call. If those two facts combine badly,
   * a job that fails after the engine has read the page would leave the unit
   * spent and the guard gone, and the retry would read and bill again.
   */
  describe('a retry must not buy a second reading (A2)', () => {
    it('reads once and bills once, however many passes the runner makes', async () => {
      const business = await seedMerchant('+2348031234599');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });

      await post(photoPayload('2348031234599', 'wamid.A2.ONCE'));

      const runner = buildRunner(workerDb, db, deps);
      for (let pass = 0; pass < 5; pass += 1) await runner.runOnce();

      expect(stubOcr.calls).toHaveLength(1);
      expect(await readsUsed(business.id)).toBe(1);
    });

    it('does not read or bill twice when Meta redelivers the same message', async () => {
      const business = await seedMerchant('+2348031234598');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });

      /* Same wamid, twice on the wire, as a provider retry looks. */
      await post(photoPayload('2348031234598', 'wamid.A2.REDELIVERED'));
      await post(photoPayload('2348031234598', 'wamid.A2.REDELIVERED'));
      await drain();

      expect(stubOcr.calls).toHaveLength(1);
      expect(await readsUsed(business.id)).toBe(1);
    });

    it('does not read or bill twice when the job fails AFTER the engine answered', async () => {
      const business = await seedMerchant('+2348031234597');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
      /* The send is the last thing the handler does, so failing it fails the
       * job with the reading already paid for. This is the shape the audit
       * suspected, and the only one where the meter's own connection could
       * outlive the rolled-back guard. */
      stubSender.failWith();

      await post(photoPayload('2348031234597', 'wamid.A2.LATE_FAILURE'));
      await drain();

      /* The first pass read the page and billed for it, then failed on the
       * send. The job is not done; it is pending again behind a backoff. */
      expect({ reads: stubOcr.calls.length, billed: await readsUsed(business.id) }).toEqual({
        reads: 1,
        billed: 1,
      });

      /* Bring the retry forward, which is the whole point. `drain` alone
       * never reaches it, and a probe that stops at the line above proves
       * nothing about retries at all. */
      await db.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
      );
      stubSender.reset();
      await drain();

      /* The retry may legitimately re-send the reply. It must not re-read the
       * photograph or bill a second unit: the engine is what costs money. */
      expect({ reads: stubOcr.calls.length, billed: await readsUsed(business.id) }).toEqual({
        reads: 1,
        billed: 1,
      });
    });
  });

  /* Final review B on a1e54e3: a failed WhatsApp send is swallowed and
   * retries nothing, so the A2 probe above never re-ran the job. A real
   * retry (the reply's usage row failing once) must still bill the page
   * once. */
  /* Final review B on 8816a40: a photo refused at the allowance and then
   * retried is metered again, not read for free. */
  it('does not read a photo for free on the retry of an allowance refusal', async () => {
    const business = await seedMerchant('+2348031234592');
    arrangePhoto();
    stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS photo_full_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION photo_full_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('photo_full_once') = 1 THEN
            RAISE EXCEPTION 'photo_full: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER photo_full_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION photo_full_fail_once()`);

      await ownerDb.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${business.id}::uuid, ${usagePeriod(new Date())}, 'DOCUMENTS_UNDERSTOOD', 100000)`);
      await post(photoPayload('2348031234592', 'wamid.P.FULL_RETRY'));
      await drain();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS photo_full_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS photo_full_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS photo_full_once`);
      await close();
    }
    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(100000);
  });

  it('bills a photo once across a real job retry (G-57 final review B)', async () => {
    const business = await seedMerchant('+2348031234595');
    arrangePhoto();
    stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS photo_retry_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION photo_retry_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('photo_retry_once') = 1 THEN
            RAISE EXCEPTION 'photo retry: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER photo_retry_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION photo_retry_fail_once()`);

      await post(photoPayload('2348031234595', 'wamid.P.LATE_FAILURE'));
      await drain();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();

      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect({ attempts: Number(job?.attempts), state: job?.state }).toEqual({
        attempts: 2,
        state: 'done',
      });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS photo_retry_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS photo_retry_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS photo_retry_once`);
      await close();
    }
    expect(await readsUsed(business.id)).toBe(1);
  });

  /** What a view-only member's message must leave untouched (G-57). */
  async function g57Footprint(businessId: string) {
    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'DOCUMENTS_UNDERSTOOD') AS documents,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings`),
    );
    return Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]));
  }

  const NOTHING_TOUCHED = {
    ai_actions: 0,
    documents: 0,
    drafts: 0,
    invoices: 0,
    payments: 0,
    postings: 0,
  };

  /* G-57, OWN-25: a photograph only ever becomes a write today, so a member
   * who may not write is refused before the image is fetched, read,
   * classified or metered. No media is arranged: had the handler fetched,
   * the reply would be the could-not-read one. */
  it('refuses a view-only member`s photo before fetching, reading or metering it (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348039990001', 'wamid.P-G57'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyPhoto().text);
    expect(stubOcr.calls).toHaveLength(0);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  /* Final review B on a1e54e3: a member demoted while their photo was being
   * read is refused after the reading, and a refused request consumes
   * nothing (spec §4.3 rule 4), so the page's unit goes back. */
  it('gives the page back when the member is demoted while it is read (G-57)', async () => {
    const business = await seedMerchant('+2348031234594');
    const delegate = await identity.upsertUserByPhone(db, '+2348039990003');
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    const read = stubOcr.extract.bind(stubOcr);
    stubOcr.extract = async (bytes, mimeType) => {
      await ownerDb.execute(sql`
        UPDATE memberships SET role = 'accountant'
         WHERE business_id = ${business.id}::uuid AND user_id = ${delegate.id}::uuid`);
      return read(bytes, mimeType);
    };
    try {
      await post(photoPayload('2348039990003', 'wamid.P-G57-DEMOTED'));
      await drain();
    } finally {
      stubOcr.extract = read;
      await close();
    }

    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
    /* The page's unit is back and no message unit was taken; nothing was
     * drafted. (The document-type check already ran on the read page.) */
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  /* The same photograph from a delegate, who may record trade, is read and
   * previewed exactly as an owner's is: the refusal is the role's, not the
   * photo's. */
  it('reads the same photo from a delegate as before (G-57 control)', async () => {
    const business = await seedMerchant('+2348031234567');
    const delegate = await identity.upsertUserByPhone(db, '+2348039990002');
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348039990002', 'wamid.P-G57-D'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(await readsUsed(business.id)).toBe(1);
  });
});

/**
 * Asking the books a question (M3 conversational reporting).
 *
 * `Query` has been in the command contract since M0 with nothing handling
 * it, so the model could emit one and the merchant got "Recording that kind
 * of entry is not built yet" — the wrong sentence for a question, about a
 * thing they were not recording.
 *
 * A question is a READ, so it answers immediately: no draft, no preview, no
 * yes. And the model computes nothing — it decides which question was asked,
 * and every figure comes from SQL over a window core resolved.
 */
describe('asking the books a question', () => {
  const askAbout = (over: Record<string, unknown>) => ({
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: 'month',
    periodText: null,
    format: 'chat',
    ...over,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function ask(wamid: string, command: Record<string, unknown>, text = 'how am I doing') {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  /** One ₦150,000 invoice with ₦60,000 paid, and ₦12,000 of fuel. */
  async function seedTrading(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-q',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'pay-q',
        actor: 'system',
      });
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-q2',
      });
    });
  }

  it('answers a sales question from the ledger, with no yes to give', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q1', askAbout({ topic: 'sales_summary' }), 'what did I sell this month');

    expect(stubSender.lastText).toContain('₦150,000');
    expect(stubSender.lastText).toContain('₦60,000');
    /* A question is a read. Asking "shall I tell you?" would be absurd. */
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('answers a spending question', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q2', askAbout({ topic: 'expenses_summary' }), 'how much did I spend');

    expect(stubSender.lastText).toContain('₦12,000');
    expect(stubSender.lastText).toContain('one entry');
  });

  it('names the window it counted, so a merchant can see what was asked', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q3', askAbout({ topic: 'sales_summary', period: 'today' }), 'sales today');

    expect(stubSender.lastText).toContain('oday');
  });

  it('says plainly when there is nothing in the window', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q4', askAbout({ topic: 'sales_summary' }), 'what did I sell');

    expect(stubSender.lastText).toContain('not recorded any sales');
  });

  /**
   * A balance is reported by INVOICE, never by name. This text crosses
   * WhatsApp in the clear, and the merchant already knows who they asked
   * about; anybody reading over their shoulder does not.
   */
  it('answers a customer balance by invoice number, never by name', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask(
      'wamid.Q5',
      askAbout({
        topic: 'customer_balance',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      }),
      'how much does Ada owe me',
    );

    expect(stubSender.lastText).toContain('₦90,000');
    expect(stubSender.lastText).toContain('INV-');
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
    expect(stubSender.lastText).not.toContain('Ada');
  });

  it('answers the debtors question the same way the free command does', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q6', askAbout({ topic: 'debtors' }), 'who has not paid me');

    expect(stubSender.lastText).toContain('₦90,000');
    expect(stubSender.lastText).toContain('INV-');
  });

  it('answers a supplier question, and an exceptions question', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q7', askAbout({ topic: 'supplier_balances' }), 'who do I owe');
    expect(stubSender.lastText).toContain('do not owe any supplier');

    await ask('wamid.Q8', askAbout({ topic: 'unreconciled' }), 'anything strange');
    expect(stubSender.lastText).toContain('Nothing needs your attention');
  });

  /* Points at the dashboard rather than promising a file: the statement PDF
   * is not built, and a bookkeeper that says "sending it now" and sends
   * nothing is worse than one that says where to look. */
  it('points at the dashboard for a document, rather than promising one', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q9', askAbout({ topic: 'report_request' }), 'send me my accounts');

    expect(stubSender.lastText).toContain('dashboard');
    expect(stubSender.lastText).not.toContain('sending');
  });

  it('names the PDF now that it exists, without promising to send it here', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q9B', askAbout({ topic: 'report_request' }), 'send me my accounts');

    expect(stubSender.lastText).toContain('PDF');
    expect(stubSender.lastText).not.toContain('attached');
  });

  it('never writes anything: a question leaves the books untouched', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);
    const before = await invoiceCount(business.id);

    await ask('wamid.QA', askAbout({ topic: 'sales_summary' }), 'what did I sell');

    expect(await invoiceCount(business.id)).toBe(before);
  });
});

describe('a payment the merchant reports (RecordPayment)', () => {
  const A_SALE_FOR_PAYMENT = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  const paymentOf = (over: Record<string, unknown>) => ({
    intent: 'RecordPayment',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    amount: null,
    relativeAmount: null,
    documentRef: null,
    paymentMethod: 'cash',
    ...over,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  /** Work the queue to empty, as a real worker does: issuing enqueues renders. */
  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /**
   * The same yes with the RecordPayment rollout flag ON (PR-022): identical
   * receipt and ledger, because the flag changes which gates run around the
   * work and never the work. What the bus adds is in the database — the
   * completed claim for the draft — and what the work always adds now is
   * spec E.7's basis: this payment was TYPED.
   */
  it('the RecordPayment flag routes the same yes through the command bus', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PF');

    const flagged = { ...deps, config: { ...deps.config, commandRecordPayment: true } };
    async function drainFlagged() {
      const runner = buildRunner(workerDb, db, flagged);
      let worked = await runner.runOnce();
      while (worked) worked = await runner.runOnce();
    }

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PF-pay', 'Ada paid 60k'));
    await drainFlagged();
    await post(messagePayload('2348031234567', 'wamid.PF-confirm', 'yes'));
    await drainFlagged();

    expect(stubSender.lastText).toContain('RCT-');
    expect(stubSender.lastText).toContain('₦60,000');

    const claims = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ key: string; command_name: string }>(
        sql`SELECT key, command_name FROM idempotency_records
            WHERE business_id = ${business.id}::uuid AND command_name = 'RecordPayment'`,
      ),
    );
    expect([...claims]).toHaveLength(1);
    expect([...claims][0]?.key).toMatch(/^draft:/);

    const stamped = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ evidence_basis: string | null; initial_confirmation_source: string }>(
        sql`SELECT evidence_basis, initial_confirmation_source FROM payments
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...stamped][0]?.evidence_basis).toBe('TYPED');
    expect([...stamped][0]?.initial_confirmation_source).toBe('MERCHANT_ATTESTED');
  });

  /** Issue a ₦150,000 invoice with nothing paid, through the chat path. */
  async function issueUnpaidInvoice(wamid: string) {
    stubTransport.replyWith(A_SALE_FOR_PAYMENT);
    await post(messagePayload('2348031234567', `${wamid}-sale`, 'Ada bought 3 wigs for 150k'));
    await drain();
    await post(messagePayload('2348031234567', `${wamid}-yes`, 'yes'));
    await drain();
  }

  it('records a part payment, moves the ledger, and issues a receipt', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P1');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.P1-pay', 'Ada paid 60k'));
    await drain();
    // CG2 first: money never moves on a preview.
    expect(stubSender.lastText).toContain('Payment on INV-');
    expect(stubSender.lastText).toContain('Still owing after this: ₦90,000');

    await post(messagePayload('2348031234567', 'wamid.P1-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('₦60,000 recorded against INV-');
    expect(stubSender.lastText).toContain('₦90,000 still owed');
    expect(stubSender.lastText).toContain('Receipt RCT-');

    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    // RECORDED, never verified: no provider confirmed this (ADR 0014).
    expect(payments[0]?.verified).toBe(0);
    expect(payments[0]?.amountK).toBe(6_000_000);

    // The books balance, and the receivable came down by exactly the payment.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    const arCredit = entries
      .filter((e) => e.account === 'ACCOUNTS_RECEIVABLE')
      .reduce((n, e) => n + e.creditK, 0);
    expect(arCredit).toBe(6_000_000);
  });

  it('resolves "the rest" against the real balance and settles the invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P2');

    stubTransport.replyWith(paymentOf({ relativeAmount: 'remainder' }));
    await post(messagePayload('2348031234567', 'wamid.P2-pay', 'Ada paid the rest'));
    await drain();
    expect(stubSender.lastText).toContain('settles the invoice');

    await post(messagePayload('2348031234567', 'wamid.P2-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('That settles it');

    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows[0]?.status).toBe('paid');
    expect(invoices.outstandingK).toBe(0);
  });

  it('shows an overpayment as received, applied and the rest, and saves nothing yet', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P3');

    stubTransport.replyWith(paymentOf({ amount: 400_000 }));
    await post(messagePayload('2348031234567', 'wamid.P3-pay', 'Ada paid 400k'));
    await drain();

    // OWN-16: a preview the merchant decides on, never something the books
    // quietly round away. Nothing moves until the yes.
    expect(stubSender.lastText).toContain('*Amount received: ₦400,000*');
    expect(stubSender.lastText).toContain('₦150,000');
    expect(stubSender.lastText).toContain('₦250,000');
    expect(stubSender.lastText).toContain('Reply *yes*');
    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(0);

    // The draft carries exactly the figures shown, ids and kobo only.
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraft(tx, business.id),
    );
    expect(draft?.confirmationContext).toEqual({
      kind: 'payment_overpayment',
      invoiceId: expect.any(String),
      balanceShownK: 15_000_000,
      amountReceivedK: 40_000_000,
      allocatedK: 15_000_000,
      creditK: 25_000_000,
    });

    // The database refuses any other shape, so no writer can park text here:
    // an extra key, a missing key, a name where the id goes, a fraction, a
    // negative figure, or an object with nothing in it.
    for (const change of [
      `confirmation_context || '{"note":"Ada"}'::jsonb`,
      `confirmation_context - 'creditK'`,
      `confirmation_context || '{"invoiceId":"Ada Obi 08031234567"}'::jsonb`,
      `confirmation_context || '{"creditK":1.5}'::jsonb`,
      `confirmation_context || '{"allocatedK":-3}'::jsonb`,
      `'{}'::jsonb`,
      `'{"kind":"payment_overpayment"}'::jsonb`,
      `confirmation_context || '{"kind":null}'::jsonb`,
      `confirmation_context || '{"kind":"sale_overpayment"}'::jsonb`,
      `'[]'::jsonb`,
      `'"x"'::jsonb`,
      `confirmation_context || '{"creditK":"5"}'::jsonb`,
      `confirmation_context || '{"invoiceId":5}'::jsonb`,
    ]) {
      const parked = await withBusiness(db, business.id, (tx) =>
        tx.execute(
          sql`UPDATE command_drafts SET confirmation_context = ${sql.raw(change)}
              WHERE id = ${draft!.id}::uuid`,
        ),
      ).then(
        () => null,
        (error: unknown) => error as Error & { cause?: unknown },
      );
      expect(String(parked) + String(parked?.cause), change).toContain(
        'command_drafts_confirmation_context_ck',
      );
    }
  });

  /** G-49: the chat invoice names a customer on file, so the excess is theirs. */
  async function issueUnpaidInvoiceToCustomer(businessId: string, wamid: string) {
    await customersRepo.createCustomerWithIdentities(db, businessId, 'CUSTOMER_7K2', [
      { facet: 'phone', ciphertext: 'sealed-phone', matchKey: `mk-${wamid}` },
    ]);
    await issueUnpaidInvoice(wamid);
  }

  for (const method of ['cash', 'transfer'] as const) {
    it(`a confirmed ${method} overpayment settles the invoice and the rest is customer credit (G-49)`, async () => {
      const business = await seedMerchant('+2348031234567');
      await issueUnpaidInvoiceToCustomer(business.id, `wamid.PO-${method}`);

      stubTransport.replyWith(paymentOf({ amount: 180_000, paymentMethod: method }));
      await post(messagePayload('2348031234567', `wamid.PO-${method}-pay`, 'Ada paid 180k'));
      await drain();
      expect(stubSender.lastText).toContain('Customer credit: ₦30,000');

      await post(messagePayload('2348031234567', `wamid.PO-${method}-confirm`, 'yes'));
      await drain();
      expect(stubSender.lastText).toContain('₦180,000 received on INV-');
      expect(stubSender.lastText).toContain('₦150,000 applied. That settles it.');
      expect(stubSender.lastText).toContain('₦30,000 noted as customer credit.');

      // The receipt was rendered and delivered for ALL that arrived, with the
      // merchant-recorded caption, never "confirmed".
      const delivered = stubSender.documents.at(-1);
      expect(delivered?.caption).toMatch(/^Receipt RCT-\S+ for ₦180,000 on INV-/);
      expect(delivered?.caption ?? '').not.toMatch(/confirm|verif|refund/i);

      const { rows: payments } = await withBusiness(db, business.id, (tx) =>
        settleRepo.paymentsFor(tx),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0]?.amountK).toBe(18_000_000);
      expect(payments[0]?.verified).toBe(0);

      const credits = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ amount_minor: string; source_type: string }>(
          sql`SELECT amount_minor::text, source_type FROM customer_credits
              WHERE business_id = ${business.id}::uuid`,
        ),
      );
      expect([...credits]).toEqual([{ amount_minor: '3000000', source_type: 'overpayment' }]);

      const entries = await withBusiness(db, business.id, (tx) =>
        issueRepo.ledgerEntriesFor(tx, business.id),
      );
      expect(entries.reduce((n, e) => n + e.debitK, 0)).toBe(
        entries.reduce((n, e) => n + e.creditK, 0),
      );
      const net = (account: string) =>
        entries.filter((e) => e.account === account).reduce((n, e) => n + e.debitK - e.creditK, 0);
      expect(net(method === 'cash' ? 'CASH' : 'BANK')).toBe(18_000_000);
      expect(net('CUSTOMER_CREDIT')).toBe(-3_000_000);
      expect(net('ACCOUNTS_RECEIVABLE')).toBe(0);
    });
  }

  it('a correction from an overpayment to the exact balance drops the overpayment figures (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoiceToCustomer(business.id, 'wamid.PC');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain('Customer credit: ₦30,000');

    // CG5: the correction replaces the draft, and the new one shows no excess.
    stubTransport.replyWith(paymentOf({ amount: 150_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-fix', 'no, 150k not 180k'));
    await drain();
    expect(stubSender.lastText).not.toContain('Customer credit');
    const draft = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.pendingDraft(tx, business.id),
    );
    expect(draft?.confirmationContext ?? null).toBeNull();

    await post(messagePayload('2348031234567', 'wamid.PC-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('₦150,000 recorded against INV-');

    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.amountK).toBe(15_000_000);
    const credits = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    );
    expect([...credits]).toHaveLength(0);
  });

  it('an overpayment on an invoice with no customer is unapplied, never owed to anyone (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PU');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PU-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain(
      'Unapplied: ₦30,000. It is not linked to a customer yet.',
    );
    expect(stubSender.lastText).not.toContain('Customer credit');

    await post(messagePayload('2348031234567', 'wamid.PU-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('₦30,000 recorded as unapplied.');

    const credits = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    );
    expect([...credits]).toHaveLength(0);
    // The mark is on THIS payment, which is what the refund guard reads.
    const marks = await withBusiness(db, business.id, (tx) =>
      tx.execute(
        sql`SELECT 1 FROM reconciliations r JOIN payments p ON p.id = r.payment_id
            WHERE r.business_id = ${business.id}::uuid AND r.reason = 'overpaid'
              AND r.outstanding_k = -3000000 AND p.amount_k = 18000000`,
      ),
    );
    expect([...marks]).toHaveLength(1);

    // The liability is booked even with nobody to hold it.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const net = (account: string) =>
      entries.filter((e) => e.account === account).reduce((n, e) => n + e.debitK - e.creditK, 0);
    expect(net('CASH')).toBe(18_000_000);
    expect(net('CUSTOMER_CREDIT')).toBe(-3_000_000);
    expect(net('ACCOUNTS_RECEIVABLE')).toBe(0);
  });

  /**
   * The race OWN-16 is about. The preview showed 150,000 owing and the
   * merchant confirmed 180,000; 100,000 lands before the yes. Booking now
   * would turn 130,000 into credit nobody was shown. Nothing is written.
   */
  it('a stale overpayment confirmation writes nothing and asks again (G-49)', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoiceToCustomer(business.id, 'wamid.PS');

    stubTransport.replyWith(paymentOf({ amount: 180_000 }));
    await post(messagePayload('2348031234567', 'wamid.PS-pay', 'Ada paid 180k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 10_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'landed-meanwhile',
        actor: 'test',
      }),
    );
    const count = async (table: string) =>
      Number(
        [
          ...(await withBusiness(db, business.id, (tx) =>
            tx.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
                  WHERE business_id = ${business.id}::uuid`,
            ),
          )),
        ][0]?.n ?? 0,
      );
    const tables = [
      'payments',
      'payment_allocations',
      'receipts',
      'customer_credits',
      'reconciliations',
      'ledger_transactions',
    ];
    const before = await Promise.all(tables.map(count));

    await post(messagePayload('2348031234567', 'wamid.PS-confirm', 'yes'));
    await drain();

    // Figures were on the draft, so the reply names what changed, not why.
    expect(stubSender.lastText).toContain('now has ₦50,000 owing, which is not what I');
    expect(stubSender.lastText).toContain('I have not recorded anything');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it('never invents an allocation when nothing is open', async () => {
    await seedMerchant('+2348031234567');

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P4-pay', 'Ada paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  /**
   * The one that matters most on this whole path.
   *
   * A chat-issued invoice carries `customer_id = NULL` and keeps the customer
   * token in its snapshot, so resolving by a customer JOIN alone matched
   * nothing and fell through to "the newest open invoice at all" — which for
   * a shop that issues more than one invoice a day is somebody else's.
   */
  it('puts a named customer payment on THEIR invoice, not the newest one', async () => {
    const business = await seedMerchant('+2348031234567');
    // Ada first, then Bola. Bola's is newest, so a fallback would take it.
    await issueUnpaidInvoice('wamid.P5');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P5-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P5-yes2', 'yes'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const adaInvoice = before.rows.find((r) => r.totalK === 15_000_000)!;
    const bolaInvoice = before.rows.find((r) => r.totalK === 8_000_000)!;

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P5-pay', 'Ada paid 20k'));
    await drain();
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice.invoiceNumber}`);

    await post(messagePayload('2348031234567', 'wamid.P5-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const ada = after.rows.find((r) => r.invoiceNumber === adaInvoice.invoiceNumber)!;
    const bola = after.rows.find((r) => r.invoiceNumber === bolaInvoice.invoiceNumber)!;
    expect(ada.paidK).toBe(2_000_000);
    // Bola never paid anything, and nothing may say otherwise.
    expect(bola.paidK).toBe(0);
    expect(bola.balanceDueK).toBe(8_000_000);
  });

  it('asks which invoice when nobody is named and several are open', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P6');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P6-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P6-yes2', 'yes'));
    await drain();

    stubTransport.replyWith(paymentOf({ amount: 20_000, customer: { kind: 'none' } }));
    await post(messagePayload('2348031234567', 'wamid.P6-pay', 'received 20k'));
    await drain();

    expect(stubSender.lastText).toContain('2 unpaid invoices open');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('says so rather than guessing when the named customer owes nothing', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P7');

    stubTransport.replyWith(
      paymentOf({ amount: 20_000, customer: { kind: 'token', token: 'CUSTOMER_ZZZ' } }),
    );
    await post(messagePayload('2348031234567', 'wamid.P7-pay', 'Ngozi paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  it('takes the invoice number the merchant typed over the customer they named', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P8');
    const open = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const number = open.rows[0]!.invoiceNumber;

    stubTransport.replyWith(
      paymentOf({
        amount: 20_000,
        documentRef: number,
        customer: { kind: 'token', token: 'CUSTOMER_ZZZ' },
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.P8-pay', `${number} paid 20k`));
    await drain();

    expect(stubSender.lastText).toContain(`Payment on ${number}`);
  });

  it('refuses an invoice number that names nothing open, rather than falling back', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P9');

    stubTransport.replyWith(paymentOf({ amount: 20_000, documentRef: 'INV-2026-999999' }));
    await post(messagePayload('2348031234567', 'wamid.P9-pay', 'INV-2026-999999 paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  /** Units used of one kind, or zero before the counter row exists. */
  const usedOf = (rows: Array<{ unit: string; used: number }>, unit: string) =>
    rows.find((r) => r.unit === unit)?.used ?? 0;

  /**
   * A receipt is a metered document, and the copy has always said so
   * ("invoices and receipts"). Recording a payment issues one, so it costs a
   * unit exactly like a sale does: leaving it free let a merchant on an
   * exhausted plan take receipts without limit.
   */
  it('spends a documents unit on the receipt a reported payment issues', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PB');
    const period = usagePeriod(new Date());
    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PB-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PB-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'DOCUMENT_GENERATION') - usedOf(before, 'DOCUMENT_GENERATION')).toBe(1);
  });

  it('gives the unit back when the payment could not be placed', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PC');
    const period = usagePeriod(new Date());

    // Preview against the real invoice, then let the invoice settle before
    // the yes lands: the message unit is spent, the receipt never issues.
    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-pay', 'Ada paid 20k'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'settled-elsewhere',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PC-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'DOCUMENT_GENERATION')).toBe(usedOf(before, 'DOCUMENT_GENERATION'));
  });

  /**
   * The balance fell between the preview and the yes.
   *
   * The confirmation re-resolves the invoice and re-gates on the FRESH
   * balance, which is the whole reason it does not carry the preview's
   * figure forward: the merchant is asked before anything is attempted.
   * `BalanceMoved` in settle.ts guards the narrower race that remains,
   * between that read and the row lock, and refuses there too. Neither path
   * posts what fits and drops the rest, which would leave real money with no
   * story and only the merchant knows where it belongs.
   */
  it('asks rather than posting less when the invoice owes less than reported', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PD');

    stubTransport.replyWith(paymentOf({ amount: 150_000 }));
    await post(messagePayload('2348031234567', 'wamid.PD-pay', 'Ada paid 150k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

    // A transfer lands while the merchant is typing their confirmation.
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 10_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'landed-meanwhile',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PD-confirm', 'yes'));
    await drain();

    // G-49: the fresh balance makes this an overpayment nobody was shown, so
    // it is refused as stale rather than turned into ₦100,000 of credit.
    expect(stubSender.lastText).toContain('only has ₦50,000 owing');
    expect(stubSender.lastText).toContain('I have not recorded anything');
    // A question, never a preview: nothing here invites another yes.
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    // Exactly the one payment that really landed, and no second receipt.
    const { rows: payments } = await withBusiness(db, business.id, (tx) =>
      settleRepo.paymentsFor(tx),
    );
    expect(payments).toHaveLength(1);
    // And nothing else of the stale yes: one receipt, one allocation, one
    // payment posting beside the sale's, no credit and no overpaid mark.
    const n = async (query: ReturnType<typeof sql>) =>
      [...(await withBusiness(db, business.id, (tx) => tx.execute(query)))].length;
    expect(await n(sql`SELECT 1 FROM receipts WHERE business_id = ${business.id}::uuid`)).toBe(1);
    expect(
      await n(sql`SELECT 1 FROM payment_allocations WHERE business_id = ${business.id}::uuid`),
    ).toBe(1);
    expect(
      await n(sql`SELECT 1 FROM customer_credits WHERE business_id = ${business.id}::uuid`),
    ).toBe(0);
    expect(
      await n(sql`SELECT 1 FROM reconciliations WHERE business_id = ${business.id}::uuid`),
    ).toBe(0);
    expect(
      await n(sql`SELECT 1 FROM ledger_transactions WHERE business_id = ${business.id}::uuid`),
    ).toBe(2);
  });

  it('tells the customer on the receipt that the seller recorded it, not a provider', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PA');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PA-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PA-confirm', 'yes'));
    await drain();

    const receipt = stubSender.documents.at(-1);
    expect(receipt).toBeDefined();
    // The caption the merchant forwards must never borrow "confirmed".
    expect(receipt?.caption ?? '').not.toContain('confirmed');
    expect(receipt?.caption ?? '').toContain('Forward it to your customer');
  });
});

/**
 * Stock that actually moves.
 *
 * `products` and `inventory_movements` have existed since migration 0000 and
 * nothing ever wrote to either, while `AdjustInventory` sat in the command
 * contract since M0 with no handler. A merchant who typed "add 20 bags of
 * rice" was told that recording that kind of entry was not built yet.
 *
 * On-hand is SUM(delta) over an append-only ledger, so every assertion below
 * is about a figure nothing stores.
 */
describe('counting stock', () => {
  const adjust = (mention: string, delta: number) => ({
    intent: 'AdjustInventory',
    productMention: mention,
    quantityDelta: delta,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  const onHand = (businessId: string, name: string) =>
    withBusiness(db, businessId, (tx) => stockRepo.productByName(tx, businessId, name));

  it('previews a count before saving it, like every other write', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S1', adjust('bags of rice', 20), 'add 20 bags of rice');

    expect(stubSender.lastText).toContain('Adding 20 bags of rice');
    expect(stubSender.lastText).toContain('Was: 0');
    expect(stubSender.lastText).toContain('Now: 20');
    /* Nothing written until the yes. The product does not exist yet either. */
    expect(await onHand(business.id, 'bags of rice')).toBeNull();
  });

  it('saves the count on yes and says what is left', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S2', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S3', 'yes');

    expect(stubSender.lastText).toContain('Added 20 bags of rice');
    expect(stubSender.lastText).toContain('You now have 20');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(20);
  });

  /**
   * The destructive half, on the DEFAULT configuration (PR-027, Appendix
   * D.2): a preview that shows stock DISAPPEARING opens a pending
   * confirmation recording the exact consequence, and the yes claims it
   * through the command bus. The addition before it opens nothing, because
   * adding stock is STANDARD.
   *
   * This used to run under `commandAdjustInventory: true`, and that was the
   * defect it hid. The flag then defaulted OFF, and with it off the write-off fell
   * to a bare `adjustInventoryWork` call: stock disappeared from a chat
   * message with no confirmation claimed and none ever opened. The flag now
   * governs the ADDITIVE path only; `destructive` crosses the bus whatever it
   * says, so this suite uses the deps a real deployment runs.
   */
  it('a write-off opens a confirmation the yes then claims, with no flag on', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.SD1', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.SD2', 'yes');
    /* Adding stock opened NO confirmation: STANDARD stays cheap. */
    const afterAdd = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect(Number([...afterAdd][0]?.n)).toBe(0);

    await say('wamid.SD3', adjust('bags of rice', -15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    await plain('wamid.SD4', 'yes');

    expect(stubSender.lastText).toContain('Removed 15 bags of rice');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(5);

    /* The confirmation exists, was CLAIMED by the yes, and recorded the
     * consequence the merchant read. */
    const confirmations = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: string; consequence: string; claimed_at: Date | null }>(
        sql`SELECT command, consequence, claimed_at FROM pending_confirmations
            WHERE business_id = ${business.id}::uuid`,
      ),
    );
    const row = [...confirmations][0];
    expect([...confirmations]).toHaveLength(1);
    expect(row?.command).toBe('AdjustInventory');
    expect(row?.consequence).toContain('Removing 15 bags of rice');
    expect(row?.claimed_at).not.toBeNull();
  });

  it('a write-off still crosses the bus and its confirmation when the flag is 0 (Build 9)', async () => {
    const config = deps.config as unknown as { commandAdjustInventory: boolean };
    const was = config.commandAdjustInventory;
    config.commandAdjustInventory = false;
    try {
      const business = await seedMerchant('+2348031234567');
      await say('wamid.SD0-1', adjust('bags of rice', 20), 'add 20 bags of rice');
      await plain('wamid.SD0-2', 'yes');
      await say('wamid.SD0-3', adjust('bags of rice', -15), '15 bags got water damage');
      await plain('wamid.SD0-4', 'yes');
      expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(5);
      /* HIGH_RISK: the confirmation was opened and claimed through the bus,
       * whatever the rollout flag said. */
      const claimed = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM pending_confirmations
              WHERE business_id = ${business.id}::uuid AND command = 'AdjustInventory'
                AND claimed_at IS NOT NULL`,
        ),
      );
      expect(Number([...claimed][0]?.n)).toBe(1);
    } finally {
      config.commandAdjustInventory = was;
    }
  });

  it('adds onto a count that is already there', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S4', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S5', 'yes');
    await say('wamid.S6', adjust('bags of rice', 5), 'add 5 more bags of rice');

    expect(stubSender.lastText).toContain('Was: 20');
    expect(stubSender.lastText).toContain('Now: 25');

    await plain('wamid.S7', 'yes');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(25);
  });

  it('refuses to take a shop below zero, and writes nothing', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.S8', adjust('bags of rice', 4), 'add 4 bags of rice');
    await plain('wamid.S9', 'yes');
    await say('wamid.S10', adjust('bags of rice', -9), 'remove 9 bags of rice');

    expect(stubSender.lastText).toContain('less than none');
    /* A question, not a preview: there is no yes to give, so nothing moved. */
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect((await onHand(business.id, 'bags of rice'))?.onHand).toBe(4);
  });

  it('answers what is left without a model call', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S11', adjust('bags of rice', 40), 'add 40 bags of rice');
    await plain('wamid.S12', 'yes');
    await say('wamid.S13', adjust('wigs', 2), 'add 2 wigs');
    await plain('wamid.S14', 'yes');

    const before = stubTransport.requests.length;
    await plain('wamid.S15', 'stock');

    /* Free, because a merchant checks stock several times a day and charging
     * a model call to answer a SELECT would be charging them for nothing. */
    expect(stubTransport.requests.length).toBe(before);
    expect(stubSender.lastText).toContain('wigs: 2');
    expect(stubSender.lastText).toContain('bags of rice: 40');
    /* Lowest first: the row that needs them is the one about to run out. */
    expect(stubSender.lastText!.indexOf('wigs')).toBeLessThan(
      stubSender.lastText!.indexOf('bags of rice'),
    );
    expect(business.id).toBeTruthy();
  });

  it('says so plainly when nothing is counted yet', async () => {
    await seedMerchant('+2348031234567');
    await plain('wamid.S16', 'stock');
    expect(stubSender.lastText).toContain('not counting any stock yet');
  });

  /**
   * The reply used to hand a merchant twenty rows and let them read it as
   * their whole shop.
   *
   * A shop with forty five products got twenty of them, no count, and no
   * line saying so. The merchant's reading is that twenty five products
   * stopped being counted, and nothing in the message contradicts it.
   */
  it('says how many products the list left out', async () => {
    const business = await seedMerchant('+2348031234567');
    await withBusiness(db, business.id, async (tx) => {
      for (let i = 0; i < 45; i += 1) {
        const product = await stockRepo.findOrCreateProduct(tx, business.id, `Product ${i + 1}`);
        await stockRepo.recordMovement(tx, {
          businessId: business.id,
          productId: product.id,
          delta: i + 1,
          reason: 'adjustment',
          sourceType: 'chat',
          sourceId: 'seed',
        });
      }
    });

    await plain('wamid.S17', 'stock');

    const text = stubSender.lastText!;
    expect(text).toMatch(/\.\.\.and \d+ more on your dashboard\./);
    /* And the number is the truth: what the shop holds less what fitted. */
    const shown = text.split('\n').filter((l) => /^Product \d+: /.test(l)).length;
    expect(text).toContain(`...and ${45 - shown} more on your dashboard.`);
    // Still a message a merchant reads rather than one WhatsApp folds away.
    expect(text.length).toBeLessThanOrEqual(replies.MAX_REPLY_CHARS);
  });

  it('takes stock off the shelf when a sale is confirmed', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S17', adjust('wig', 10), 'add 10 wigs');
    await plain('wamid.S18', 'yes');

    await say(
      'wamid.S19',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
        statedTotal: 150_000,
        reportedPayment: 0,
        paymentMethod: 'transfer',
        discount: 0,
        deliveryFee: 0,
        dueDescription: null,
      },
      'sold 3 wigs for 150k',
    );
    await plain('wamid.S20', 'yes');

    expect((await onHand(business.id, 'wig'))?.onHand).toBe(7);
  });

  it('does not invent a product for a sale of something never counted', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.S21',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'generator', quantity: 1, unitPrice: 200_000 }],
        statedTotal: 200_000,
        reportedPayment: 0,
        paymentMethod: 'transfer',
        discount: 0,
        deliveryFee: 0,
        dueDescription: null,
      },
      'sold a generator for 200k',
    );
    await plain('wamid.S22', 'yes');

    /* Otherwise a shop that sold one of something it never stocked would be
     * told it holds minus one, forever. */
    expect(await onHand(business.id, 'generator')).toBeNull();
  });

  it('costs no document unit, because a count produces no paper', async () => {
    const business = await seedMerchant('+2348031234567');
    await say('wamid.S23', adjust('bags of rice', 20), 'add 20 bags of rice');
    await plain('wamid.S24', 'yes');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    const documents = rows.find((r) => r.unit === 'DOCUMENT_GENERATION');
    expect(documents?.used ?? 0).toBe(0);
  });
});

/**
 * A purchase that is also a delivery.
 *
 * "bought 10 crates of ankara for 50k" is two facts, and until the contract
 * carried a product and a quantity only the money one was recorded: a sale
 * took stock off the shelf and a purchase never put any back.
 */
describe('stock arriving with a purchase', () => {
  const buy = (over: Record<string, unknown> = {}) => ({
    intent: 'RecordPurchase',
    supplierMention: 'Mama Nkechi',
    description: '10 crates of ankara',
    amount: 50_000,
    reportedPayment: 50_000,
    paymentMethod: 'cash',
    productMention: 'crates of ankara',
    quantity: 10,
    ...over,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  const onHand = (businessId: string, name: string) =>
    withBusiness(db, businessId, (tx) => stockRepo.productByName(tx, businessId, name));

  /* G-61: the paid part leaves the account the merchant named, the preview
   * says which before the yes, and an account nobody named is asked about. */
  const cartons = (over: Record<string, unknown>) =>
    buy({
      supplierMention: 'Emeka',
      description: '10 cartons',
      amount: 180_000,
      productMention: 'cartons',
      quantity: 10,
      ...over,
    });

  async function nets(businessId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    for (const e of entries) out[e.account] = (out[e.account] ?? 0) + e.debitK - e.creditK;
    return out;
  }

  const purchaseRows = (businessId: string) =>
    withBusiness(db, businessId, (tx) => spendRepo.expensesFor(tx, businessId));

  for (const c of [
    {
      name: 'paid in full by transfer',
      over: { reportedPayment: 180_000, paymentMethod: 'transfer' },
      text: 'I bought 10 cartons for 180k from Emeka, paid transfer',
      preview: ['Paid in full by transfer'],
      ledger: { INVENTORY: 18_000_000, BANK: -18_000_000 },
      register: 'transfer',
    },
    {
      name: 'paid in full by cash',
      over: { reportedPayment: 180_000, paymentMethod: 'cash' },
      text: 'I bought 10 cartons for 180k from Emeka, paid cash',
      preview: ['Paid in full by cash'],
      ledger: { INVENTORY: 18_000_000, CASH: -18_000_000 },
      register: 'cash',
    },
    {
      name: 'wholly on credit',
      over: { reportedPayment: 0, paymentMethod: null },
      text: 'I bought 10 cartons for 180k from Emeka on credit',
      preview: ['Paid: nothing yet', 'Owing to supplier: ₦180,000'],
      ledger: { INVENTORY: 18_000_000, ACCOUNTS_PAYABLE: -18_000_000 },
      register: 'credit',
    },
    {
      name: 'part paid by transfer',
      over: { reportedPayment: 100_000, paymentMethod: 'transfer' },
      text: 'I bought 10 cartons for 180k from Emeka, paid 100k transfer',
      preview: ['Paid: ₦100,000 by transfer', 'Owing to supplier: ₦80,000'],
      ledger: { INVENTORY: 18_000_000, BANK: -10_000_000, ACCOUNTS_PAYABLE: -8_000_000 },
      register: 'transfer',
    },
  ] as const) {
    it(`G-61: ${c.name}, the preview names the account and yes posts to it`, async () => {
      const business = await seedMerchant('+2348031234567');
      await say(`wamid.G61-${c.name}`, cartons(c.over), c.text);
      for (const line of c.preview) expect(stubSender.lastText).toContain(line);
      if (c.register === 'credit') expect(stubSender.lastText).not.toMatch(/by cash|by transfer/);
      /* Nothing is written before the yes. */
      expect(await purchaseRows(business.id)).toHaveLength(0);

      await plain(`wamid.G61-${c.name}-yes`, 'yes');
      expect(await nets(business.id)).toEqual(c.ledger);
      const rows = await purchaseRows(business.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amountK: 18_000_000, method: c.register });
      expect((await onHand(business.id, 'cartons'))?.onHand).toBe(10);
    });
  }

  it('G-61: money paid with no stated account is asked about, never guessed', async () => {
    const business = await seedMerchant('+2348031234567');
    /* Part paid, method not said. */
    await say(
      'wamid.G61-ask',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    /* Kept on the record, never confirmable. */
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    /* The draft that asked is retired, never confirmable: a yes straight
     * after it gets the question again, and writes nothing. */
    await plain('wamid.G61-ask-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );

    /* "Bought 20 bags for 400k" reads as paid in full, from an account nobody
     * named: also a question, whatever the model thought of the method. */
    for (const paymentMethod of [null, 'unknown']) {
      await say(
        `wamid.G61-implied-${String(paymentMethod)}`,
        buy({
          description: '20 bags',
          amount: 400_000,
          reportedPayment: null,
          paymentMethod,
          productMention: 'bags',
          quantity: 20,
        }),
        'Bought 20 bags for 400k from Chima',
      );
      expect(stubSender.lastText).toContain('did you pay it all by cash or by transfer?');
    }

    expect(await purchaseRows(business.id)).toHaveLength(0);
    expect(await nets(business.id)).toEqual({});
    expect(await onHand(business.id, 'cartons')).toBeNull();
  });

  /** Everything one purchase writes, counted, plus the drafts' states. */
  async function purchaseFootprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions
              WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM inventory_movements
              WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT count(*)::int FROM outbox_events
              WHERE business_id = ${businessId}::uuid AND type = 'purchase.recorded') AS announced,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${businessId}::uuid AND state = 'pending') AS pending,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${businessId}::uuid AND state = 'abandoned') AS retired
        `),
      )),
    ];
    return row;
  }

  it('G-61: POS, then the bank answer, then yes twice records the purchase exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-dup-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    /* The clarification is on the record but not confirmable. */
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    await say(
      'wamid.G61-dup-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');

    await plain('wamid.G61-dup-yes1', 'yes');
    expect(stubSender.lastText).toContain('Saved');
    /* The second, double-tapped yes resurrects nothing. */
    await plain('wamid.G61-dup-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(stubSender.lastText).not.toContain('did it come from your bank account');

    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 0,
      announced: 1,
      pending: 0,
      retired: 0,
    });
    expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, BANK: -18_000_000 });

    /* A stray "no" later, with nothing waiting, cancels nothing: it never
     * says "Cancelled" over the recorded purchase. The answered question
     * keeps its record, CLOSED by the resend (G-68 review: a new preview
     * closes every older retired question, so nobody can rebuild it). */
    const sentBefore = stubSender.sent.length;
    await plain('wamid.G61-dup-no', 'no');
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text ?? '')).not.toContainEqual(
      expect.stringContaining('Cancelled'),
    );
    expect(await purchaseFootprint(business.id)).toMatchObject({ purchases: 1, retired: 0 });
  });

  it('G-61: part paid from an unnamed account, then the transfer answer, then yes twice: exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-dup-part',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );

    await say(
      'wamid.G61-dup-part-transfer',
      cartons({ reportedPayment: 100_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid 100k transfer',
    );
    expect(stubSender.lastText).toContain('Paid: ₦100,000 by transfer');

    await plain('wamid.G61-dup-part-yes1', 'yes');
    await plain('wamid.G61-dup-part-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');

    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 1,
      announced: 1,
      pending: 0,
      retired: 0,
    });
    expect(await nets(business.id)).toEqual({
      INVENTORY: 18_000_000,
      BANK: -10_000_000,
      ACCOUNTS_PAYABLE: -8_000_000,
    });
  });

  it('G-61: a ₦0 purchase, then the resend with an amount, then yes twice: exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-zero',
      cartons({ amount: 0, reportedPayment: 0, paymentMethod: null }),
      'I bought 10 cartons for 0 from Emeka',
    );
    expect(stubSender.lastText).toContain('I read the stock as costing ₦0');
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    await say(
      'wamid.G61-zero-resend',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid transfer',
    );
    await plain('wamid.G61-zero-yes1', 'yes');
    await plain('wamid.G61-zero-yes2', 'yes');
    /* The retired ₦0 question is never answered again as if still open. */
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(stubSender.lastText).not.toContain('costing ₦0');
    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 0,
      announced: 1,
      pending: 0,
      retired: 0,
    });
  });

  it('G-61: a yes straight after the question never confirms an OLDER preview behind it', async () => {
    const business = await seedMerchant('+2348031234567');
    /* A sale previewed and left waiting. */
    await say(
      'wamid.G61-older-sale',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 1, unitPrice: 10_000 }],
        statedTotal: 10_000,
        reportedPayment: 0,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold a wig for 10k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');

    /* Then a purchase that can only be asked about. */
    await say(
      'wamid.G61-older-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );

    /* "yes", aimed at that question: it is asked again, the sale is not
     * confirmed behind the merchant's back, and nothing is written. */
    await plain('wamid.G61-older-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    const [counts] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${business.id}::uuid AND state = 'pending') AS pending
        `),
      )),
    ];
    /* The older sale is closed by the question, kept on the record. */
    expect(counts).toEqual({ invoices: 0, purchases: 0, pending: 0 });

    /* The merchant answers by resending, then double-taps yes: the
     * replacement is saved once and the older sale is still never
     * confirmed behind the merchant's back. */
    await say(
      'wamid.G61-older-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    await plain('wamid.G61-older-yes1', 'yes');
    expect(stubSender.lastText).toContain('Saved');
    await plain('wamid.G61-older-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    const [after] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases
        `),
      )),
    ];
    expect(after).toEqual({ invoices: 0, purchases: 1 });

    /* A stray "no" days later finds nothing hidden to cancel. */
    const sentBefore = stubSender.sent.length;
    await plain('wamid.G61-older-no', 'no');
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text ?? '')).not.toContainEqual(
      expect.stringContaining('Cancelled'),
    );

    /* And a NEW sale previewed after all this is confirmed as normal. */
    await say(
      'wamid.G61-older-new-sale',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 1, unitPrice: 10_000 }],
        statedTotal: 10_000,
        reportedPayment: 0,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold a wig for 10k',
    );
    await plain('wamid.G61-older-new-yes', 'yes');
    const [last] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases
        `),
      )),
    ];
    expect(last).toEqual({ invoices: 1, purchases: 1 });
  });

  it('G-61: two purchase questions in a row, then yes, asks the second one again', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-two-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    await say(
      'wamid.G61-two-part',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    await plain('wamid.G61-two-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );
    /* The newest question wins (G-68, Codex review): asking the second one
     * closed the first, so ONE question is still open, the newest. */
    expect(await purchaseFootprint(business.id)).toMatchObject({
      purchases: 0,
      postings: 0,
      pending: 0,
      retired: 1,
    });
  });

  it('G-61: a question the merchant cancels with "no" is never asked again by a later yes', async () => {
    const business = await seedMerchant('+2348031234567');
    /* The arithmetic question (paid more than it cost) keeps its old
     * behaviour: "no" cancels it and a later yes has nothing to confirm. */
    await say(
      'wamid.G61-over',
      cartons({ reportedPayment: 200_000, paymentMethod: 'cash' }),
      'I bought 10 cartons for 180k from Emeka, paid 200k cash',
    );
    expect(stubSender.lastText).toContain('which is ₦20,000 more');
    await plain('wamid.G61-over-no', 'no');
    await plain('wamid.G61-over-yes', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');

    /* The funding question too: "no" closes it for good. */
    await say(
      'wamid.G61-no-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    await plain('wamid.G61-no-pos-no', 'no');
    expect(stubSender.lastText).toContain('Cancelled');
    await plain('wamid.G61-no-pos-yes', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(await purchaseFootprint(business.id)).toMatchObject({
      purchases: 0,
      postings: 0,
      pending: 0,
      retired: 0,
    });
  });

  it('G-61: a POS payer is asked where the money came from, and the answer posts to it', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'I know you paid by POS. I just need the source of the money for your books',
    );
    expect(stubSender.lastText).not.toContain('Was that cash or transfer?');
    expect(await purchaseRows(business.id)).toHaveLength(0);

    /* Sent again with the source: "POS from my bank account" reads as transfer. */
    await say(
      'wamid.G61-pos-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await plain('wamid.G61-pos-bank-yes', 'yes');
    expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, BANK: -18_000_000 });
  });

  it('names the delivery in the preview and writes nothing yet', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P1', buy(), 'bought 10 crates of ankara for 50k');

    expect(stubSender.lastText).toContain('Adding to stock: 10 crates of ankara');
    expect(await onHand(business.id, 'crates of ankara')).toBeNull();
  });

  it('puts the stock on the shelf on yes, and says the new count', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P2', buy(), 'bought 10 crates of ankara for 50k');
    await plain('wamid.P3', 'yes');

    expect(stubSender.lastText).toContain('crates of ankara is now 10 on hand');
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(10);
  });

  it('adds onto a count the merchant already had', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.P4',
      { intent: 'AdjustInventory', productMention: 'crates of ankara', quantityDelta: 4 },
      'add 4 crates of ankara',
    );
    await plain('wamid.P5', 'yes');
    await say('wamid.P6', buy(), 'bought 10 more crates of ankara for 50k');
    await plain('wamid.P7', 'yes');

    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(14);
  });

  /**
   * The whole point of a cost, end to end and through the real chat path.
   *
   * A delivery says what ten crates cost. A sale of three takes three off the
   * shelf AND posts what those three cost, so the profit and loss stops
   * reporting gross profit equal to revenue.
   */
  it('a delivery sets the cost, and a later sale posts it against the goods', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.C1', buy(), 'bought 10 crates of ankara for 50k');
    await plain('wamid.C2', 'yes');
    expect((await onHand(business.id, 'crates of ankara'))?.unitCostK).toBe(5_000_00);

    await say(
      'wamid.C3',
      {
        intent: 'RecordSale',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'crates of ankara', quantity: 3, unitPrice: 9_000 }],
        statedTotal: 27_000,
        reportedPayment: 27_000,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold 3 crates of ankara for 27k',
    );
    await plain('wamid.C4', 'yes');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    /* Three at ₦5,000: the cost of exactly what left the shelf. */
    expect(entries).toContainEqual(expect.objectContaining({ account: 'COGS', debitK: 15_000_00 }));
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', creditK: 15_000_00 }),
    );
    /* And the books still balance with a second posting on the same sale. */
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(7);
  });

  /**
   * A product nobody has ever bought through Rekoda has no cost, and a sale
   * of it must post none rather than nothing-per-unit. The revenue stands;
   * the statements say how much of it had no cost against it.
   */
  it('posts no cost for goods nobody has told Rekoda the price of', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.C5',
      { intent: 'AdjustInventory', productMention: 'head ties', quantityDelta: 40 },
      'add 40 head ties',
    );
    await plain('wamid.C6', 'yes');
    await say(
      'wamid.C7',
      {
        intent: 'RecordSale',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'head ties', quantity: 2, unitPrice: 2_500 }],
        statedTotal: 5_000,
        reportedPayment: 5_000,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold 2 head ties for 5k',
    );
    await plain('wamid.C8', 'yes');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries.some((e) => e.account === 'COGS')).toBe(false);
    /* The sale itself is recorded in full: an unknown cost is not a reason to
     * lose the revenue. */
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'SALES_REVENUE', creditK: 5_000_00 }),
    );
  });

  it('moves no stock for a purchase the merchant described in prose', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.P8',
      buy({ description: 'restocked the shop', productMention: null, quantity: null }),
      'restocked the shop, 50k',
    );
    await plain('wamid.P9', 'yes');

    /* A purchase of a service, or one described only in prose, is still a
     * purchase. It just is not a count. */
    expect(stubSender.lastText).toContain('Saved');
    expect(stubSender.lastText).not.toContain('on hand');
    expect(
      (await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id))).rows,
    ).toEqual([]);
  });

  it('still records the money owed when stock arrives part paid', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P10', buy({ reportedPayment: 20_000 }), 'bought 10 crates, paid 20k');
    await plain('wamid.P11', 'yes');

    expect(stubSender.lastText).toContain('₦30,000');
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(10);
  });
});

/**
 * The one thing Rekoda says that links anywhere.
 *
 * Until this existed a merchant who wanted their statements had to leave the
 * thread, recall an address, type their number and wait for a code that
 * arrived back in the thread they had just left.
 */
describe('asking for the dashboard in chat', () => {
  async function seedMerchant(phone: string, name = 'Ada Fashion') {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  it('sends a tappable link, not an address to remember', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH1', 'dashboard'));
    await drain();

    const sent = stubSender.sent.map((m) => m.text);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://books.example.test/enter?t=');
    // The merchant is told what they are holding: it dies, and it dies fast.
    expect(sent[0]).toContain('works once');
    expect(sent[0]).toContain('15 minutes');
  });

  it('mints a fresh link each time, never reuses one', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH2', 'my books'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.DASH3', 'open my books'));
    await drain();

    const links = stubSender.sent.map((m) => /\/enter\?t=([^\s]+)/.exec(m.text)?.[1]);
    expect(links).toHaveLength(2);
    expect(links[0]).toBeTruthy();
    /* A reused link would be a credential with two lives, and the second tap
     * would find the first had already burned it. */
    expect(links[0]).not.toBe(links[1]);
  });

  /**
   * Free, like `stock` and `records`. A merchant reaching for their own books
   * should not be paying for a model call to be handed a URL.
   */
  it('costs no model call, because it is a deterministic command', async () => {
    const business = await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH4', 'sign in'));
    await drain();

    const spend = await withBusiness(db, business.id, (tx) =>
      quotaRepo.usageTotals(tx, 'anthropic'),
    );
    expect(spend.calls).toBe(0);
  });
});

/**
 * An order somebody else placed (Door 2), end to end.
 *
 * The whole journey a Nigerian merchant actually has: a customer messages
 * them asking for things, they forward that message, and what comes back is a
 * quote priced from their own catalogue. Nothing about it is a sale until
 * they say yes.
 */
describe('a forwarded order', () => {
  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  /** A shop that sells two things, one of them never priced. */
  async function seedCatalogue(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: bale.id,
        delta: 10,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
      await catalogueRepo.editProduct(tx, businessId, bale.id, { unitPriceK: 850_000 });
      await stockRepo.findOrCreateProduct(tx, businessId, 'Head tie');
    });
  }

  const THE_ORDER = {
    intent: 'RecordOrder',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'Ankara bale', quantity: 2 }],
    note: 'deliver to Lekki on Friday',
  };

  it('quotes from the catalogue, then raises the invoice on a yes', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.ORDER');

    /* Priced by Rekoda, from the merchant's own list. Nothing the customer
     * or the model said about money reached this figure. */
    expect(stubSender.lastText).toContain('This is what they are asking for');
    expect(stubSender.lastText).toContain('2 × Ankara bale at ₦8,500');
    expect(stubSender.lastText).toContain('Total: ₦17,000');
    expect(stubSender.lastText).toContain('They also said: deliver to Lekki on Friday');

    // Nothing issued yet, and no order recorded either: this is still a quote.
    expect(await invoiceCount(business.id)).toBe(0);
    expect(
      (await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))).rows,
    ).toEqual([]);

    await send('yes', 'wamid.ORDERYES');
    expect(stubSender.lastText).toMatch(/ORD-\d{4}-000001 is now INV-\d{4}-000001 for ₦17,000/);
    expect(stubSender.lastText).toContain('Nothing has been paid yet');

    expect(await invoiceCount(business.id)).toBe(1);

    const orders = await withBusiness(db, business.id, (tx) =>
      ordersRepo.ordersFor(tx, business.id),
    );
    expect(orders.rows).toHaveLength(1);
    expect(orders.count).toBe(1);
    expect(orders.rows[0]).toMatchObject({ status: 'confirmed', totalK: 1_700_000, itemCount: 1 });

    /* The books balance, read back out of the database. An order confirmed is
     * a sale on credit: receivable up, revenue up, nothing paid. */
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(1_700_000);

    /* And the shelf says so. Ten bales, two committed. */
    const stock = await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(8);
  });

  /**
   * The persistence boundary (launch remediation R5): the customer's
   * delivery words are echoed to the merchant ONCE and never stored. The
   * contract has said so since RecordOrder existed; this pins that the
   * stored draft actually honours it — through the central
   * sanitizeCommandForPersistence boundary, not a call-site if.
   */
  it('echoes the delivery note once and stores a draft WITHOUT it (R5)', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale, deliver to Lekki on Friday', 'wamid.ORDERNOTE');

    // Said once, to the merchant, from the LIVE command.
    expect(stubSender.lastText).toContain('They also said: deliver to Lekki on Friday');

    /* Never written down. The stored draft keeps every bookkeeping field
     * and none of the customer's words. */
    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown> }>(sql`
        SELECT command FROM command_drafts WHERE business_id = ${business.id}::uuid
      `),
    );
    const stored = JSON.stringify([...drafts].map((row) => row.command));
    expect(stored).not.toContain('Lekki');
    expect(stored).not.toContain('Friday');
    expect(stored).toContain('Ankara bale');

    // And the sanitised draft still confirms into a real invoice.
    await send('yes', 'wamid.ORDERNOTEYES');
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('meters the order: a confirmed order consumes one orders unit on top of the document', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.METER');
    await send('yes', 'wamid.METERYES');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('refuses capture on a plan without orders, keeps the quote, and gives the document back', async () => {
    const business = await seedMerchant('+2348031234567');
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:test',
    });
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    /* The quote itself is free and still works: refusing to PRICE would
     * punish the merchant before they even hit the gate. */
    await send('please I want 2 ankara bale', 'wamid.CHATORDER');
    expect(stubSender.lastText).toContain('Total: ₦17,000');

    await send('yes', 'wamid.CHATORDERYES');
    expect(stubSender.lastText).toContain('Automatic order capture is part of the Integrate plan');

    /* Nothing booked, and the document unit the yes reserved went back:
     * a refused capture must not cost a document nobody received. */
    expect(await invoiceCount(business.id)).toBe(0);
    expect(
      (await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))).rows,
    ).toEqual([]);
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
  });

  /**
   * The other half of the refund, and the reachable one.
   *
   * A merchant with orders LEFT in their entitlement but NONE left in their
   * allowance passes the gate above and fails the counter below, after the
   * document unit is already spent. Two units are reserved in sequence and
   * only one of them was taken, so only one goes back — and the branch that
   * decides which is the same branch every other exit uses. Before the
   * shared refund path this arithmetic lived in seven places, each free to
   * be wrong on its own.
   */
  it('gives the document back when the orders allowance, not the plan, is what refuses', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    const period = usagePeriod(new Date());
    const orderAllowance = allowanceFor('trial', 'CATALOGUE_ORDERS');

    /* A trial month with every order already used. Spent through the same
     * counter the confirmation spends, so the refusal below is the real one. */
    for (let taken = 0; taken < orderAllowance; taken += 1) {
      const granted = await withBusiness(db, business.id, (tx) =>
        usageRepo.consumeUnit(tx, business.id, period, 'CATALOGUE_ORDERS', orderAllowance),
      );
      expect(granted).toBe(true);
    }

    stubTransport.replyWith(THE_ORDER);
    await send('please I want 2 ankara bale', 'wamid.ORDERCAP');
    await send('yes', 'wamid.ORDERCAPYES');

    expect(stubSender.lastText).toContain(`You have used all ${orderAllowance} orders`);
    expect(await invoiceCount(business.id)).toBe(0);

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    /* The document unit the yes reserved came back. */
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
    /* And the exhausted counter was not moved by the attempt. */
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(orderAllowance);
  });

  /**
   * The refusal that matters. Inventing a price would put a number in front
   * of a customer that the merchant never agreed to, so it asks instead.
   */
  it('asks for a price rather than quoting one it does not have', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith({
      ...THE_ORDER,
      items: [
        { name: 'Ankara bale', quantity: 1 },
        { name: 'Head tie', quantity: 2 },
      ],
    });

    await send('they want a bale and 2 head ties', 'wamid.UNPRICED');
    expect(stubSender.lastText).toContain('I do not have a price for Head tie');
    /* And nothing was quoted, so there is nothing to say yes to. */
    expect(stubSender.lastText).not.toContain('Total:');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The bug the message above would have told a lie about.
   *
   * Order pricing used to run over `catalogueFor`, which returns three
   * hundred products ordered by name. A provisions shop with more than that
   * had everything sorting past the cap answered with "I cannot find it in
   * what you sell" about a product it stocks and has priced. It failed safe,
   * in that no invented figure ever reached a customer, and it was still the
   * assistant telling a merchant their own shop does not carry something.
   */
  it('prices a product the catalogue page would have cut off', async () => {
    const business = await seedMerchant('+2348031234567');
    await withBusiness(db, business.id, async (tx) => {
      for (let i = 0; i < 320; i += 1) {
        await stockRepo.findOrCreateProduct(tx, business.id, `Aaa filler ${i + 1}`);
      }
      const zobo = await stockRepo.findOrCreateProduct(tx, business.id, 'Zobo drink');
      await catalogueRepo.editProduct(tx, business.id, zobo.id, { unitPriceK: 50_000 });
    });
    stubTransport.replyWith({ ...THE_ORDER, items: [{ name: 'Zobo drink', quantity: 4 }] });

    await send('customer wants 4 zobo', 'wamid.PASTCAP');

    expect(stubSender.lastText).toContain('4 × Zobo drink at ₦500');
    expect(stubSender.lastText).toContain('Total: ₦2,000');
    expect(stubSender.lastText).not.toContain('I cannot find');

    // And the yes still raises the invoice, at the price the merchant set.
    await send('yes', 'wamid.PASTCAPYES');
    expect(await invoiceCount(business.id)).toBe(1);
    expect(stubSender.lastText).toMatch(/for ₦2,000/);
  });

  it('says so when the shop does not sell what they asked for', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith({ ...THE_ORDER, items: [{ name: 'gele', quantity: 1 }] });

    await send('customer wants a gele', 'wamid.UNKNOWN');
    expect(stubSender.lastText).toContain('I cannot find gele in what you sell');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The catalogue is re-read at the yes, not carried on the draft. A merchant
   * who changes a price between the preview and the confirmation gets the
   * price they have now, and one who UNPRICES something gets asked rather
   * than an invoice at yesterday's figure.
   */
  it('refuses at the yes if the price it quoted has since gone', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.STALE');
    expect(stubSender.lastText).toContain('Total: ₦17,000');

    await withBusiness(db, business.id, async (tx) => {
      const [bale] = (await catalogueRepo.catalogueFor(tx, business.id)).rows.filter(
        (p) => p.name === 'Ankara bale',
      );
      await catalogueRepo.editProduct(tx, business.id, bale!.id, { unitPriceK: null });
    });

    await send('yes', 'wamid.STALEYES');
    expect(stubSender.lastText).toContain('I do not have a price for Ankara bale');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The whole of Door 2, with the money door open: a customer's own message
   * becomes an invoice and a link the merchant can forward straight back.
   *
   * The link needs the customer's EMAIL, which lives in the identity vault
   * against a customer row. Chat-issued invoices used to carry
   * `customer_id = NULL` and keep only the token, so the vault had nothing to
   * hang on and no chat-created invoice could ever be paid online. That is
   * what resolving the token at issue time fixes.
   */
  it('offers a payable link when the shop can take one', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    await withBusiness(db, business.id, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId: business.id,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
    });

    /* The customer the gateway would have resolved, with an email on file:
     * the forwarded message named them, and Rekoda never invents an address. */
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_7K2', [
      {
        facet: 'email',
        ciphertext: encryptFacet(
          'adaeze@example.com',
          deps.config.vaultKey,
          `${business.id}:email`,
        ),
        matchKey: null,
      },
    ]);

    stubTransport.replyWith(THE_ORDER);
    await send('please I want 2 ankara bale', 'wamid.LINK');
    await send('yes', 'wamid.LINKYES');

    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001: ₦17,000 outstanding/);
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  /* A shop with no provider connection hears nothing extra. The link job runs
   * and stays quiet: telling them after every order that they cannot take
   * card is a sentence they would learn to scroll past. */
  it('says nothing extra when the shop cannot take a payment', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.NOLINK');
    await send('yes', 'wamid.NOLINKYES');

    /* The last thing they heard is the confirmation itself, not an apology. */
    expect(stubSender.lastText).toMatch(/ORD-\d{4}-000001 is now INV-\d{4}-000001/);
    expect(stubSender.lastText).not.toContain('Payment link');
  });

  it('records which invoice the order became', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.LINKED');
    await send('yes', 'wamid.LINKEDYES');

    const [order] = (
      await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))
    ).rows;
    expect(order!.invoiceNumber).toMatch(/^INV-\d{4}-000001$/);
  });

  /* A quote is not an agreement to pay on a day. What the customer said about
   * timing is about DELIVERY, and reading it as a payment date would put
   * somebody on the debtors list on a day nobody agreed. */
  it('leaves the invoice undated rather than reading a delivery note as terms', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.DUE');
    await send('yes', 'wamid.DUEYES');

    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows[0]?.dueDate).toBeNull();
  });
});

/**
 * A preview has a time limit (G-23, migration 0153).
 *
 * A "yes" executes a preview only inside its confirmation window. Monday's
 * preview answered on Thursday records nothing, costs nothing, and the
 * merchant is told it expired and to send it again. Time is moved by closing
 * the window in the database (`expires_at` set into the past), never by
 * sleeping; the boundary instant itself is pinned in draft-expiry.
 */
describe('a preview has a time limit (G-23)', () => {
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 100_000 }],
    statedTotal: 300_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const AN_EXPENSE = {
    intent: 'RecordExpense',
    description: 'fuel for generator',
    amount: 20_000,
    category: 'utilities',
    paymentMethod: 'cash',
  };
  const A_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'transfer',
    productMention: 'cartons',
    quantity: 10,
  };
  const EXPIRED = replies.draftExpired().text;

  async function seedMerchant(phone = '+2348031234567') {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  /** Days pass: every open window of this business closes. */
  const lapse = (businessId: string, where = sql`state = 'pending'`) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND ${where}`),
    );

  async function states(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  /** Every row a confirmation can write, counted. */
  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM payment_allocations WHERE business_id = ${businessId}::uuid) AS allocations,
            (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*)::int FROM customer_credits WHERE business_id = ${businessId}::uuid) AS credits,
            (SELECT count(*)::int FROM reconciliations WHERE business_id = ${businessId}::uuid) AS reconciliations,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM orders WHERE business_id = ${businessId}::uuid) AS orders,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function used(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return {
      documents: rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0,
      orders: rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0,
    };
  }

  it('a yes inside the window records the sale, as it always has', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-fresh', A_SALE, 'sold Ada 3 wigs for 300k');
    expect(stubSender.lastText).toContain('Please check this before I save it');
    await plain('wamid.G23-fresh-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
    expect(await states(business.id)).toEqual(['confirmed']);
  });

  it("Monday's preview and Thursday's yes: nothing recorded, nothing charged, and it says why", async () => {
    const business = await seedMerchant();
    await say('wamid.G23-mon', A_SALE, 'sold Ada 3 wigs for 300k');
    const before = await footprint(business.id);
    const documentsBefore = stubSender.documents.length;

    await lapse(business.id);
    await plain('wamid.G23-thu', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(stubSender.lastText).not.toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toEqual(before);
    expect(before.invoices).toBe(0);
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    expect(stubSender.documents.length).toBe(documentsBefore);
    /* Kept for the record, never deleted, never confirmable. */
    expect(await states(business.id)).toEqual(['expired']);

    /* Another yes is still about that request, and still records nothing. */
    await plain('wamid.G23-thu-2', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toEqual(before);
  });

  it('an expired preview never lets a yes reach an older preview behind it', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-older', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.G23-newer', AN_EXPENSE, 'bought fuel 20k cash');
    /* Only the newest, the one on the merchant's screen, has lapsed. */
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );

    await plain('wamid.G23-older-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 0, postings: 0 });
    /* The older sale was not touched by that yes. */
    expect(await states(business.id)).toEqual(['pending', 'expired']);
  });

  it('a new request after an expired one is confirmed alone, never the old one', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-a', A_SALE, 'sold Ada rice 300k');
    await lapse(business.id);
    await say('wamid.G23-b', AN_EXPENSE, 'bought fuel 20k cash');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');

    await plain('wamid.G23-b-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 1 });
    expect(await states(business.id)).toEqual(['expired', 'confirmed']);

    /* And a stray yes afterwards resurrects nothing. */
    await plain('wamid.G23-b-yes-2', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, expenses: 1 });
  });

  it('a correction inside the window supersedes the first preview and gets its own window', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-c1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say(
      'wamid.G23-c2',
      {
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      },
      'sorry, 4 wigs not 3',
    );
    expect(await states(business.id)).toEqual(['superseded', 'pending']);
    const windows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ fresh: boolean }>(sql`
        SELECT expires_at > clock_timestamp() AS fresh FROM command_drafts
         WHERE business_id = ${business.id}::uuid ORDER BY insertion_seq`),
    );
    expect([...windows].map((w) => w.fresh)).toEqual([true, true]);

    /* The correction lapses too: the superseded first preview never revives. */
    await lapse(business.id);
    await plain('wamid.G23-c-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await states(business.id)).toEqual(['superseded', 'expired']);
    expect((await footprint(business.id)).invoices).toBe(0);
  });

  it('a "sorry, 4 not 3" after the preview expired is a new request with a fresh window', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-e1', A_SALE, 'sold Ada 3 wigs for 300k');
    await lapse(business.id);
    await say(
      'wamid.G23-e2',
      {
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      },
      'sorry, 4 wigs not 3',
    );
    /* The expired one was expired, not "corrected". */
    expect(await states(business.id)).toEqual(['expired', 'pending']);
    await plain('wamid.G23-e-yes', 'yes');
    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows).toHaveLength(1);
    expect(invoices.rows[0]?.totalK).toBe(40_000_000);
  });

  it('two yes messages inside the window: one invoice, one document unit', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-r1', A_SALE, 'sold Ada 3 wigs for 300k');
    await post(messagePayload('2348031234567', 'wamid.G23-r1-yes-a', 'yes'));
    await post(messagePayload('2348031234567', 'wamid.G23-r1-yes-b', 'yes'));
    /* Delivered together; one business's messages are handled one at a time
     * (the per-business lock), so they are worked in turn. The parallel
     * race on the claim itself is pinned in draft-expiry.integration. */
    await drain();
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('two yes messages after the window: nothing executes, nothing is charged', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-r2', A_SALE, 'sold Ada 3 wigs for 300k');
    await lapse(business.id);
    const before = stubSender.sent.length;
    await post(messagePayload('2348031234567', 'wamid.G23-r2-yes-a', 'yes'));
    await post(messagePayload('2348031234567', 'wamid.G23-r2-yes-b', 'yes'));
    /* Delivered together; one business's messages are handled one at a time
     * (the per-business lock), so they are worked in turn. The parallel
     * race on the claim itself is pinned in draft-expiry.integration. */
    await drain();
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    expect(await states(business.id)).toEqual(['expired']);
    const answers = stubSender.sent.slice(before).map((m) => m.text);
    expect(answers).toEqual([EXPIRED, EXPIRED]);
  });

  it('a window that closes between the metering and the claim refunds the unit and records nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-edge', A_SALE, 'sold Ada 3 wigs for 300k');
    /* Deterministic: the moment this business's document unit is consumed,
     * its open preview's window closes, exactly the race the claim's own
     * predicate exists for. Test-scoped, on the owner connection. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_close_window() RETURNS trigger AS $$
        BEGIN
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = NEW.business_id AND state = 'pending';
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_close_window AFTER INSERT OR UPDATE ON usage_counters
          FOR EACH ROW WHEN (NEW.unit = 'DOCUMENT_GENERATION' AND NEW.used > 0)
          EXECUTE FUNCTION g23_close_window()`);

      await plain('wamid.G23-edge-yes', 'yes');
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_close_window ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_close_window()`);
      await close();
    }

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    /* Taken, then given back: the merchant paid nothing for expired work. */
    expect((await used(business.id)).documents).toBe(0);
    expect(await states(business.id)).toEqual(['expired']);
  });

  it('a yes sent inside the window is honoured by a retry that runs after it, charged once', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-retry', A_SALE, 'sold Ada 3 wigs for 300k');

    /* Attempt 1 meters the unit (its own committed transaction), claims the
     * draft, then fails issuing: the job rolls back, the unit stays spent. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_once') = 1 THEN RAISE EXCEPTION 'g23: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g23_fail_once()`);

      await post(messagePayload('2348031234567', 'wamid.G23-retry-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await footprint(business.id)).invoices).toBe(0);
      expect(await states(business.id)).toEqual(['pending']);
      expect((await used(business.id)).documents).toBe(1);

      /* The window closes AFTER the yes arrived and BEFORE the retry runs,
       * as a backoff can make it. */
      await ownerDb.execute(sql`
        UPDATE command_drafts SET expires_at = (
          SELECT created_at + interval '1 millisecond' FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1)
         WHERE business_id = ${business.id}::uuid`);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${business.id}::uuid
           AND state <> 'done'`);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
      await close();
    }

    /* The merchant said yes in time: the sale is recorded once, the unit
     * attempt 1 took is the one it cost, and nobody is told it expired. */
    expect(stubSender.lastText).not.toBe(EXPIRED);
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
    expect(await states(business.id)).toEqual(['confirmed']);
  });

  it('an expired overpayment preview writes no payment, credit, reconciliation or posting (G-49)', async () => {
    const business = await seedMerchant();
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_7K2', [
      { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g23-over' },
    ]);
    await say('wamid.G23-o-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-o-sale-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);

    await say(
      'wamid.G23-o-pay',
      {
        intent: 'RecordPayment',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        amount: 400_000,
        relativeAmount: null,
        documentRef: null,
        paymentMethod: 'cash',
      },
      'Ada paid 400k',
    );
    expect(stubSender.lastText).toContain('Customer credit: ₦100,000');
    const before = await footprint(business.id);
    const documentsUsed = (await used(business.id)).documents;

    await lapse(business.id);
    await plain('wamid.G23-o-yes', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toEqual(before);
    expect(before).toMatchObject({
      payments: 0,
      allocations: 0,
      receipts: 0,
      credits: 0,
      reconciliations: 0,
    });
    expect((await used(business.id)).documents).toBe(documentsUsed);
    /* The figures the merchant was shown stay on the record, unexecutable. */
    const kept = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string; kind: string | null }>(sql`
        SELECT state, confirmation_context->>'kind' AS kind FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordPayment'`),
    );
    expect([...kept]).toEqual([{ state: 'expired', kind: 'payment_overpayment' }]);
  });

  it('an expired purchase preview is an expiry, never mistaken for a retired question (G-61)', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-p', A_PURCHASE, 'I bought 10 cartons for 180k from Emeka, paid transfer');
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await lapse(business.id);
    await plain('wamid.G23-p-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(stubSender.lastText).not.toContain('cash or transfer');
    expect(await states(business.id)).toEqual(['expired']);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a retired purchase question is still re-asked by a yes, however old (G-61)', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.G23-q',
      { ...A_PURCHASE, paymentMethod: 'pos' },
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await states(business.id)).toEqual(['abandoned']);
    /* Its window is long past: the question is still a question, not an expiry. */
    await lapse(business.id, sql`state = 'abandoned'`);
    await plain('wamid.G23-q-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await states(business.id)).toEqual(['abandoned']);

    /* The resend is a fresh preview with its own window, recorded once. */
    await say(
      'wamid.G23-q-bank',
      A_PURCHASE,
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    await plain('wamid.G23-q-bank-yes', 'yes');
    await plain('wamid.G23-q-bank-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
    expect(await states(business.id)).toEqual(['superseded', 'confirmed']);
  });

  it('a "no" after an expired preview cancels nothing, not even an older preview', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-n1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.G23-n2', AN_EXPENSE, 'bought fuel 20k cash');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
    );
    await plain('wamid.G23-n-no', 'no');
    expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);
    /* The sale behind it is exactly as it was. */
    expect(await states(business.id)).toEqual(['pending', 'expired']);
  });

  it('an expired order quote raises no order, no invoice, and takes no order or document unit', async () => {
    const business = await seedMerchant();
    await withBusiness(db, business.id, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, business.id, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId: business.id,
        productId: bale.id,
        delta: 10,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
      await catalogueRepo.editProduct(tx, business.id, bale.id, { unitPriceK: 850_000 });
    });
    await say(
      'wamid.G23-ord',
      {
        intent: 'RecordOrder',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'Ankara bale', quantity: 2 }],
        note: null,
      },
      'please I want 2 ankara bale',
    );
    expect(stubSender.lastText).toContain('Total: ₦17,000');
    await lapse(business.id);
    await plain('wamid.G23-ord-yes', 'yes');

    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ orders: 0, invoices: 0, postings: 0 });
    expect(await used(business.id)).toEqual({ documents: 0, orders: 0 });
    const stock = await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(10);
  });

  it('an expired stock write-off removes nothing', async () => {
    const business = await seedMerchant();
    const adjust = (delta: number) => ({
      intent: 'AdjustInventory',
      productMention: 'bags of rice',
      quantityDelta: delta,
    });
    await say('wamid.G23-s1', adjust(20), 'add 20 bags of rice');
    await plain('wamid.G23-s1-yes', 'yes');
    await say('wamid.G23-s2', adjust(-15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    await lapse(business.id);
    await plain('wamid.G23-s2-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    const rice = await withBusiness(db, business.id, (tx) =>
      stockRepo.productByName(tx, business.id, 'bags of rice'),
    );
    expect(rice?.onHand).toBe(20);
  });

  it('an expired expense preview records no expense', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-x', AN_EXPENSE, 'bought fuel 20k cash');
    await lapse(business.id);
    await plain('wamid.G23-x-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });

  /**
   * Attempt 1 of the next "yes" meters, claims, then fails issuing (a
   * fail-once trigger on invoices): the job rolls back and is retried later,
   * so other messages can be handled before it. Test-scoped, on the owner.
   */
  async function withFirstInvoiceFailing(run: (owner: Db) => Promise<void>) {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_once') = 1 THEN RAISE EXCEPTION 'g23: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g23_fail_once()`);
      await run(ownerDb);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_once`);
      await close();
    }
  }

  /** Push every job still waiting for this business an hour out. */
  const holdRetries = (owner: Db, businessId: string) =>
    owner.execute(sql`
      UPDATE jobs SET run_at = now() + interval '1 hour'
       WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

  /** Make every job still waiting for this business due now. */
  const runRetriesNow = (owner: Db, businessId: string) =>
    owner.execute(sql`
      UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);

  it('a retried yes overtaken by a newer request confirms what it was sent for, never the newer preview', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-ot1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-ot1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      /* Hold the retry back until the test releases it, so the newer message
       * is handled first however slow the runner is. */
      await holdRetries(owner, business.id);
      expect((await footprint(business.id)).invoices).toBe(0);

      /* A newer request is previewed while the yes waits to be retried. */
      await say(
        'wamid.G23-ot2',
        {
          ...A_SALE,
          customer: { kind: 'none' },
          items: [{ name: 'shoes', quantity: 2, unitPrice: 25_000 }],
          statedTotal: 50_000,
        },
        'sold Bayo 2 shoes',
      );
      expect(stubSender.lastText).toContain('Total: ₦50,000');
      await runRetriesNow(owner, business.id);
      await drain();
    });

    /* The yes confirmed the 300k sale it answered, once; the shoes, which
     * did not exist when it was sent, are still only a preview. */
    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows.map((i) => i.totalK)).toEqual([30_000_000]);
    expect(await states(business.id)).toEqual(['confirmed', 'pending']);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a retried yes whose window a later message closed records nothing and gives the unit back', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-cl1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-cl1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      /* Hold the retry back until the test releases it, so the newer message
       * is handled first however slow the runner is. */
      await holdRetries(owner, business.id);
      expect((await used(business.id)).documents).toBe(1);

      /* The window closes just after the yes arrived, and a later request
       * (handled before the retry) closes it for good. */
      await owner.execute(sql`
        UPDATE command_drafts SET expires_at = (
          SELECT created_at + interval '1 millisecond' FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1)
         WHERE business_id = ${business.id}::uuid`);
      await say('wamid.G23-cl2', AN_EXPENSE, 'bought fuel 20k cash');
      expect(await states(business.id)).toEqual(['expired', 'pending']);

      await runRetriesNow(owner, business.id);
      await drain();
    });

    expect((await footprint(business.id)).invoices).toBe(0);
    /* Attempt 1's unit is back: nothing was charged for work that never ran. */
    expect((await used(business.id)).documents).toBe(0);
    expect(stubSender.sent.map((m) => m.text)).toContain(EXPIRED);
  });

  it('a yes that arrived after the window, retried, gives back nothing it never took', async () => {
    const business = await seedMerchant();
    /* One real sale first, so the counter has a unit a wrong refund would show. */
    await say('wamid.G23-nr-0', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-nr-0-yes', 'yes');
    expect((await used(business.id)).documents).toBe(1);

    await say('wamid.G23-nr-1', A_SALE, 'sold Ada 3 more wigs for 300k');
    await lapse(business.id);

    /* The answer to the late yes fails to be recorded once, so the job is
     * retried: attempt 1 metered nothing (the window had closed before the
     * yes arrived), and the retry must not refund a unit it never took. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_out_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_out_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_out_once') = 1 THEN RAISE EXCEPTION 'g23: first answer fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_out_once BEFORE INSERT ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound') EXECUTE FUNCTION g23_fail_out_once()`);

      await post(messagePayload('2348031234567', 'wamid.G23-nr-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      await runRetriesNow(ownerDb, business.id);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_out_once ON conversation_messages`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_out_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_out_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(EXPIRED);
    expect((await footprint(business.id)).invoices).toBe(1);
    /* Still the one unit the real sale cost: no free unit from the retry. */
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a yes that reached Rekoda before the preview existed confirms nothing (CG2)', async () => {
    const business = await seedMerchant();
    /* Both arrive before either is handled: the yes was typed before the
     * merchant could have read any preview, so it is not their consent. */
    stubTransport.replyWith(AN_EXPENSE);
    await post(messagePayload('2348031234567', 'wamid.G23-pre', 'bought fuel 20k cash'));
    await post(messagePayload('2348031234567', 'wamid.G23-pre-yes', 'yes'));
    await drain();

    /* Never "nothing is waiting": a preview is. It just is not this yes's. */
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
    /* The preview stands, for a yes sent after reading it. */
    expect(await states(business.id)).toEqual(['pending']);
    await plain('wamid.G23-pre-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('a lapsed question stored with a financial intent is never called an expired request', async () => {
    const business = await seedMerchant();
    const previewedOf = async () => {
      const rows = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ intent: string; previewed: boolean }>(sql`
          SELECT intent, previewed FROM command_drafts
           WHERE business_id = ${business.id}::uuid ORDER BY insertion_seq`),
      );
      return [...rows];
    };

    /* A sale whose total disagrees with its items: a CG1 question, stored
     * as a RecordSale draft, never a preview. */
    await say('wamid.G23-cg1', { ...A_SALE, statedTotal: 350_000 }, 'sold Ada 3 wigs for 350k');
    expect(stubSender.lastText).toContain('Tell me the right one');
    /* A payment with no open invoice to place it on: a question too. */
    await say(
      'wamid.G23-noinv',
      {
        intent: 'RecordPayment',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        amount: 50_000,
        relativeAmount: null,
        documentRef: null,
        paymentMethod: 'cash',
      },
      'Ada paid 50k',
    );
    /* And a real preview, for contrast. */
    await say('wamid.G23-real', AN_EXPENSE, 'bought fuel 20k cash');
    expect(await previewedOf()).toEqual([
      { intent: 'RecordSale', previewed: false },
      { intent: 'RecordPayment', previewed: false },
      { intent: 'RecordExpense', previewed: true },
    ]);

    /* The expense lapses: its yes is told it expired. */
    await lapse(business.id);
    await plain('wamid.G23-real-yes', 'yes');
    expect(stubSender.lastText).toBe(EXPIRED);

    /* A business whose LAST thing was a question: never "expired". */
    const second = await seedMerchant('+2348031234568');
    stubTransport.replyWith({ ...A_SALE, statedTotal: 350_000 });
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b', 'sold Ada 3 wigs for 350k'));
    await drain();
    await lapse(second.id);
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b-yes', 'yes'));
    await drain();
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    await post(messagePayload('2348031234568', 'wamid.G23-cg1b-no', 'no'));
    await drain();
    expect(stubSender.lastText).not.toBe(replies.expiredNothingToCancel().text);
  });

  it('a preview whose send failed is not "previewed": its lapse is never called an expired request', async () => {
    const business = await seedMerchant();
    stubSender.failWith();
    await say('wamid.G23-unsent', AN_EXPENSE, 'bought fuel 20k cash');
    const flags = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ previewed: boolean }>(sql`
        SELECT previewed FROM command_drafts WHERE business_id = ${business.id}::uuid`),
    );
    expect([...flags].map((r) => r.previewed)).toEqual([false]);

    await lapse(business.id);
    await plain('wamid.G23-unsent-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    expect((await footprint(business.id)).expenses).toBe(0);
  });

  it('a preview re-sent after its job rolled back is pointed at, never confirmed by the earlier yes', async () => {
    const business = await seedMerchant();
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The preview reaches the merchant, then a later statement in the same
       * job fails (recording that it was sent): the draft rolls back. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_sent_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_sent_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_sent_once') = 1 THEN RAISE EXCEPTION 'g23: after the send'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_sent_once BEFORE UPDATE ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound') EXECUTE FUNCTION g23_fail_sent_once()`);

      stubTransport.replyWith(AN_EXPENSE);
      await post(messagePayload('2348031234567', 'wamid.G23-rb', 'bought fuel 20k cash'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect(stubSender.lastText).toContain('Expense: fuel for generator');
      expect(await states(business.id)).toEqual([]);

      /* The merchant read it and said yes; the preview's retry runs first
       * and writes the draft again, after that yes had arrived. */
      await post(messagePayload('2348031234567', 'wamid.G23-rb-yes', 'yes'));
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() - interval '1 hour'
         WHERE business_id = ${business.id}::uuid AND state <> 'done' AND attempts > 0`);
      await drain();
    } finally {
      await ownerDb.execute(
        sql`DROP TRIGGER IF EXISTS g23_fail_sent_once ON conversation_messages`,
      );
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_sent_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_sent_once`);
      await close();
    }

    /* Pointed at, not "nothing waiting", and nothing saved by that yes. */
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    expect((await footprint(business.id)).expenses).toBe(0);
    expect(await states(business.id)).toEqual(['pending']);

    /* The next yes confirms it, once. */
    await plain('wamid.G23-rb-yes-2', 'yes');
    expect((await footprint(business.id)).expenses).toBe(1);
  });

  it('a write-off confirmed in time but run late applies, its HIGH_RISK confirmation judged at the same instant', async () => {
    const business = await seedMerchant();
    const adjust = (delta: number) => ({
      intent: 'AdjustInventory',
      productMention: 'bags of rice',
      quantityDelta: delta,
    });
    await say('wamid.G23-wo1', adjust(20), 'add 20 bags of rice');
    await plain('wamid.G23-wo1-yes', 'yes');
    await say('wamid.G23-wo2', adjust(-15), '15 bags got water damage');
    expect(stubSender.lastText).toContain('Removing 15 bags of rice');
    /* The HIGH_RISK confirmation opens from the draft's own database
     * timestamp, never this host's clock: the two windows close together. */
    const [windows] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ same: boolean }>(sql`
          SELECT (SELECT expires_at FROM command_drafts
                   WHERE business_id = ${business.id}::uuid AND state = 'pending')
               = (SELECT expires_at FROM pending_confirmations
                   WHERE business_id = ${business.id}::uuid AND claimed_at IS NULL) AS same`),
      )),
    ];
    expect(windows?.same).toBe(true);

    /* The yes arrives inside both windows; by the time it runs, both have
     * closed on the wall clock. */
    await post(messagePayload('2348031234567', 'wamid.G23-wo2-yes', 'yes'));
    await withBusiness(db, business.id, async (tx) => {
      const [arrived] = [
        ...(await tx.execute<{ at: string }>(sql`
          SELECT (created_at + interval '1 millisecond')::text AS at FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at DESC LIMIT 1`)),
      ];
      await tx.execute(sql`
        UPDATE command_drafts SET expires_at = ${arrived!.at}::timestamptz
         WHERE business_id = ${business.id}::uuid AND state = 'pending'`);
      await tx.execute(sql`
        UPDATE pending_confirmations SET expires_at = ${arrived!.at}::timestamptz
         WHERE business_id = ${business.id}::uuid AND claimed_at IS NULL`);
    });
    await drain();

    expect(stubSender.lastText).toContain('Removed 15 bags of rice');
    const rice = await withBusiness(db, business.id, (tx) =>
      stockRepo.productByName(tx, business.id, 'bags of rice'),
    );
    expect(rice?.onHand).toBe(5);
    const claimed = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ claimed: boolean }>(sql`
        SELECT claimed_at IS NOT NULL AS claimed FROM pending_confirmations
         WHERE business_id = ${business.id}::uuid`),
    );
    expect([...claimed].map((r) => r.claimed)).toEqual([true]);
  });

  it('a retried yes whose draft a correction superseded while it waited gives the unit back', async () => {
    const business = await seedMerchant();
    await say('wamid.G23-sup1', A_SALE, 'sold Ada 3 wigs for 300k');

    await withFirstInvoiceFailing(async (owner) => {
      await post(messagePayload('2348031234567', 'wamid.G23-sup1-yes', 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await used(business.id)).documents).toBe(1);
      await holdRetries(owner, business.id);

      /* The merchant corrects it before the retry runs. */
      await say(
        'wamid.G23-sup2',
        {
          ...A_SALE,
          items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
          statedTotal: 400_000,
        },
        'sorry, 4 wigs not 3',
      );
      expect(await states(business.id)).toEqual(['superseded', 'pending']);

      await runRetriesNow(owner, business.id);
      await drain();
    });

    /* Nothing issued for that yes, and the unit its first attempt took is back. */
    expect((await footprint(business.id)).invoices).toBe(0);
    expect((await used(business.id)).documents).toBe(0);
    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);

    /* The corrected preview is confirmed by the next yes, charged once. */
    await plain('wamid.G23-sup2-yes', 'yes');
    expect((await footprint(business.id)).invoices).toBe(1);
    expect((await used(business.id)).documents).toBe(1);
  });

  it('a yes queued behind a correction, retried, refunds nothing it never reserved', async () => {
    const business = await seedMerchant();
    /* One real sale, so the counter holds a unit a wrong refund would take. */
    await say('wamid.G23-q0', A_SALE, 'sold Ada 3 wigs for 300k');
    await plain('wamid.G23-q0-yes', 'yes');
    expect((await used(business.id)).documents).toBe(1);
    await say('wamid.G23-q1', A_SALE, 'sold Ada 3 more wigs for 300k');

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      /* The yes's answer fails to be recorded once, so its job is retried. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g23_ptr_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g23_fail_ptr_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g23_ptr_once') = 1 THEN RAISE EXCEPTION 'g23: answer fails once'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g23_fail_ptr_once BEFORE INSERT ON conversation_messages
          FOR EACH ROW WHEN (NEW.direction = 'outbound' AND NEW.body LIKE 'I sent you a preview%')
          EXECUTE FUNCTION g23_fail_ptr_once()`);

      /* The correction reaches Rekoda first, the yes after; both queue, and
       * the correction is handled (superseding the draft) after the yes had
       * already arrived. The yes meters nothing: there is nothing for it. */
      stubTransport.replyWith({
        ...A_SALE,
        items: [{ name: 'wig', quantity: 4, unitPrice: 100_000 }],
        statedTotal: 400_000,
      });
      await post(messagePayload('2348031234567', 'wamid.G23-q2', 'sorry, 4 wigs not 3'));
      await post(messagePayload('2348031234567', 'wamid.G23-q2-yes', 'yes'));
      await drain();
      await runRetriesNow(ownerDb, business.id);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g23_fail_ptr_once ON conversation_messages`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g23_fail_ptr_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g23_ptr_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(replies.previewAwaitingYes().text);
    /* Still the one unit the real sale cost: nothing reserved, nothing back. */
    expect((await used(business.id)).documents).toBe(1);
    expect((await footprint(business.id)).invoices).toBe(1);
  });

  it('a lapsed clarification was never a preview: a later yes or no is not told it expired', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.G23-unclear',
      { intent: 'Unclear', clarification: 'How many wigs?' },
      'sold some wigs',
    );
    expect(stubSender.lastText).toContain('How many wigs?');
    await lapse(business.id);

    await plain('wamid.G23-unclear-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
    const before = stubSender.sent.length;
    await plain('wamid.G23-unclear-no', 'no');
    expect(stubSender.sent.slice(before).map((m) => m.text)).not.toContain(
      replies.expiredNothingToCancel().text,
    );
  });

  it('an expired erasure ask answered yes or no says nothing was deleted, never "saved"', async () => {
    const business = await seedMerchant();
    await plain('wamid.G23-ex-del', 'delete my data');
    await lapse(business.id);
    await plain('wamid.G23-ex-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    await plain('wamid.G23-ex-no', 'no');
    expect(stubSender.lastText).toBe(replies.erasureKept().text);
    expect(await states(business.id)).toEqual(['expired']);
  });

  it('a second erasure ask after the first ask expired deletes nothing and asks again', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g23-erase' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await plain('wamid.G23-del1', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    await lapse(business.id);

    /* Too late to be the confirmation: it is a new first ask. */
    await plain('wamid.G23-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
    expect(await states(business.id)).toEqual(['expired', 'pending']);

    /* Inside the new window, the exact phrase erases, as it always has. */
    await plain('wamid.G23-del3', 'delete my data');
    expect(stubSender.lastText).toContain('deleted (1 record)');
    expect(await facets()).toEqual([]);
  });
});

/**
 * Conversational continuation (Build 6): a short reply attaches to the
 * question Rekoda just asked THAT person, or continues the read it just
 * answered them, and nothing else.
 *
 *     "How much did I sell?" -> "Which period?" -> "Last month."
 *
 * What resumes is always a read, answered from SQL with no model. A reply
 * that does not fit is understood exactly as it would have been without the
 * question, and the question is gone. Nothing here reaches a draft: the
 * financial confirmation path (G-23) and the retired purchase question
 * (G-61) behave exactly as before.
 */
describe('a short reply continues what Rekoda just asked (Build 6)', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const WHICH_PERIOD = replies.whichPeriod('sales').text;
  const NOT_COUNTABLE = replies.periodNotCountable('sales').text;
  const STRAY = replies.strayNumber().text;
  const HOW_MUCH_DID_I_SELL = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const HOW_MUCH_DID_I_SPEND = { ...HOW_MUCH_DID_I_SELL, topic: 'expenses_summary' };
  /* What the model says when it is (wrongly) handed a bare answer. */
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 100_000,
    reportedPayment: 100_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 100_000 }],
    statedTotal: 300_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    /* A fresh runner every time: the state must survive the worker being
     * rebuilt between the question and the answer (durable, not memory). */
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  /** A message the model would read as unclear, if it ever reached it. */
  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  const modelCalls = () => stubTransport.requests.length;

  /** One sale of ₦150,000 last month (₦60,000 paid), one of ₦40,000 this month. */
  async function seedTwoMonths(businessId: string) {
    const lastMonth = resolvePeriod('last_month', new Date());
    const inLastMonth = new Date(lastMonth.from.getTime() + 2 * 86_400_000).toISOString();
    await withBusiness(db, businessId, async (tx) => {
      const old = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'b6-old',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: old.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'b6-old-pay',
        actor: 'system',
      });
      await tx.execute(sql`
        UPDATE invoices SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid AND id = ${old.invoiceId}::uuid`);
      await tx.execute(sql`
        UPDATE payments SET created_at = ${inLastMonth}::timestamptz
         WHERE business_id = ${businessId}::uuid`);
      await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'bag', quantity: 1, unitPriceK: 4_000_000 }],
        subtotalK: 4_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 4_000_000,
        paidK: 0,
        balanceDueK: 4_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'b6-new',
        actor: 'system',
      });
    });
    return {
      lastMonthLabel: lastMonth.label,
      thisMonthLabel: resolvePeriod('month', new Date()).label,
    };
  }

  async function continuations(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        user_id: string;
        kind: string;
        expects: string | null;
        topic: string | null;
        period: string | null;
        state: string;
      }>(sql`
        SELECT user_id, kind, expects, topic, period, state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    );
    return [...rows];
  }

  /** Every row a write could leave, counted. */
  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts
        `),
      )),
    ];
    return row!;
  }

  async function draftStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string; intent: string }>(sql`
        SELECT state, intent FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => `${r.intent}:${r.state}`);
  }

  it('"How much did I sell?", "Which period?", "Last month." answers for last month, with no model', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say('wamid.B6-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    await reply('wamid.B6-answer', 'Last month.');
    /* The original question resumed over the window the merchant named. */
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000 invoiced across one sale`);
    expect(stubSender.lastText).toContain('₦60,000 of that has actually come in');
    /* Not this month's ₦40,000, and not a guess by the model. */
    expect(stubSender.lastText).not.toContain('₦40,000');
    expect(modelCalls()).toBe(0);

    /* One-shot: the question is consumed, and the read it resumed is now
     * what a follow-up continues. */
    expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
      'clarification:consumed',
      'query:open',
    ]);
  });

  it('a follow-up continues the read just answered: "what about this month"', async () => {
    const business = await seedMerchant();
    const { thisMonthLabel } = await seedTwoMonths(business.id);

    await say('wamid.B6-f-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await reply('wamid.B6-f-answer', 'last month');
    await reply('wamid.B6-f-follow', 'what about this month');

    expect(stubSender.lastText).toContain(`${thisMonthLabel}: ₦40,000 invoiced across one sale`);
    expect(modelCalls()).toBe(0);
  });

  it("one member's answer never lands on another member's question", async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say('wamid.B6-a-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    /* The delegate's "last month" is not an answer to the owner's question:
     * it goes to the model like any message with nothing open for them. */
    await reply('wamid.B6-a-other', 'last month', DELEGATE);
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    /* The owner's question is still open, and still theirs. */
    await reply('wamid.B6-a-own', 'last month', OWNER);
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it("one business's answer never lands on another business's question", async () => {
    const first = await seedMerchant(`+${OWNER}`);
    await seedMerchant('+2348035550000');

    await say('wamid.B6-b-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    await reply('wamid.B6-b-other', 'last month', '2348035550000');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    await reply('wamid.B6-b-own', 'last month', OWNER);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);
    expect((await continuations(first.id)).map((c) => c.state)).toEqual(['consumed', 'open']);
  });

  it('a new purchase after "Which period?" is a purchase, and the question is gone', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-n-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

    await say(
      'wamid.B6-n-buy',
      { ...POS_PURCHASE, paymentMethod: 'cash' },
      'I bought 10 cartons for 100k cash',
    );
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toContain('Paid in full by cash');
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    /* A later "last month" answers nothing: the question was replaced. */
    await reply('wamid.B6-n-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('an expired question behaves as if it was never asked', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-e-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid`),
    );

    await reply('wamid.B6-e-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
  });

  it('the newest question wins: an answer goes to the question asked last', async () => {
    const business = await seedMerchant();
    await withBusiness(db, business.id, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: business.id,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'b6-fuel',
      }),
    );

    await say('wamid.B6-r-sell', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-r-spend', HOW_MUCH_DID_I_SPEND, 'How much did I spend?');
    expect(stubSender.lastText).toBe(replies.whichPeriod('spending').text);

    await reply('wamid.B6-r-answer', 'this month');
    expect(stubSender.lastText).toContain('₦12,000 spent across one entry');
    expect(
      (await continuations(business.id)).map((c) => `${c.topic}:${c.kind}:${c.state}`),
    ).toEqual([
      'sales_summary:clarification:superseded',
      'expenses_summary:clarification:consumed',
      'expenses_summary:query:open',
    ]);
  });

  it('a bare number while a period is expected is not guessed at', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-2-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

    await reply('wamid.B6-2', '2');
    expect(stubSender.lastText).toBe(STRAY);
    expect(modelCalls()).toBe(0);
    /* And the question did not survive being answered with the wrong thing. */
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
  });

  it('a bare number with nothing open stays a stray number', async () => {
    await seedMerchant();
    await reply('wamid.B6-2-alone', '2');
    expect(stubSender.lastText).toBe(STRAY);
  });

  it('a continuation never writes a record, and a yes after it confirms nothing new', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-w-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    const before = await footprint(business.id);

    await reply('wamid.B6-w-answer', 'last month');
    /* Only the footprint the same message left before Build 6: one
     * read-only question draft, which nothing can confirm. */
    expect(await footprint(business.id)).toEqual({ ...before, drafts: (before.drafts ?? 0) + 1 });
    expect(await draftStates(business.id)).toEqual(['Query:pending', 'Query:pending']);
    const stored = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown>; model: string | null }>(sql`
        SELECT command, model FROM command_drafts WHERE business_id = ${business.id}::uuid
         ORDER BY insertion_seq DESC LIMIT 1`),
    );
    expect([...stored][0]).toEqual({
      command: {
        intent: 'Query',
        topic: 'sales_summary',
        customer: null,
        period: 'custom',
        periodText: null,
        format: null,
      },
      model: null,
    });

    await reply('wamid.B6-w-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({
      invoices: before.invoices,
      payments: before.payments,
      expenses: before.expenses,
      postings: before.postings,
    });
    expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
  });

  it('a G-23 expired preview stays expired through a question, its answer and a yes', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g23-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${business.id}::uuid`),
    );

    await say('wamid.B6-g23-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await reply('wamid.B6-g23-answer', 'last month');
    expect(stubSender.lastText).toContain('sales');

    /* The yes is about the expired preview, the last thing it could be
     * about: never revived, never "saved", and the question in between is
     * not something a yes confirms. */
    await reply('wamid.B6-g23-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    await reply('wamid.B6-g23-no', 'no');
    expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);

    expect((await draftStates(business.id))[0]).toBe('RecordSale:expired');
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  const BEHIND = replies.previewBehindQuestion().text;
  const THIS_MONTH = { ...HOW_MUCH_DID_I_SELL, period: 'month' };

  it('a live preview behind a question and its answer takes three yeses, as on base', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-live-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-live-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await reply('wamid.B6-live-answer', 'Last month');
    expect(modelCalls()).toBe(0);

    /* Two questions since the preview ("Which period?" and the resumed
     * read): each yes retires the newest one, exactly the draft that yes
     * claimed before Build 6, and saves nothing. */
    await reply('wamid.B6-live-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'Query:pending',
      'Query:superseded',
    ]);
    await reply('wamid.B6-live-yes2', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0 });

    /* The third, as on base, confirms it through the ordinary claim. */
    await reply('wamid.B6-live-yes3', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    expect((await draftStates(business.id))[0]).toBe('RecordSale:confirmed');
  });

  it('two model-answered questions after a preview take a yes each before the yes that saves', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-two-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-two-q1', THIS_MONTH, 'How much did I sell this month?');
    await say(
      'wamid.B6-two-q2',
      { ...THIS_MONTH, topic: 'expenses_summary' },
      'How much did I spend this month?',
    );

    await reply('wamid.B6-two-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    await reply('wamid.B6-two-yes2', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'Query:superseded',
      'Query:superseded',
    ]);

    await reply('wamid.B6-two-yes3', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    await reply('wamid.B6-two-yes4', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
  });

  it('a yes behind [live preview, expired preview, question] reports the expiry and leaves the live one alone', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-m7-p1', A_SALE, 'sold Ada 3 wigs for 300k');
    await say(
      'wamid.B6-m7-p2',
      { ...A_SALE, items: [{ name: 'bag', quantity: 1, unitPrice: 50_000 }], statedTotal: 50_000 },
      'sold Ada 1 bag for 50k',
    );
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid
           AND insertion_seq = (SELECT max(insertion_seq) FROM command_drafts
                                 WHERE business_id = ${business.id}::uuid)`),
    );
    await say('wamid.B6-m7-ask', THIS_MONTH, 'How much did I sell this month?');

    await reply('wamid.B6-m7-yes', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    expect(await draftStates(business.id)).toEqual([
      'RecordSale:pending',
      'RecordSale:expired',
      'Query:pending',
    ]);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  it('"correct" after reading a figure never saves the older preview', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-ack-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-ack-ask', THIS_MONTH, 'How much did I sell this month?');
    expect(stubSender.lastText).toContain('sales');

    await reply('wamid.B6-ack-correct', 'correct');
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    /* The preview is untouched and still waiting; the question is retired. */
    expect(await draftStates(business.id)).toEqual(['RecordSale:pending', 'Query:superseded']);

    await reply('wamid.B6-ack-yes', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
    /* Exactly one: a further yes finds nothing. */
    await reply('wamid.B6-ack-yes-again', 'yes');
    expect(await footprint(business.id)).toMatchObject({ invoices: 1 });
  });

  it('a preview that expires after the pointer is reported expired, never saved', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-exp-sale', A_SALE, 'sold Ada 3 wigs for 300k');
    await say('wamid.B6-exp-ask', THIS_MONTH, 'How much did I sell this month?');
    await reply('wamid.B6-exp-yes1', 'yes');
    expect(stubSender.lastText).toBe(BEHIND);

    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`),
    );
    await reply('wamid.B6-exp-yes2', 'yes');
    expect(stubSender.lastText).toBe(replies.draftExpired().text);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
  });

  it('a yes after a retired G-61 question and a question still re-asks it, executing nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61q-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    await say('wamid.B6-g61q-ask', THIS_MONTH, 'How much did I sell this month?');
    await reply('wamid.B6-g61q-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });

  it('a named period whose words disagree with it is asked about, never guessed', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);
    await say(
      'wamid.B6-disagree',
      { ...HOW_MUCH_DID_I_SELL, period: 'month', periodText: 'last month' },
      'How much did I sell last month?',
    );
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
  });

  it('a window named but not countable here says what can be counted, and stays open', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say(
      'wamid.B6-y-ask',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'yesterday' },
      'how much did I sell yesterday',
    );
    expect(stubSender.lastText).toBe(NOT_COUNTABLE);
    expect(stubSender.lastText).not.toBe(WHICH_PERIOD);

    await reply('wamid.B6-y-answer', 'last month');
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it('a custom window the merchant named in one message is answered at once', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);

    await say(
      'wamid.B6-c-ask',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'last month' },
      'How much did I sell last month?',
    );
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    /* No question was asked; the read is what a follow-up continues. */
    expect(
      (await continuations(business.id)).map((c) => `${c.kind}:${c.period}:${c.state}`),
    ).toEqual(['query:last_month:open']);
  });

  it('a G-61 retired question is still closed by "no" while a continuation is open', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61no-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    await say('wamid.B6-g61no-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    await reply('wamid.B6-g61no-no', 'no');
    expect(stubSender.lastText).toBe(replies.cancelled().text);
    expect((await draftStates(business.id))[0]).toBe('RecordPurchase:superseded');
    /* Closed for good: a later yes does not ask it again. */
    await reply('wamid.B6-g61no-yes', 'yes');
    expect(stubSender.lastText).not.toContain('did it come from your bank account');
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
  });

  it('a G-61 retired purchase question stays retired, and "bank" never records the purchase', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-g61-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-g61-pos', POS_PURCHASE, 'I bought 10 cartons for 100k, paid by POS');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect(await draftStates(business.id)).toEqual([
      'Query:superseded',
      'RecordPurchase:abandoned',
    ]);
    /* The period question did not survive the purchase; the funding
     * question it asked is now the open one (G-68 Phase 2). */
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded', 'open']);

    /* A yes still asks the retired question again (G-61), unchanged. */
    await reply('wamid.B6-g61-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    expect((await draftStates(business.id))[1]).toBe('RecordPurchase:abandoned');

    /* "bank" answers the open funding question (G-68 Phase 2, the work
     * Build 6 left for it): a FRESH preview of the rebuilt purchase, no
     * model, and never the old purchase executed. Nothing is written
     * until a normal yes. */
    await reply('wamid.B6-g61-bank', 'bank');
    expect(modelCalls()).toBe(0);
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    expect(await footprint(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    /* Answered once: the retired question is closed by its rebuild. */
    expect((await draftStates(business.id))[1]).toBe('RecordPurchase:superseded');
    expect((await draftStates(business.id))[2]).toBe('RecordPurchase:pending');
  });

  it('a question between the two erasure asks breaks the pair: nothing is erased', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-b6-erase' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await reply('wamid.B6-del1', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    /* Anything in between keeps the data, a question to the books included. */
    await say('wamid.B6-del-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    /* Inside the window, but no longer the second of a pair: a new first ask. */
    await reply('wamid.B6-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
  });

  it('a correction after only a question is a new request, not a correction', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-corr-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    await say('wamid.B6-corr-sale', A_SALE, 'sorry, 3 wigs not 4');

    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    /* The question's draft was not superseded as if it had been corrected. */
    expect(await draftStates(business.id)).toEqual(['Query:pending', 'RecordSale:pending']);
  });

  /* ---- Build 6 final-head round 3 ---- */

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
  }

  it("a member's resumed read stands between a preview and a later yes, like any question", async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);

    await say('wamid.B6-x-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', OWNER);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await say('wamid.B6-x-sale', A_SALE, 'sold Ada 3 wigs for 300k', DELEGATE);
    /* The owner's "last month" resumes the owner's question, answered from
     * SQL, with the delegate's preview older than it. */
    await reply('wamid.B6-x-answer', 'last month', OWNER);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);

    /* "correct" is about the figure just read, never the older preview. */
    await reply('wamid.B6-x-correct', 'correct', OWNER);
    expect(stubSender.lastText).toBe(BEHIND);
    expect(await footprint(business.id)).toMatchObject({ invoices: 0, postings: 0 });
    expect((await draftStates(business.id))[1]).toBe('RecordSale:pending');
  });

  it("a member's resumed read between the two erasure asks breaks the pair: nothing is erased", async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T8',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-b6-erase-x' }],
    );
    const facets = () =>
      withBusiness(db, business.id, (tx) =>
        customersRepo.identityFacetsFor(tx, business.id, customer.id),
      );

    await say('wamid.B6-xd-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', DELEGATE);
    expect(stubSender.lastText).toBe(WHICH_PERIOD);
    await reply('wamid.B6-xd-del1', 'delete my data', OWNER);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await reply('wamid.B6-xd-answer', 'last month', DELEGATE);
    expect(stubSender.lastText).toContain('sales');
    expect(modelCalls()).toBe(0);

    await reply('wamid.B6-xd-del2', 'delete my data', OWNER);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    expect(await facets()).toHaveLength(1);
  });

  it('a junk photo after "Which period?" retires the question', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-j-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    stubSender.media.set('photo-1', {
      bytes: Buffer.from('JFIF-fake-photo'),
      mimeType: 'image/jpeg',
    });
    stubOcr.answerWith({ text: 'when the beat drops and nobody is ready', confidence: 0.9 });
    stubTransport.script({
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    });
    const photo = messagePayload(OWNER, 'wamid.B6-j-photo', '');
    const sent = photo.entry[0]!.changes[0]!.value.messages[0]! as Record<string, unknown>;
    delete sent['text'];
    sent['type'] = 'image';
    sent['image'] = { id: 'photo-1', mime_type: 'image/jpeg' };
    await post(photo);
    await drain();
    expect(stubSender.lastText).toBe(replies.notABusinessDocument().text);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    /* "last month" now answers nothing: the newest thing said was the photo. */
    await reply('wamid.B6-j-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  /** An inbound message of another kind, on the same envelope as a text. */
  function mediaMessage(wamid: string, fields: Record<string, unknown>, from = OWNER) {
    const payload = messagePayload(from, wamid, '');
    const sent = payload.entry[0]!.changes[0]!.value.messages[0]! as Record<string, unknown>;
    delete sent['text'];
    Object.assign(sent, fields);
    return payload;
  }

  it.each([
    {
      name: 'a voice note that could not be transcribed',
      arrange: () => {
        const page = Buffer.alloc(28);
        page.write('OggS', 0, 'ascii');
        page.writeBigUInt64LE(BigInt(5 * 48_000), 6);
        page.writeUInt32LE(1, 14);
        page.writeUInt8(1, 26);
        stubSender.media.set('media-1', { bytes: page, mimeType: 'audio/ogg' });
        stubStt.failWith();
      },
      fields: { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg', voice: true } },
      answer: 'could not listen to that voice note',
    },
    {
      name: 'unsupported media',
      arrange: () => undefined,
      fields: { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } },
      answer: replies.onlyText().text,
    },
    {
      name: 'a photo that could not be read',
      arrange: () => {
        stubSender.media.set('photo-1', {
          bytes: Buffer.from('JFIF-fake-photo'),
          mimeType: 'image/jpeg',
        });
        stubOcr.failWith();
      },
      fields: { type: 'image', image: { id: 'photo-1', mime_type: 'image/jpeg' } },
      answer: null,
    },
  ])('$name after "Which period?" retires the question', async ({ arrange, fields, answer }) => {
    const business = await seedMerchant();
    await say('wamid.B6-ee-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect(stubSender.lastText).toBe(WHICH_PERIOD);

    arrange();
    await post(mediaMessage('wamid.B6-ee-media', fields));
    await drain();
    if (answer) expect(stubSender.lastText).toContain(answer);
    expect(stubSender.lastText).not.toBe(WHICH_PERIOD);
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);

    await reply('wamid.B6-ee-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('a question or an answer that was never delivered is not continued', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);

    /* "Which period?" never reached the merchant. */
    stubSender.failWith();
    await say('wamid.B6-f1-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    await reply('wamid.B6-f1-late', 'last month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);

    /* Nor did the resumed answer: there is no read to follow up. */
    await say('wamid.B6-f2-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
    stubSender.failWith();
    await reply('wamid.B6-f2-answer', 'last month');
    expect(modelCalls()).toBe(0);
    expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
      'clarification:superseded',
      'clarification:consumed',
      'query:superseded',
    ]);
    await reply('wamid.B6-f2-follow', 'what about this month');
    expect(modelCalls()).toBeGreaterThan(0);
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
  });

  it('a "no" after nothing but a question cancels nothing and says it cancelled nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.B6-no-ask', THIS_MONTH, 'How much did I sell this month?');
    const sentBefore = stubSender.sent.length;

    await reply('wamid.B6-no', 'no');
    /* What a "no" with nothing waiting gets: no "Cancelled", and since G-68
     * no silence either, but the truthful nothing-to-decline reply. */
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text)).not.toContain(
      replies.cancelled().text,
    );
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text)).toEqual([
      replies.nothingToDecline().text,
    ]);
    /* The read is still dropped, as every pending draft is. */
    expect(await draftStates(business.id)).toEqual(['Query:superseded']);
  });

  it("a question's draft never keeps the merchant's words for the window", async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-pt',
      { ...HOW_MUCH_DID_I_SELL, period: 'custom', periodText: 'the month I sold to Ada' },
      'sales in the month I sold to Ada',
    );
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown> }>(sql`
        SELECT command FROM command_drafts WHERE business_id = ${business.id}::uuid`),
    );
    const stored = [...rows].map((r) => r.command);
    expect(stored).toHaveLength(1);
    expect(stored[0]!['periodText']).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('Ada');
  });

  it('a named window with words that draw a different window, or none, is asked about', async () => {
    const business = await seedMerchant();
    const { lastMonthLabel } = await seedTwoMonths(business.id);
    const asked = async (wamid: string, period: string, periodText: string) => {
      await say(wamid, { ...HOW_MUCH_DID_I_SELL, period, periodText }, `sales ${periodText}`);
      return stubSender.lastText;
    };

    /* Words core cannot draw: said so, never answered for the named window. */
    expect(await asked('wamid.B6-t7-1', 'month', 'yesterday')).toBe(NOT_COUNTABLE);
    expect(await asked('wamid.B6-t7-2', 'today', 'yesterday')).toBe(NOT_COUNTABLE);
    expect(await asked('wamid.B6-t7-3', 'week', 'last week')).toBe(NOT_COUNTABLE);
    /* Words that draw another window: asked. */
    expect(await asked('wamid.B6-t7-4', 'month', 'last month')).toBe(WHICH_PERIOD);
    /* Words that draw the same window: answered. */
    expect(await asked('wamid.B6-t7-5', 'month', 'this month')).toContain('₦40,000');

    /* The question stays open: "last month" resumes it. */
    await asked('wamid.B6-t7-6', 'month', 'yesterday');
    await reply('wamid.B6-t7-answer', 'last month');
    expect(stubSender.lastText).toContain(`${lastMonthLabel}: ₦150,000`);
    expect(modelCalls()).toBe(0);
  });

  it('a yes behind a question Rekoda asked is never told a preview is waiting', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-uq-half',
      { intent: 'Unclear', clarification: 'How much did she pay?' },
      'she paid half',
    );
    await say('wamid.B6-uq-ask', THIS_MONTH, 'How much did I sell this month?');
    expect(stubSender.lastText).toContain('sales');

    await reply('wamid.B6-uq-yes', 'yes');
    expect(stubSender.lastText).not.toBe(BEHIND);
    expect(stubSender.lastText).not.toContain('preview');
    expect(await footprint(business.id)).toMatchObject({
      invoices: 0,
      payments: 0,
      expenses: 0,
      postings: 0,
    });
    /* As before Build 6: the yes was about the newest thing, the question. */
    expect(await draftStates(business.id)).toEqual(['Unclear:pending', 'Query:confirmed']);
  });

  it('a yes behind a parked erasure ask and a question is not pointed at a preview', async () => {
    const business = await seedMerchant();
    await reply('wamid.B6-ue-del1', 'delete my data');
    await say('wamid.B6-ue-ask', THIS_MONTH, 'How much did I sell this month?');

    await reply('wamid.B6-ue-yes', 'yes');
    expect(stubSender.lastText).not.toBe(BEHIND);
    expect(await draftStates(business.id)).toEqual(['EraseData:pending', 'Query:confirmed']);
  });

  it('logs no message text on the continuation path', async () => {
    const business = await seedMerchant();
    await seedTwoMonths(business.id);
    const spies = (['log', 'debug', 'verbose', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    try {
      await say('wamid.B6-log-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.B6-log-answer', 'Last month please');
      await reply('wamid.B6-log-follow', 'what about this month');
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map((arg) => String(arg)));
      /* Positive control: the spies did capture the handler's own lines. */
      expect(logged.some((line) => line.includes('answered an inbound message'))).toBe(true);
      for (const words of ['How much did I sell', 'Last month please', 'what about this month']) {
        expect(logged.some((line) => line.includes(words))).toBe(false);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('keeps a customer as a vault token, never a name', async () => {
    const business = await seedMerchant();
    await say(
      'wamid.B6-pii',
      {
        ...HOW_MUCH_DID_I_SELL,
        topic: 'customer_balance',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      },
      'how much does Ada owe me',
    );

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ row: string }>(sql`
        SELECT row_to_json(c)::text AS row FROM conversation_continuations c
         WHERE business_id = ${business.id}::uuid`),
    );
    const stored = [...rows].map((r) => r.row);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('CUSTOMER_7K2');
    expect(stored[0]).not.toContain('Ada');
    expect(stored[0]).not.toContain('owe');
  });
});

/**
 * Nigerian and chat routing correctness (G-68, G-24; OWN-18).
 *
 * Standard English, Nigerian English, Nigerian Pidgin and code-switching are
 * first-class merchant registers, and every one of them converges on the
 * SAME confirmation, expiry, consent, cost and privacy rules. These run the
 * whole webhook-to-reply path, so "the router said affirm" is checked as
 * "the yes did what a yes does", and "no model" as zero transport requests
 * and zero AI_ACTIONS.
 */
describe('Nigerian and chat routing (G-68, G-24)', () => {
  const PHONE = '+2348031234567';
  const WA = '2348031234567';
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 100_000 }],
    statedTotal: 300_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const AN_EXPENSE = {
    intent: 'RecordExpense',
    description: 'fuel for generator',
    amount: 20_000,
    category: 'utilities',
    paymentMethod: 'cash',
  };
  const A_POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';
  const EXPIRED = replies.draftExpired().text;
  const NOTHING_TO_DECLINE = replies.nothingToDecline().text;

  async function seedMerchant() {
    const user = await identity.upsertUserByPhone(db, PHONE);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload(WA, wamid, text));
    await drain();
  }

  async function plain(wamid: string, text: string) {
    await post(messagePayload(WA, wamid, text));
    await drain();
  }

  const lapse = (businessId: string, where = sql`state = 'pending'`) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND ${where}`),
    );

  async function states(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function aiActions(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0;
  }

  async function lastInboundBody(businessId: string): Promise<string | null> {
    const messages = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    const inbound = messages.filter((m) => m.direction === 'inbound');
    return inbound[inbound.length - 1]?.body ?? null;
  }

  describe('a bare "no" with nothing waiting is answered, never silent (G-68)', () => {
    it.each(['no', 'nope', 'nah', 'no be so', 'e no correct'])(
      '%j gets a truthful reply, no model, no unit, no fake cancellation',
      async (text) => {
        const business = await seedMerchant();
        await plain(`wamid.G68-bare-${text}`, text);

        expect(stubSender.sent).toHaveLength(1);
        expect(stubSender.lastText).toBe(NOTHING_TO_DECLINE);
        expect(stubSender.lastText).not.toBe(replies.cancelled().text);
        expect(stubTransport.requests).toHaveLength(0);
        expect(await aiActions(business.id)).toBe(0);
        /* Routed locally: stored as its classification, never tokenised. */
        expect(await lastInboundBody(business.id)).toBe('[deny]');
        expect(await states(business.id)).toEqual([]);
      },
    );

    it.each([
      'cancel',
      'forget it',
      'forget am',
      'leave am',
      'no do am',
      'make we leave am',
      'cancel am',
    ])('%j with nothing waiting says so, and never "Cancelled"', async (text) => {
      const business = await seedMerchant();
      await plain(`wamid.G68-cancel-${text}`, text);
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(stubSender.lastText).not.toBe(replies.cancelled().text);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);
      expect(await lastInboundBody(business.id)).toBe('[cancel]');
    });

    it('"forget am" after a confirmed invoice is not told the invoice was cancelled', async () => {
      const business = await seedMerchant();
      await say('wamid.G68-void', A_SALE, 'sold Ada 3 wigs for 300k');
      await plain('wamid.G68-void-yes', 'na so');
      expect((await written(business.id)).invoices).toBe(1);

      await plain('wamid.G68-void-forget', 'forget am');
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(stubSender.lastText).not.toMatch(/^Cancelled/);
      /* The invoice is exactly as it was. */
      expect((await written(business.id)).invoices).toBe(1);
      expect(await states(business.id)).toEqual(['confirmed']);
    });

    it('a "no" to a live preview still cancels it, in either register', async () => {
      for (const [i, text] of ['no', 'no be so'].entries()) {
        const business = await seedMerchant();
        await say(`wamid.G68-live-${i}`, A_SALE, 'sold Ada 3 wigs for 300k');
        expect(stubSender.lastText).toContain('Please check this before I save it');
        await plain(`wamid.G68-live-${i}-no`, text);
        expect(stubSender.lastText).toBe(replies.cancelled().text);
        expect(await states(business.id)).toEqual(['superseded']);
        /* And the yes that follows confirms nothing. */
        await plain(`wamid.G68-live-${i}-yes`, 'na so');
        expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
        expect((await written(business.id)).invoices).toBe(0);
        await truncateAll(urls);
        stubSender.reset();
      }
    });
  });

  describe('"na so" confirms exactly what "yes" confirms (G-68)', () => {
    it.each([
      'na so',
      'Na So',
      'NA SO',
      'na so!',
      'na so 👍',
      'na so o',
      'e correct',
      'e correct o',
      'oya yes',
      'oya',
    ])('%j confirms the live preview, once', async (text) => {
      const business = await seedMerchant();
      await say('wamid.G68-affirm', A_SALE, 'sold Ada 3 wigs for 300k');
      const requestsAfterPreview = stubTransport.requests.length;
      const unitsAfterPreview = await aiActions(business.id);
      /* Positive control: the preview DID reach the model and DID spend a
       * unit, so the "unchanged" assertions below can fail. */
      expect(requestsAfterPreview).toBe(1);
      expect(unitsAfterPreview).toBe(1);

      await plain('wamid.G68-affirm-yes', text);
      expect(await written(business.id)).toMatchObject({ invoices: 1 });
      expect(await states(business.id)).toEqual(['confirmed']);
      /* The confirmation itself reached no model and spent no AI unit. */
      expect(stubTransport.requests.length).toBe(requestsAfterPreview);
      expect(await aiActions(business.id)).toBe(unitsAfterPreview);
      expect(await lastInboundBody(business.id)).toBe('[affirm]');
    });

    it('a qualified "na so" is a correction for the model, never a bare yes', async () => {
      const business = await seedMerchant();
      await say('wamid.G68-q', A_SALE, 'sold Ada 3 wigs for 300k');
      const requestsAfterPreview = stubTransport.requests.length;
      stubTransport.replyWith({ intent: 'Unclear', clarification: 'How much for each wig?' });
      await plain('wamid.G68-q-but', 'na so but change am to 40k');
      expect(stubTransport.requests.length).toBe(requestsAfterPreview + 1);
      expect((await written(business.id)).invoices).toBe(0);
    });
  });

  describe('Pidgin cannot bypass draft expiry (G-23)', () => {
    it.each(['yes', 'na so', 'oya'])(
      'an expired preview and %j: nothing executes, nothing is charged',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.G68-exp', A_SALE, 'sold Ada 3 wigs for 300k');
        const requestsAfterPreview = stubTransport.requests.length;
        const unitsAfterPreview = await aiActions(business.id);
        expect(unitsAfterPreview).toBe(1);
        await lapse(business.id);
        await plain('wamid.G68-exp-yes', text);
        expect(stubSender.lastText).toBe(EXPIRED);
        expect(stubTransport.requests.length).toBe(requestsAfterPreview);
        expect(await aiActions(business.id)).toBe(unitsAfterPreview);
        expect(await written(business.id)).toMatchObject({ invoices: 0, postings: 0 });
        expect(await states(business.id)).toEqual(['expired']);
      },
    );

    it.each(['no', 'no be so'])(
      'an expired preview and %j: no resurrection, and the older preview is untouched',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.G68-n1', A_SALE, 'sold Ada 3 wigs for 300k');
        await say('wamid.G68-n2', AN_EXPENSE, 'bought fuel 20k cash');
        await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`
            UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordExpense'`),
        );
        await plain('wamid.G68-n-no', text);
        expect(stubSender.lastText).toBe(replies.expiredNothingToCancel().text);
        expect(await states(business.id)).toEqual(['pending', 'expired']);
        expect(await written(business.id)).toMatchObject({ invoices: 0, expenses: 0 });
      },
    );
  });

  describe('a retired G-61 funding question is asked again, in any register', () => {
    it.each(['yes', 'na so', 'oya'])(
      '%j re-asks the POS question and records nothing',
      async (text) => {
        const business = await seedMerchant();
        await say(
          'wamid.G68-pos',
          A_POS_PURCHASE,
          'I bought 10 cartons for 180k from Emeka, paid by POS',
        );
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await states(business.id)).toEqual(['abandoned']);

        await plain('wamid.G68-pos-yes', text);
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await states(business.id)).toEqual(['abandoned']);
        expect(await written(business.id)).toMatchObject({ expenses: 0, postings: 0 });
      },
    );
  });

  describe('a retired G-61 funding question is closed by "no", in either register', () => {
    it.each(['no', 'no be so'])('%j closes the POS question for good', async (text) => {
      const business = await seedMerchant();
      await say(
        'wamid.G68-pos-no',
        A_POS_PURCHASE,
        'I bought 10 cartons for 180k from Emeka, paid by POS',
      );
      expect(stubSender.lastText).toContain(POS_QUESTION);

      await plain('wamid.G68-pos-no-no', text);
      expect(stubSender.lastText).toBe(replies.cancelled().text);
      await plain('wamid.G68-pos-no-yes', 'na so');
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(await states(business.id)).not.toContain('abandoned');
      expect(await written(business.id)).toMatchObject({ expenses: 0, postings: 0 });
    });
  });

  describe('deterministic Pidgin costs what deterministic English costs: nothing', () => {
    it('answers each twin identically, with no model call and no AI unit, routed locally', async () => {
      const business = await seedMerchant();
      const twins: ReadonlyArray<readonly [string, string]> = [
        ['how does this work', 'how e dey work'],
        ['who owes me', 'who dey owe me'],
        ['what is left', 'wetin remain'],
        ['send it again', 'send am again'],
        ['i want to upgrade', 'I wan upgrade'],
        ['show me my books', 'make I see my books'],
        ['forget it', 'forget am'],
      ];
      for (const [i, [english, pidgin]] of twins.entries()) {
        await plain(`wamid.G68-en-${i}`, english);
        const englishReply = stubSender.lastText;
        const englishBody = await lastInboundBody(business.id);
        await plain(`wamid.G68-pcm-${i}`, pidgin);
        /* Routed locally, both: stored as a classification, never tokenised. */
        expect(englishBody).toMatch(/^\[[a-z_]+\]$/);
        /* The dashboard link is minted per ask, so compare its shape. */
        if (englishBody === '[dashboard]') {
          expect(await lastInboundBody(business.id)).toBe('[dashboard]');
        } else {
          expect(stubSender.lastText).toBe(englishReply);
          expect(await lastInboundBody(business.id)).toBe(englishBody);
        }
      }
      expect(stubSender.sent).toHaveLength(twins.length * 2);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);

      /* Positive control: one model-path message does reach the transport,
       * is tokenised, and spends a unit, so the zeros above can fail. */
      stubTransport.replyWith({ intent: 'Unclear', clarification: 'How many wigs?' });
      await plain('wamid.G68-control', 'Ada bought wigs');
      /* An unclear message may escalate, so at least one request, one unit. */
      expect(stubTransport.requests.length).toBeGreaterThan(0);
      expect(await aiActions(business.id)).toBe(1);
      expect(await lastInboundBody(business.id)).not.toMatch(/^\[[a-z_]+\]$/);
    });
  });

  describe('STOP and START change consent only when the message IS the command (G-24)', () => {
    it.each([
      'STOP',
      'stop',
      'stop!',
      'unsubscribe',
      'quit',
      'STOP,',
      'stop?',
      '"STOP"',
      'STOP 🙏🏾🙏🏾🙏🏾',
      '*STOP*',
      '🛑STOP🛑',
      'STOP STOP',
      'stop!!! stop!!!',
      'STOP/',
      'STOP#',
      'STOP 1\uFE0F\u20E3',
      'STOP \u2116',
    ])('%j opts the merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G24-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(stubTransport.requests).toHaveLength(0);
    });

    it.each([
      'START',
      'start',
      'start!',
      'unstop',
      'subscribe',
      'START 🇳🇬',
      'START 👍',
      'start ✅🙏🏾',
    ])('%j opts the merchant back in', async (text) => {
      await seedMerchant();
      await identity.setOptOut(db, PHONE, new Date());
      await plain('wamid.G24-start', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
      expect(stubTransport.requests).toHaveLength(0);
    });

    it.each([
      'start the generator',
      'start generator',
      'start recording another sale',
      '-----start-----',
      'start?',
      '"start"',
      'START ❓',
      'start 🛑',
      'start 👎',
      'START\v!',
      'START\f!',
      `${'-'.repeat(400)} start ${'-'.repeat(400)}`,
    ])('%j does not re-subscribe an opted-out merchant', async (text) => {
      await seedMerchant();
      const at = new Date('2026-09-30T08:00:00Z');
      await identity.setOptOut(db, PHONE, at);
      await plain('wamid.G24-not-start', text);
      expect(await identity.optedOutAt(db, PHONE)).toEqual(at);
    });

    it.each([
      'stop by my shop tomorrow',
      'stop by my shop',
      'please stop sending invoices to Ada',
      '-----stop-----',
      `${'-'.repeat(400)} unsubscribe ${'-'.repeat(400)}`,
      `stop${'-'.repeat(400)}`,
      `STOP${'!'.repeat(2000)}`,
    ])('%j does not opt a merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G24-not-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
    });
  });

  /* G-80: a natural Nigerian opt-out is a typed STOP, from a closed list,
   * heard with no model and no AI action. */
  describe('a natural Nigerian opt-out is heard as STOP (G-80)', () => {
    it.each([
      'abeg stop',
      'no send me again',
      'stop abeg',
      'abeg stop am',
      'abeg no send me again',
      'please stop',
      'stop o',
      'stop na',
      'make una stop',
      'stop sending me messages',
    ])('%j opts the merchant out, exactly as STOP does', async (text) => {
      const business = await seedMerchant();
      await plain('wamid.G80-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      // The opt-out reply is unchanged: the copy a typed STOP gets.
      expect(stubSender.lastText).toBe(replies.optedOut().text);
      expect(stubTransport.requests).toHaveLength(0);
      expect(await aiActions(business.id)).toBe(0);
      // Stored as what it was, not what it said, like any deterministic message.
      expect(await lastInboundBody(business.id)).toBe('[stop]');
    });

    it('a natural opt-out is honoured while a preview is waiting, and leaves it unconfirmed', async () => {
      const business = await seedMerchant();
      await say('wamid.G80-sale', A_SALE, 'Ada bought 3 wigs 300k');
      const requests = stubTransport.requests.length;
      await plain('wamid.G80-abeg', 'abeg stop');
      expect(await identity.optedOutAt(db, PHONE)).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(requests);
      expect((await written(business.id)).invoices).toBe(0);
      expect(await states(business.id)).not.toContain('confirmed');
    });

    it.each([
      'stop by my shop',
      'stop payment on invoice INV-1',
      'I told him to stop',
      "don't stop sending receipts",
      'how do I stop an invoice?',
      'stop the sale',
      'abeg stop the sale',
      'stop am for Ada account',
      'no send Ada invoice again',
      'abeg send me again',
      'abeg stop?',
      `${'-'.repeat(400)} abeg stop ${'-'.repeat(400)}`,
      'abeg stop\nI will pay tomorrow',
      "don't send me again",
      'stop ehn',
      'abeg stop, I want to check something',
      'customer said abeg stop',
    ])('%j does not opt a merchant out', async (text) => {
      await seedMerchant();
      await plain('wamid.G80-not-stop', text);
      expect(await identity.optedOutAt(db, PHONE)).toBeNull();
    });

    it.each(['abeg start', 'please start', 'start o'])(
      '%j does not re-subscribe an opted-out merchant: START gains nothing',
      async (text) => {
        await seedMerchant();
        const at = new Date('2026-09-30T08:00:00Z');
        await identity.setOptOut(db, PHONE, at);
        await plain('wamid.G80-not-start', text);
        expect(await identity.optedOutAt(db, PHONE)).toEqual(at);
      },
    );
  });
});

/**
 * G-68 Phase 2: Nigerian and Pidgin answers through Build 6's typed
 * continuation state, and nothing else. A short reply continues only what
 * Rekoda asked THIS member, while it is open, and only with the kind of
 * answer the stored question expects. No fuzzy memory: with nothing
 * compatible open, the reply is understood exactly as it would have been.
 */
describe('Nigerian and Pidgin answers continue what was asked (G-68 Phase 2)', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const WHICH_PERIOD = replies.whichPeriod('sales').text;
  const STRAY = replies.strayNumber().text;
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const HOW_MUCH_DID_I_SELL = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  /** A message the model would read as unclear, if it ever reached it. */
  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  const modelCalls = () => stubTransport.requests.length;

  async function aiActions(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    return rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0;
  }

  async function continuations(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ kind: string; expects: string | null; state: string; draft_id: string | null }>(
        sql`
        SELECT kind, expects, state, draft_id FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`,
      ),
    );
    return [...rows];
  }

  async function draftStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string; intent: string }>(sql`
        SELECT state, intent FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => `${r.intent}:${r.state}`);
  }

  const purchaseStates = async (businessId: string) =>
    (await draftStates(businessId)).filter((d) => d.startsWith('RecordPurchase'));

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals
        `),
      )),
    ];
    return row!;
  }

  /** Net movement per account code, from the ledger. */
  async function nets(businessId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    for (const e of entries) out[e.account] = (out[e.account] ?? 0) + e.debitK - e.creditK;
    return out;
  }

  async function lastInboundBody(businessId: string): Promise<string | null> {
    const messages = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.messagesFor(tx, businessId),
    );
    const inbound = messages.filter((m) => m.direction === 'inbound');
    return inbound[inbound.length - 1]?.body ?? null;
  }

  /**
   * G-80: a natural opt-out while something is waiting takes EXACTLY the
   * typed STOP's path. Two merchants, one sends STOP and the other a natural
   * form, and everything they leave behind must match: never an answer to
   * the open question, never a yes to the preview, no model, no AI action.
   */
  describe('a natural opt-out while something is waiting is a typed STOP (G-80)', () => {
    const TYPED = '2348039990011';
    const NATURAL = '2348039990012';

    async function aftermath(businessId: string, phone: string) {
      return {
        optedOut: (await identity.optedOutAt(db, `+${phone}`)) !== null,
        drafts: await draftStates(businessId),
        continuations: (await continuations(businessId)).map((c) => `${c.kind}:${c.state}`),
        written: await written(businessId),
        aiActions: await aiActions(businessId),
      };
    }

    it.each(['abeg stop', 'no send me again', 'stop o', 'abeg stop am'])(
      'with a purchase preview waiting, %j does what STOP does and confirms nothing',
      async (text) => {
        const cash = { ...POS_PURCHASE, paymentMethod: 'cash' };
        const typed = await seedMerchant(`+${TYPED}`);
        const natural = await seedMerchant(`+${NATURAL}`);
        await say('wamid.G80-p-typed', cash, 'bought 10 cartons 180k cash', TYPED);
        await say('wamid.G80-p-natural', cash, 'bought 10 cartons 180k cash', NATURAL);
        await reply('wamid.G80-p-typed-stop', 'STOP', TYPED);
        expect(stubSender.lastText).toBe(replies.optedOut().text);
        await reply('wamid.G80-p-natural-stop', text, NATURAL);
        expect(stubSender.lastText).toBe(replies.optedOut().text);

        /* `reply` resets the stub's request log: the natural reply made none. */
        expect(modelCalls()).toBe(0);
        const a = await aftermath(typed.id, TYPED);
        const b = await aftermath(natural.id, NATURAL);
        expect(b).toEqual(a);
        expect(b.optedOut).toBe(true);
        expect(b.drafts.some((d) => d.endsWith(':confirmed'))).toBe(false);
        expect(b.written.purchases).toBe(0);
      },
    );

    it.each(['abeg stop', 'stop abeg'])(
      'with "Which period?" open, %j does what STOP does and is not taken as an answer',
      async (text) => {
        const typed = await seedMerchant(`+${TYPED}`);
        const natural = await seedMerchant(`+${NATURAL}`);
        await say('wamid.G80-q-typed', HOW_MUCH_DID_I_SELL, 'How much did I sell?', TYPED);
        expect(stubSender.lastText).toBe(WHICH_PERIOD);
        await say('wamid.G80-q-natural', HOW_MUCH_DID_I_SELL, 'How much did I sell?', NATURAL);
        expect(stubSender.lastText).toBe(WHICH_PERIOD);
        await reply('wamid.G80-q-typed-stop', 'STOP', TYPED);
        await reply('wamid.G80-q-natural-stop', text, NATURAL);
        expect(stubSender.lastText).toBe(replies.optedOut().text);

        /* `reply` resets the stub's request log: the natural reply made none. */
        expect(modelCalls()).toBe(0);
        const b = await aftermath(natural.id, NATURAL);
        expect(b).toEqual(await aftermath(typed.id, TYPED));
        expect(b.optedOut).toBe(true);
      },
    );

    it('with the funding question open, "abeg stop" does what STOP does and rebuilds nothing', async () => {
      const typed = await seedMerchant(`+${TYPED}`);
      const natural = await seedMerchant(`+${NATURAL}`);
      await say('wamid.G80-f-typed', POS_PURCHASE, 'bought 10 cartons 180k POS', TYPED);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await say('wamid.G80-f-natural', POS_PURCHASE, 'bought 10 cartons 180k POS', NATURAL);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.G80-f-typed-stop', 'STOP', TYPED);
      await reply('wamid.G80-f-natural-stop', 'abeg stop', NATURAL);
      expect(stubSender.lastText).toBe(replies.optedOut().text);

      /* `reply` resets the stub's request log: the natural reply made none. */
      expect(modelCalls()).toBe(0);
      const b = await aftermath(natural.id, NATURAL);
      expect(b).toEqual(await aftermath(typed.id, TYPED));
      expect(b.optedOut).toBe(true);
      expect(b.written.purchases).toBe(0);
    });
  });

  describe('A. a period answer resumes "Which period?", in either register', () => {
    it.each([
      'last month o',
      'na last month',
      'dis month',
      'this month so far',
      'the month wey pass',
    ])('%j answers the open question with no model', async (text) => {
      const business = await seedMerchant();
      await say('wamid.P2-a-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      expect(stubSender.lastText).toBe(WHICH_PERIOD);

      await reply('wamid.P2-a-answer', text);
      expect(stubSender.lastText).toMatch(/invoiced|any sales/);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => `${c.kind}:${c.state}`)).toEqual([
        'clarification:consumed',
        'query:open',
      ]);
    });

    it('"last month" with nothing compatible open attaches to nothing', async () => {
      await seedMerchant();
      await reply('wamid.P2-a-none', 'last month o');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    });

    it('"today today" is an urgency idiom, never a window', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-tt-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-a-tt', 'today today');
      expect(modelCalls()).toBeGreaterThan(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('a window Rekoda cannot count keeps "Which period?" open, and the next answer resumes it', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-y-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');

      await reply('wamid.P2-a-y', 'yesterday o');
      expect(stubSender.lastText).toBe(replies.periodNotCountable('sales').text);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);

      await reply('wamid.P2-a-y-2', 'dis month');
      expect(stubSender.lastText).toMatch(/invoiced|any sales/);
      expect(modelCalls()).toBe(0);
    });

    it('a new command after the question routes normally, and the question is gone', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-a-n-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-a-n', 'wetin remain');
      expect(stubSender.lastText).toContain('You are not counting any stock yet');
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });
  });

  describe('B. "2" means option 2 only of an open list shown to this member', () => {
    async function openList(businessId: string, phone = `+${OWNER}`, now?: Date) {
      const user = await identity.upsertUserByPhone(db, phone);
      return withBusiness(db, businessId, async (tx) => {
        const thread = await conversationsRepo.recordInbound(
          tx,
          {
            businessId,
            channel: 'meta',
            kind: 'text',
            body: '[list]',
            providerMessageId: `wamid.list-${phone}-${String(now?.getTime() ?? 0)}`,
          },
          { kind: 'MERCHANT', businessId, channel: 'meta' },
        );
        return continuationsRepo.openContinuation(tx, {
          businessId,
          userId: user.id,
          sourceMessageId: thread.id,
          state: {
            kind: 'clarification',
            expects: 'choice',
            topic: 'debtors',
            options: [
              { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
              { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000002' } },
            ],
          },
          ...(now ? { now } : {}),
        });
      });
    }

    it('names option 2 and CONSUMES the list (never merely superseded)', async () => {
      const business = await seedMerchant();
      await openList(business.id);
      await reply('wamid.P2-b-2', '2');
      expect(stubSender.lastText).toBe(replies.optionChosen('INV-2026-000002').text);
      expect(modelCalls()).toBe(0);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['consumed']);
    });

    it('a number the list did not show is stray, and retires the list', async () => {
      const business = await seedMerchant();
      await openList(business.id);
      await reply('wamid.P2-b-7', '7');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('another member\'s "2" is stray, and the list stays the owner\'s', async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await openList(business.id);
      await reply('wamid.P2-b-d', '2', DELEGATE);
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);
    });

    it('an expired list is gone: "2" is stray', async () => {
      const business = await seedMerchant();
      await openList(business.id, `+${OWNER}`, new Date(Date.now() - 3_600_000));
      await reply('wamid.P2-b-e', '2');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
    });

    it('"2" while a period is expected is stray (Build 6, unchanged)', async () => {
      const business = await seedMerchant();
      await say('wamid.P2-b-p-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.P2-b-p', '2');
      expect(stubSender.lastText).toBe(STRAY);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });
  });

  describe('E. the G-61 funding question answered with a short "bank" or "cash"', () => {
    async function askFunding(businessId: string) {
      await say(
        'wamid.P2-e-ask',
        POS_PURCHASE,
        'I bought stock and paid with POS: 10 cartons for 180k from Emeka',
      );
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(businessId)).toEqual(['RecordPurchase:abandoned']);
      const [open] = await continuations(businessId);
      expect(open).toMatchObject({
        kind: 'clarification',
        expects: 'funding_source',
        state: 'open',
      });
      expect(open!.draft_id).not.toBeNull();
    }

    it.each([
      ['bank', 'transfer', 'BANK'],
      ['na bank o', 'transfer', 'BANK'],
      ['from my bank account', 'transfer', 'BANK'],
      ['cash', 'cash', 'CASH'],
      ['na cash', 'cash', 'CASH'],
    ])(
      '%j shows a FRESH preview by %s, writes nothing, and only the next yes records it',
      async (answer, method, account) => {
        const business = await seedMerchant();
        await askFunding(business.id);
        const unitsAfterQuestion = await aiActions(business.id);
        expect(unitsAfterQuestion).toBe(1);

        await reply('wamid.P2-e-answer', answer);
        expect(stubSender.lastText).toContain('Please check this before I save it');
        expect(stubSender.lastText).toContain(`Paid in full by ${method}`);
        /* No model, no unit, nothing written: only a fresh draft to confirm. */
        expect(modelCalls()).toBe(0);
        expect(await aiActions(business.id)).toBe(unitsAfterQuestion);
        expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
        /* The question is answered ONCE: closed by its rebuild. */
        expect(await draftStates(business.id)).toEqual([
          'RecordPurchase:superseded',
          'RecordPurchase:pending',
        ]);
        expect((await continuations(business.id)).map((c) => c.state)).toEqual(['consumed']);

        /* The normal yes, in either register, records the REBUILT purchase once. */
        await reply('wamid.P2-e-yes', 'na so');
        await reply('wamid.P2-e-yes-2', 'yes');
        expect((await written(business.id)).purchases).toBe(1);
        expect(await draftStates(business.id)).toEqual([
          'RecordPurchase:superseded',
          'RecordPurchase:confirmed',
        ]);
        expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, [account]: -18_000_000 });
      },
    );

    it.each(['yes', 'na so', 'oya'])(
      '%j to the question alone re-asks it, and the short answer still works after',
      async (text) => {
        const business = await seedMerchant();
        await askFunding(business.id);
        await reply('wamid.P2-e-y', text);
        expect(stubSender.lastText).toContain(POS_QUESTION);
        expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
        expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);

        await reply('wamid.P2-e-y-cash', 'cash');
        expect(stubSender.lastText).toContain('Paid in full by cash');
      },
    );

    it('POS is a channel, never an answer', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-pos', 'pos');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
    });

    it('an expired question is gone: "bank" goes to the model and records nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.P2-e-late', 'bank');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['expired']);
    });

    it('another member\'s "bank" does not answer the owner\'s question', async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await askFunding(business.id);

      await reply('wamid.P2-e-d', 'bank', DELEGATE);
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['open']);
    });

    it('the wrong kind of answer retires the question; a later "bank" answers nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-w', 'last month');
      expect((await continuations(business.id)).map((c) => c.state)).toEqual(['superseded']);
      await reply('wamid.P2-e-w-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['RecordPurchase:abandoned']);
    });

    it('"no be so" closes the question, and a "bank" after it answers nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-no', 'no be so');
      expect(stubSender.lastText).toBe(replies.cancelled().text);
      await reply('wamid.P2-e-no-bank', 'bank');
      /* Told the question was closed, with no model call (G-68 review). */
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
      expect(await written(business.id)).toEqual({ purchases: 0, postings: 0, arrivals: 0 });
    });

    it('the short answer is stored like any model-path text: tokenised, never a name', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.P2-e-body', 'na bank');
      expect(await lastInboundBody(business.id)).toBe('na bank');
    });
  });
});

/**
 * G-68 post-rebase review: a questioned "yes" confirms nothing; every gate
 * on the funding answer is load-bearing; a "no" that closes a question says
 * so truthfully.
 */
describe('G-68 review: doubt, the funding gates, and closing a question', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
    statedTotal: 45_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const HOW_MUCH_DID_I_SELL = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
    return delegate.id;
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  const modelCalls = () => stubTransport.requests.length;

  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  async function continuationStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  describe('I1. an affirmation asked as a question confirms nothing', () => {
    it.each(['na so?', 'yes?', 'e correct?', 'oya?', 'na so 🤔', 'Na so ❓'])(
      '%j to a live ₦45,000 preview writes nothing, and only a plain yes saves it',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.R-q-sale', A_SALE, 'sold Ada 3 wigs for 45k');
        expect(stubSender.lastText).toContain('Please check this before I save it');

        await reply('wamid.R-q-doubt', text);
        expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
        expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
        /* `reply` resets the transport log: zero means no model since. */
        expect(modelCalls()).toBe(0);

        await reply('wamid.R-q-yes', 'yes');
        expect((await footprint(business.id)).invoices).toBe(1);
      },
    );

    /* G-85: a mark the normaliser would drop (a ring drawn through the word,
     * an x over it) is not a yes either. */
    it.each(['yes⃘', 'na soͯ', 'yes͓', '⃘yes', 'e correct⃚', 'YES⃙'])(
      'G-85: a marked %j to a live preview writes nothing, and only a plain yes saves it',
      async (text) => {
        const business = await seedMerchant();
        await say('wamid.R-g85-sale', A_SALE, 'sold Ada 3 wigs for 45k');
        expect(stubSender.lastText).toContain('Please check this before I save it');

        await reply('wamid.R-g85-marked', text);
        expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
        expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
        /* `reply` resets the transport log: zero means no model since. */
        expect(modelCalls()).toBe(0);

        await reply('wamid.R-g85-yes', 'yes');
        expect((await footprint(business.id)).invoices).toBe(1);
      },
    );

    it('with nothing waiting, it says nothing is waiting for a yes', async () => {
      await seedMerchant();
      await reply('wamid.R-q-none', 'na so?');
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(modelCalls()).toBe(0);
    });

    it('to the funding question, it re-asks and keeps the question open', async () => {
      const business = await seedMerchant();
      await say('wamid.R-q-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.R-q-pos-doubt', 'na so?');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
      expect(await continuationStates(business.id)).toEqual(['open']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('to an expired preview, it is told the request expired', async () => {
      const business = await seedMerchant();
      await say('wamid.R-q-exp', A_SALE, 'sold Ada 3 wigs for 45k');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.R-q-exp-doubt', 'na so?');
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect((await footprint(business.id)).invoices).toBe(0);
    });
  });

  describe('I2. every gate on the funding answer refuses, and writes nothing', () => {
    async function askFunding(businessId: string, from = OWNER) {
      await say('wamid.R-g-ask', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS', from);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(businessId)).toEqual(['abandoned']);
    }

    it('a member made view-only since the question gets no draft', async () => {
      const business = await seedMerchant();
      const delegateId = await addDelegate(business.id);
      await askFunding(business.id, DELEGATE);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE memberships SET role = 'accountant'
           WHERE business_id = ${business.id}::uuid AND user_id = ${delegateId}::uuid`),
      );
      await reply('wamid.R-g-view', 'cash', DELEGATE);
      expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a trial that lapsed since the question gets no draft', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await billingRepo.setPlan(db, {
        businessId: business.id,
        plan: 'trial',
        expiresAt: new Date(Date.now() - 1_000),
        actor: 'operator:test-clock',
      });
      await reply('wamid.R-g-lapsed', 'cash');
      expect(stubSender.lastText).toBe(replies.trialEnded().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a plan without Chat since the question gets no draft', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await billingRepo.setPlan(db, {
        businessId: business.id,
        plan: 'integrate',
        expiresAt: null,
        actor: 'operator:test',
      });
      await reply('wamid.R-g-nochat', 'bank');
      expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('"na so" after the REBUILT preview window closed writes nothing', async () => {
      const business = await seedMerchant();
      await askFunding(business.id);
      await reply('wamid.R-g-cash', 'cash');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.R-g-late-yes', 'na so');
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'expired']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });

    it('a question closed by another member is said to be closed, and nothing is rebuilt', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await askFunding(business.id);
      await reply('wamid.R-g-dno', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.cancelled().text);

      await reply('wamid.R-g-cash-after', 'cash');
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
      expect(await purchaseStates(business.id)).toEqual(['superseded']);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
    });
  });

  describe('M4. a "no" that closes only a question says so', () => {
    it('"no" to "Which period?" leaves the question, never "nothing is waiting"', async () => {
      const business = await seedMerchant();
      await say('wamid.R-m4-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.R-m4-no', 'no');
      expect(stubSender.lastText).toBe(replies.questionLeft().text);
      expect(stubSender.lastText).not.toBe(replies.nothingToDecline().text);
      expect(await continuationStates(business.id)).toEqual(['superseded']);
      expect(modelCalls()).toBe(0);
    });

    it('"forget am" to "Which period?" leaves the question too', async () => {
      await seedMerchant();
      await say('wamid.R-m4b-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?');
      await reply('wamid.R-m4b-cancel', 'forget am');
      expect(stubSender.lastText).toBe(replies.questionLeft().text);
    });

    it('"no" to the funding question still cancels it (G-61)', async () => {
      await seedMerchant();
      await say('wamid.R-m4c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.R-m4c-no', 'no be so');
      expect(stubSender.lastText).toBe(replies.cancelled().text);
    });
  });
});

/**
 * G-68 final-head review: the two-ask erasure survives a questioned yes, a
 * question mark anywhere makes an affirmation a question, and a re-asked
 * funding question can always be answered as it says.
 */
describe('G-68 final review: erasure, doubt anywhere, re-asked funding question', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
    statedTotal: 45_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  const modelCalls = () => stubTransport.requests.length;

  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  describe('I1. a questioned yes between the two erasure asks keeps the data', () => {
    it.each(['yes?', 'na so?', 'e correct 🤔'])(
      '%j breaks the pair: nothing is erased',
      async (doubt) => {
        const business = await seedMerchant();
        const customer = await customersRepo.createCustomerWithIdentities(
          db,
          business.id,
          'CUSTOMER_T9',
          [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-erase' }],
        );
        const facets = () =>
          withBusiness(db, business.id, (tx) =>
            customersRepo.identityFacetsFor(tx, business.id, customer.id),
          );

        await reply('wamid.F-del1', 'delete my data');
        expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

        await reply('wamid.F-del-doubt', doubt);
        expect(stubSender.lastText).toBe(replies.erasureKept().text);

        /* No longer the second of a pair: a new first ask, nothing erased. */
        await reply('wamid.F-del2', 'delete my data');
        expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
        expect(await facets()).toHaveLength(1);
      },
    );
  });

  describe('I2. a question mark anywhere makes an affirmation a question', () => {
    it.each([
      'yes?!',
      'na so?!',
      'na so ?!',
      'e correct?.',
      'yes ?)',
      'yes? 👍',
      'yes?? ok',
      'na so?o',
      'yes?​',
      'yes¿',
      'yes 🙄',
    ])('%j to a live preview writes nothing', async (text) => {
      const business = await seedMerchant();
      await say('wamid.F-q-sale', A_SALE, 'sold Ada 3 wigs for 45k');
      await reply('wamid.F-q', text);
      expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
      expect(await footprint(business.id)).toEqual({ invoices: 0, purchases: 0, postings: 0 });
      expect(modelCalls()).toBe(0);
    });
  });

  describe('I3. a re-asked funding question can be answered as it says', () => {
    it('after the first question expired, a yes re-asks and "bank" then gives a fresh preview', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.F-r-yes', 'yes');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');

      await reply('wamid.F-r-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(modelCalls()).toBe(0);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it('after an unrelated free command retired it, a yes re-opens it', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F-r2-other', 'wetin remain');
      expect(stubSender.lastText).toContain('You are not counting any stock yet');
      await reply('wamid.F-r2-yes', 'na so');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.F-r2-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it("a second member's yes opens it for THEM, and their answer passes their own gates", async () => {
      const business = await seedMerchant();
      const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      await say('wamid.F-r3-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');

      await reply('wamid.F-r3-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.F-r3-bank', 'bank', DELEGATE);
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(modelCalls()).toBe(0);
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it('a questioned answer ("cash?") rebuilds nothing and asks again, keeping it open', async () => {
      const business = await seedMerchant();
      await say('wamid.F-r4-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F-r4-q', 'cash?');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      await reply('wamid.F-r4-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });
  });

  describe('minor: a questioned yes carries the role rule', () => {
    it('a view-only member is told so, never "reply yes to save it"', async () => {
      const business = await seedMerchant();
      const accountant = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
      await identity.addMembership(db, business.id, accountant.id, 'accountant');
      await say('wamid.F-v-sale', A_SALE, 'sold Ada 3 wigs for 45k');
      await reply('wamid.F-v-q', 'na so?', DELEGATE);
      expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
      expect((await footprint(business.id)).invoices).toBe(0);
    });
  });
});

/**
 * G-68 final-head review 2: the G-61 rebuild is ONE-SHOT, the two-ask
 * erasure breaks on ANY message between the asks, and a funding answer is
 * taken only inside its window.
 */
describe('G-68 final review 2: one-shot rebuild, strict erasure pair, answer window', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const HOW_MUCH_DID_I_SELL = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function written(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings
        `),
      )),
    ];
    return row!;
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  async function continuationStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  describe('F2. the rebuild is one-shot', () => {
    it('owner "bank" then delegate "cash", then two yeses: the purchase is booked ONCE', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.F2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);

      await reply('wamid.F2-o-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      /* The delegate's short answer was retired by the owner's rebuild. */
      expect(await continuationStates(business.id)).toEqual(['consumed', 'superseded']);
      await reply('wamid.F2-d-cash', 'cash', DELEGATE);
      /* The OWNER's rebuilt preview (from Bank) is waiting, but the delegate
       * never saw it and asked for cash: never pointed at it as theirs to
       * confirm, and never invited to send the purchase again either
       * (final-head review). */
      expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);

      await reply('wamid.F2-yes-1', 'yes', DELEGATE);
      await reply('wamid.F2-yes-2', 'yes');
      await reply('wamid.F2-yes-3', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1, arrivals: 1 });
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'confirmed']);
    });

    it('a second answer from the same member after the rebuild makes no second preview', async () => {
      const business = await seedMerchant();
      await say('wamid.F2b-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2b-bank', 'bank');
      await reply('wamid.F2b-cash', 'cash');
      expect(stubSender.lastText).not.toContain('Please check this before I save it');
      /* Their own preview records a different account: it is named. */
      expect(stubSender.lastText).toBe(replies.previewAlreadyWaiting('transfer').text);
      expect(stubSender.lastText).toContain('paid from your bank account');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });
  });

  describe('F2c. another member’s waiting preview (final-head review)', () => {
    const RICE = {
      ...POS_PURCHASE,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      paymentMethod: 'cash',
      productMention: 'bags of rice',
      quantity: 5,
    };

    it('another member sending the purchase again NEVER replaces the owner’s preview, and is told nothing false', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.F2c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-d-yes', 'yes', DELEGATE);
      await reply('wamid.F2c-o-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      await reply('wamid.F2c-d-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toBe(replies.previewWaitingForAnotherMember().text);

      /* Sent again anyway by the delegate: never a replacement across
       * members, and the delegate is told nothing about "your" earlier
       * preview, which was never theirs. Since G-81 (OD-23) it is no longer
       * a second confirmable preview either (this test pinned that accepted
       * hazard as base): it is HELD and the delegate is asked whether it is
       * the same purchase, so the two yeses below book it once. */
      await say(
        'wamid.F2c-d-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(stubSender.lastText).toContain('from another member');
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'held']);
      await reply('wamid.F2c-d-yes-1', 'yes');
      await reply('wamid.F2c-d-yes-2', 'yes', DELEGATE);
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('the same member, a DIFFERENT total: both wait, and the reply says the earlier one still waits', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-x-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-x-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      await say('wamid.F2c-x-rice', RICE, 'bought 5 bags rice 50k cash');
      expect(stubSender.lastText).toContain('Your earlier preview of ₦180,000 is still waiting.');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'pending']);
      await reply('wamid.F2c-x-yes-1', 'yes');
      await reply('wamid.F2c-x-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 2 });
    });

    it('the same member, the same total under another product name: replaced, announced, booked ONCE', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-r-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-r-bank', 'bank');
      await say(
        'wamid.F2c-r-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash', productMention: 'carton indomie' },
        'I bought carton indomie for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain(
        'Your earlier preview of ₦180,000 was replaced by this one. If that was a different purchase, reply *yes* to save this one first, then send the other purchase.',
      );
      await reply('wamid.F2c-r-yes-1', 'yes');
      await reply('wamid.F2c-r-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('the same member following the replacement advice gets BOTH purchases in (final-head review of #262)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-a-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-a-bank', 'bank');
      await say(
        'wamid.F2c-a-indomie',
        { ...POS_PURCHASE, paymentMethod: 'cash', productMention: 'carton indomie' },
        'I bought carton indomie for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain('reply *yes* to save this one first');
      /* As advised: save this one, then send the other purchase. It now
       * meets a SAVED purchase, so it is asked about, never replaced. */
      await reply('wamid.F2c-a-yes-1', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
      await say(
        'wamid.F2c-a-milo',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(stubSender.lastText).not.toContain('was replaced by this one');
      await reply('wamid.F2c-a-sep', 'separate');
      await reply('wamid.F2c-a-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 2 });
    });

    it('a replacement whose send fails gives back the preview the merchant saw (Codex review)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-f-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      stubSender.failWith();
      await say(
        'wamid.F2c-f-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      /* Nobody saw the replacement: it is superseded, the Bank preview is
       * pending again, and a yes books THAT one, once. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'superseded']);
      await reply('wamid.F2c-f-yes-1', 'yes');
      await reply('wamid.F2c-f-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'confirmed', 'superseded']);
    });

    it('a resend whose preview fails to send gives the question back; "cash" then rebuilds once (Codex review)', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-w-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      stubSender.failWith();
      await say(
        'wamid.F2c-w-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      /* Nobody saw the resend's preview: withdrawn, the question restored. */
      expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
      await reply('wamid.F2c-w-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await reply('wamid.F2c-w-yes-1', 'yes');
      await reply('wamid.F2c-w-yes-2', 'yes');
      expect(await written(business.id)).toMatchObject({ purchases: 1 });
    });

    it('a rebuild with no recorded requester is never replaced', async () => {
      const business = await seedMerchant();
      await say('wamid.F2c-n-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-n-bank', 'bank');
      /* As a rebuild written before 0157 recorded who asked. */
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET requested_by = NULL
           WHERE business_id = ${business.id}::uuid AND rebuilt_from IS NOT NULL`),
      );
      await say(
        'wamid.F2c-n-resend',
        { ...POS_PURCHASE, paymentMethod: 'cash' },
        'I bought 10 cartons for 180k, paid cash',
      );
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      /* G-81: a draft with no recorded requester is never "yours", so it
       * is never replaced; nor is it left beside a second confirmable
       * preview of the same total any more (base, which this test pinned):
       * the new one is HELD and asked about. */
      expect(stubSender.lastText).toContain('Is this the same purchase?');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'held']);
    });

    it('a sale preview after the question is never called the waiting purchase', async () => {
      await seedMerchant();
      await say('wamid.F2c-q-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await say(
        'wamid.F2c-q-sale',
        {
          intent: 'RecordSale',
          customer: { kind: 'token', token: 'CUSTOMER_7K2' },
          items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
          statedTotal: 45_000,
          reportedPayment: 0,
          paymentMethod: 'transfer',
          discount: null,
          deliveryFee: null,
          dueDescription: null,
        },
        'sold Ada 3 wigs for 45k',
      );
      await reply('wamid.F2c-q-cash', 'cash');
      expect(stubSender.lastText).not.toBe(replies.previewAlreadyWaiting().text);
      expect(stubSender.lastText).not.toContain('already waiting');
      expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
    });

    it('the same member naming the same account again is pointed at their preview, unnamed', async () => {
      await seedMerchant();
      await say('wamid.F2c-s-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.F2c-s-bank', 'bank');
      await reply('wamid.F2c-s-bank-2', 'bank');
      expect(stubSender.lastText).toBe(replies.previewAlreadyWaiting().text);
    });
  });

  describe('F1. any message between the two erasure asks keeps the data', () => {
    async function seedCustomer(businessId: string) {
      const customer = await customersRepo.createCustomerWithIdentities(
        db,
        businessId,
        'CUSTOMER_T9',
        [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-f1' }],
      );
      return () =>
        withBusiness(db, businessId, (tx) =>
          customersRepo.identityFacetsFor(tx, businessId, customer.id),
        );
    }

    it.each([
      ['who still dey owe me', OWNER],
      ['wetin you fit do', OWNER],
      ['make i see my books', OWNER],
      ['how many remain', OWNER],
      ['i wan upgrade', OWNER],
      /* An English free command now breaks the pair too: stricter than base,
       * the safe direction, and what the copy promises. */
      ['who owes me', OWNER],
    ])('%j between the asks breaks the pair', async (between, from) => {
      const business = await seedMerchant();
      const facets = await seedCustomer(business.id);
      await reply('wamid.F1-del1', 'delete my data');
      await reply('wamid.F1-between', between, from);
      await reply('wamid.F1-del2', 'delete my data');
      expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
      expect(await facets()).toHaveLength(1);
    });

    it("another member's answer to their own question breaks the pair", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      const facets = await seedCustomer(business.id);
      await say('wamid.F1-d-ask', HOW_MUCH_DID_I_SELL, 'How much did I sell?', DELEGATE);
      await reply('wamid.F1b-del1', 'delete my data');
      await reply('wamid.F1b-y', 'yesterday', DELEGATE);
      expect(stubSender.lastText).toBe(replies.periodNotCountable('sales').text);
      await reply('wamid.F1b-del2', 'delete my data');
      expect(await facets()).toHaveLength(1);
    });

    it("another member's doubtful funding answer breaks the pair", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      const facets = await seedCustomer(business.id);
      await say(
        'wamid.F1c-pos',
        POS_PURCHASE,
        'I bought 10 cartons for 180k, paid by POS',
        DELEGATE,
      );
      await reply('wamid.F1c-del1', 'delete my data');
      await reply('wamid.F1c-q', 'cash?', DELEGATE);
      await reply('wamid.F1c-del2', 'delete my data');
      expect(await facets()).toHaveLength(1);
    });

    it('the two asks with nothing between still erase', async () => {
      const business = await seedMerchant();
      const facets = await seedCustomer(business.id);
      await reply('wamid.F1d-del1', 'delete my data');
      await reply('wamid.F1d-del2', 'delete my data');
      expect(stubSender.lastText).toContain('deleted (1 record)');
      expect(await facets()).toHaveLength(0);
    });
  });

  describe('F3. a funding answer is taken only inside its window', () => {
    const age = (businessId: string, minutes: number) =>
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts
             SET created_at = clock_timestamp() - make_interval(mins => ${minutes})
           WHERE business_id = ${businessId}::uuid AND state = 'abandoned'`),
      );

    it('inside the window, a re-ask after the continuation expired still rebuilds', async () => {
      const business = await seedMerchant();
      await say('wamid.F3a-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 20);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 second'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.F3a-yes', 'yes');
      expect(stubSender.lastText).toContain('Reply *bank* or *cash*');
      await reply('wamid.F3a-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
    });

    it('after the window, the re-ask offers no short answer and "bank" rebuilds nothing', async () => {
      const business = await seedMerchant();
      await say('wamid.F3b-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 31);
      await reply('wamid.F3b-yes', 'yes');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(stubSender.lastText).not.toContain('Reply *bank*');
      expect(stubSender.lastText).toContain('Send it again with where the money came');

      await reply('wamid.F3b-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      expect(await written(business.id)).toEqual({ purchases: 0, arrivals: 0, postings: 0 });
    });

    it('an open continuation past the window does not rebuild either', async () => {
      const business = await seedMerchant();
      await say('wamid.F3c-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await age(business.id, 31);
      await reply('wamid.F3c-bank', 'bank');
      expect(stubSender.lastText).toBe(UNCLEAR.clarification);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
    });
  });
});

/**
 * G-68 final-head review 3: a resend closes the question for everyone, the
 * funding continuation lives exactly as long as its answer window, and any
 * message (media included) between the erasure asks keeps the data.
 */
describe('G-68 final review 3: resend closes the question, window-long answer, media between asks', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function purchases(businessId: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM expenses WHERE business_id = ${businessId}::uuid`),
    );
    return [...rows][0]!.n;
  }

  it('the owner resends the purchase while the delegate holds a short answer: booked ONCE', async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');

    await say('wamid.R3-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.R3-d-yes', 'yes', DELEGATE);
    await say(
      'wamid.R3-resend',
      { ...POS_PURCHASE, paymentMethod: 'transfer' },
      'I bought 10 cartons for 180k, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await reply('wamid.R3-o-yes', 'yes');
    expect(await purchases(business.id)).toBe(1);

    await reply('wamid.R3-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
    await reply('wamid.R3-yes-2', 'yes', DELEGATE);
    await reply('wamid.R3-yes-3', 'yes');
    expect(await purchases(business.id)).toBe(1);
  });

  const shift = (businessId: string, minutes: number) =>
    withBusiness(db, businessId, async (tx) => {
      await tx.execute(sql`
        UPDATE command_drafts SET created_at = created_at - make_interval(mins => ${minutes})
         WHERE business_id = ${businessId}::uuid AND state = 'abandoned'`);
      await tx.execute(sql`
        UPDATE conversation_continuations
           SET created_at = created_at - make_interval(mins => ${minutes}),
               expires_at = expires_at - make_interval(mins => ${minutes})
         WHERE business_id = ${businessId}::uuid`);
    });

  it('"bank" at minute 11, with no re-ask, still rebuilds: the offer lasts the whole window', async () => {
    const business = await seedMerchant();
    await say('wamid.W-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await shift(business.id, 11);
    await reply('wamid.W-bank', 'bank');
    expect(stubSender.lastText).toContain('Paid in full by transfer');
  });

  it('"bank" at minute 31, with no re-ask, rebuilds nothing', async () => {
    const business = await seedMerchant();
    await say('wamid.W2-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await shift(business.id, 31);
    await reply('wamid.W2-bank', 'bank');
    expect(stubSender.lastText).toBe(UNCLEAR.clarification);
    expect(await purchases(business.id)).toBe(0);
  });

  it('a photo between the two erasure asks breaks the pair: nothing is erased', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-media' }],
    );
    await reply('wamid.M-del1', 'delete my data');
    await post({
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
                messages: [{ id: 'wamid.M-photo', from: OWNER, timestamp: '1', type: 'image' }],
              },
            },
          ],
        },
      ],
    });
    await drain();
    await reply('wamid.M-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(1);
  });
});

/**
 * Codex review of #259 (and a fresh final-head reviewer): durable erasure
 * pairing, negating emoji, a rebuild nobody saw, gates before the claim, the
 * newest continuation as of the message, and an honest "already waiting".
 */
describe('G-68 Codex review: erasure events, emoji, failed rebuild send, gates, waiting preview', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 15_000 }],
    statedTotal: 45_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function count(businessId: string, table: 'invoices' | 'expenses'): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE business_id = ${businessId}::uuid`,
      ),
    );
    return [...rows][0]!.n;
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  it('P1: a message whose processing FAILED between the erasure asks still breaks the pair', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-fail' }],
    );
    await reply('wamid.CX-del1', 'delete my data');
    /* The tokeniser fails before the message row is written: the job fails. */
    const spy = vi
      .spyOn(deps.gateway, 'tokenise')
      .mockRejectedValueOnce(new Error('vault unavailable'));
    try {
      await reply('wamid.CX-between', 'Ada bought 3 wigs for 150k');
    } finally {
      spy.mockRestore();
    }
    await reply('wamid.CX-del2', 'delete my data');
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(1);
  });

  it('P2: a message that arrived AFTER the second erasure ask does not break the pair (Codex review)', async () => {
    const business = await seedMerchant();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T8',
      [{ facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-g68-after' }],
    );
    await reply('wamid.CX-a-del1', 'delete my data');
    /* The second ask and a later message are both ingested before either
     * job runs: the later one was not said between the two asks. */
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(OWNER, 'wamid.CX-a-del2', 'delete my data'));
    await post(messagePayload(OWNER, 'wamid.CX-a-after', 'Ada bought 3 wigs for 150k'));
    await drain();
    const facets = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(facets).toHaveLength(0);
  });

  it.each([
    'na so ❌',
    'e correct 👎',
    'oya 🚫',
    'yes ⛔',
    'yes 🛑',
    'yes 🙅🏾',
    'na so ❎',
    'yes ✖️',
    'yes 😂',
  ])('P1: %j to a live preview writes nothing', async (text) => {
    const business = await seedMerchant();
    await say('wamid.CX-e-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await reply('wamid.CX-e', text);
    expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
    expect(await count(business.id, 'invoices')).toBe(0);
  });

  it.each(['yes 👍', 'na so 😊', 'e correct ✅'])('%j still confirms', async (text) => {
    const business = await seedMerchant();
    await say('wamid.CX-p-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await reply('wamid.CX-p', text);
    expect(await count(business.id, 'invoices')).toBe(1);
  });

  it('P2: a rebuilt preview that was never delivered is undone, and "cash" again works once', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    stubSender.failWith();
    await reply('wamid.CX-f-cash', 'cash');
    /* Nothing the merchant saw: the rebuild is undone, the question restored. */
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
    /* A yes now confirms nothing: the preview nobody saw is not confirmable.
     * It finds the QUESTION again and re-asks it (the undone rebuild is never
     * the latest thing to answer). */
    await reply('wamid.CX-f-yes-early', 'yes');
    expect(stubSender.lastText).toContain(POS_QUESTION);
    expect(await count(business.id, 'expenses')).toBe(0);
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);

    await reply('wamid.CX-f-cash-2', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX-f-yes', 'yes');
    await reply('wamid.CX-f-yes-2', 'yes');
    expect(await count(business.id, 'expenses')).toBe(1);
  });

  it('after an undone rebuild, "no" finds the question again and closes it', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-fn-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    stubSender.failWith();
    await reply('wamid.CX-fn-cash', 'cash');
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);
    await reply('wamid.CX-fn-no', 'no');
    expect(stubSender.lastText).toContain('Cancelled');
    expect(await purchaseStates(business.id)).toEqual(['superseded', 'superseded']);
    /* Closed for good: a later "cash" rebuilds nothing. */
    await reply('wamid.CX-fn-cash-2', 'cash');
    expect(stubSender.lastText).not.toContain('Paid in full by cash');
    expect(await count(business.id, 'expenses')).toBe(0);
  });

  it('P2: a gate refusal does not use up the answer; after access returns, "cash" rebuilds', async () => {
    const business = await seedMerchant();
    await say('wamid.CX-g-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await reply('wamid.CX-g-refused', 'cash');
    expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'trial',
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      actor: 'operator:test',
    });
    await reply('wamid.CX-g-cash', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
  });

  it('an EXPIRED rebuilt preview is never reported as waiting', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX-x-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.CX-x-d-yes', 'yes', DELEGATE);
    await reply('wamid.CX-x-bank', 'bank');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
         WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
    );
    await reply('wamid.CX-x-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
  });

  it('a preview a yes cannot reach (a newer retired question) is never reported as waiting', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX-u-sale', A_SALE, 'sold Ada 3 wigs for 45k');
    await say('wamid.CX-u-r1', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS', DELEGATE);
    await say('wamid.CX-u-r2', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    /* The owner's sale preview, pending again behind both retired questions. */
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET state = 'pending'
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`),
    );
    await reply('wamid.CX-u-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toBe(replies.fundingQuestionClosed().text);
  });

  /* Codex review, second round. */
  it.each(['cash ❌', 'bank 👎', 'cash 🚫'])(
    'P2: %j to the funding question rebuilds nothing and keeps it open',
    async (text) => {
      const business = await seedMerchant();
      await say('wamid.CX2-e-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.CX2-e', text);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      /* Still open: a plain answer now rebuilds it. */
      await reply('wamid.CX2-e-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    },
  );

  /* G-85: a funding answer with a mark drawn over it names no account. */
  it.each(['cash⃘', 'bank͓', 'bankͯ', 'na cash⃚', 'transfer̀'])(
    'G-85: a marked %j to the funding question rebuilds nothing and keeps it open',
    async (text) => {
      const business = await seedMerchant();
      await say('wamid.G85-f-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
      await reply('wamid.G85-f', text);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      expect(await purchaseStates(business.id)).toEqual(['abandoned']);
      /* `reply` resets the transport log: none since means no model. */
      expect(stubTransport.requests).toHaveLength(0);
      /* Still open: a plain answer now rebuilds it. */
      await reply('wamid.G85-f-cash', 'cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
    },
  );

  it('P2: an undone rebuild re-opens EVERY member’s answer it retired; the other member’s "cash" rebuilds once', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say('wamid.CX2-m-pos', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    /* The delegate is asked too, and so holds the question as well. */
    await reply('wamid.CX2-m-d-yes', 'yes', DELEGATE);
    expect(stubSender.lastText).toContain(POS_QUESTION);
    stubSender.failWith();
    await reply('wamid.CX2-m-cash', 'cash');
    expect(await purchaseStates(business.id)).toEqual(['abandoned', 'superseded']);

    await reply('wamid.CX2-m-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX2-m-d-ok', 'yes', DELEGATE);
    await reply('wamid.CX2-m-d-ok2', 'yes', DELEGATE);
    expect(await count(business.id, 'expenses')).toBe(1);
  });

  it('P2: a newer question, answered and its preview cancelled, never revives an older one', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    /* Q1, held by the delegate. */
    await say(
      'wamid.CX2-n-q1',
      POS_PURCHASE,
      'I bought 10 cartons for 180k, paid by POS',
      DELEGATE,
    );
    /* Q2 from the owner, answered into a preview, then cancelled. */
    await say('wamid.CX2-n-q2', POS_PURCHASE, 'I bought 10 cartons for 180k, paid by POS');
    await reply('wamid.CX2-n-cash', 'cash');
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply('wamid.CX2-n-no', 'no');

    const before = await purchaseStates(business.id);
    await reply('wamid.CX2-n-d-cash', 'cash', DELEGATE);
    expect(stubSender.lastText).not.toContain('Paid in full by cash');
    expect(await purchaseStates(business.id)).toEqual(before);
    await reply('wamid.CX2-n-d-yes', 'yes', DELEGATE);
    expect(await count(business.id, 'expenses')).toBe(0);
  });
});

describe('Chat entitlement on fixed commands (G-65)', () => {
  const OWNER = '2348031234567';
  const REFUSED = replies.chatCommandNotInPlan().text;
  /* The model path's refusal, unchanged by G-65. */
  const FREE_FORM_REFUSED = replies.chatNotInPlan().text;
  /* A refused yes says first that nothing was saved. */
  const YES_REFUSED = replies.notSavedNotInPlan().text;
  const LAPSED = replies.trialEnded().text;
  const YES_LAPSED = replies.notSavedPlanEnded('trial').text;
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 100_000 }],
    statedTotal: 300_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const AN_EXPENSE = {
    intent: 'RecordExpense',
    description: 'fuel for generator',
    amount: 20_000,
    category: 'utilities',
    paymentMethod: 'cash',
  };
  const DEBTORS_QUESTION = {
    intent: 'Query',
    topic: 'debtors',
    customer: null,
    period: null,
    periodText: null,
    format: 'chat',
  };
  const HOW_MUCH_DID_I_SELL = { ...DEBTORS_QUESTION, topic: 'sales_summary' };

  async function seedMerchant() {
    const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await billingRepo.setPlan(db, { businessId, plan, expiresAt: null, actor: 'operator:g65' });
  }

  async function lapse(businessId: string) {
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:g65',
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /**
   * No inbound message may be left failing. A job that answers and then
   * rolls back leaves every counted table as it was, so without this a
   * refusal that crashed after replying would pass as "nothing happened".
   * (A `document.deliver` of a fixture document with no stored bytes fails
   * by design and is not this check's business.)
   */
  async function expectNoFailedJob() {
    const [row] = [
      ...(await workerDb.execute<{ failed: string }>(sql`
        SELECT count(*) AS failed FROM jobs
         WHERE kind = 'inbound.message' AND state <> 'done' AND last_error IS NOT NULL`)),
    ];
    expect(row?.failed).toBe('0');
  }

  let seq = 0;
  async function send(text: string, command?: Record<string, unknown>) {
    if (command) stubTransport.replyWith(command);
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, text));
    await drain();
    await expectNoFailedJob();
    return stubSender.lastText ?? '';
  }

  /**
   * Everything a Chat command could have to show for itself: an open
   * ₦80,000 invoice whose customer has an email (so payment details can
   * mint), an active payment connection, and a stored document to resend.
   */
  async function seedBooks(businessId: string): Promise<string> {
    const config = deps.config;
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
      {
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey, `${businessId}:email`),
        matchKey: null,
      },
    ]);
    return withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_g65',
      });
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g65-seed',
        actor: 'system',
      });
      await issueRepo.recordDocument(tx, {
        businessId,
        kind: 'invoice_pdf',
        storageKey: 'test/g65-unguessable',
        refNumber: sale.invoiceNumber,
        bytes: 1234,
      });
      return sale.invoiceNumber;
    });
  }

  /** Every row a Chat command or a yes could write, counted. */
  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, string>>(sql`
          SELECT
            (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*) FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*) FROM expenses WHERE business_id = ${businessId}::uuid) AS expenses,
            (SELECT count(*) FROM inventory_movements
              WHERE business_id = ${businessId}::uuid) AS stock_moves,
            (SELECT count(*) FROM ledger_transactions
              WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*) FROM payment_intents
              WHERE business_id = ${businessId}::uuid) AS intents,
            (SELECT count(*) FROM jobs WHERE business_id = ${businessId}::uuid
              AND kind = 'document.deliver') AS deliveries,
            (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid
              AND state = 'confirmed') AS confirmed,
            (SELECT COALESCE(sum(used), 0) FROM usage_counters
              WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
            (SELECT COALESCE(sum(used), 0) FROM usage_counters
              WHERE business_id = ${businessId}::uuid
                AND unit = 'DOCUMENT_GENERATION') AS document_credits,
            /* Every meter, so one added later is covered without editing this. */
            (SELECT COALESCE(string_agg(unit || '=' || used, ',' ORDER BY unit), '')
               FROM usage_counters WHERE business_id = ${businessId}::uuid) AS meters,
            /* Every usage event but the replies' own: each message Rekoda
             * sends records one SERVICE_MESSAGE, the refusal included. */
            (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
              AND usage_type <> 'SERVICE_MESSAGE') AS usage_events,
            (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
              AND usage_type = 'SERVICE_MESSAGE') AS service_messages`),
      )),
    ];
    return { ...row };
  }

  /**
   * Nothing moved but the replies: `sent` messages to the merchant, each
   * recording its own SERVICE_MESSAGE, and every other row and meter as it was.
   */
  async function expectOnlyReplies(
    businessId: string,
    before: Awaited<ReturnType<typeof footprint>>,
    sent: number,
  ) {
    expect(await footprint(businessId)).toEqual({
      ...before,
      service_messages: String(Number(before['service_messages']) + sent),
    });
  }

  async function draftStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts WHERE business_id = ${businessId}::uuid
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  /**
   * Where the stubs stand now. Snapshotted rather than reset: resetting the
   * sender mid-test restarts its provider message ids, and the next reply
   * then collides with an earlier one on `messages_provider_ux`.
   */
  function sendMark() {
    return {
      sent: stubSender.sent.length,
      documents: stubSender.documents.length,
      customerTexts: stubSender.connectionTexts.length,
      templates: stubSender.templates.length,
      mints: intentsProvider.initialized.length,
    };
  }
  const NO_MARK = { sent: 0, documents: 0, customerTexts: 0, templates: 0, mints: 0 };

  /** What went anywhere but back to the merchant's own chat since `mark`. */
  function beyondTheMerchant(mark = NO_MARK) {
    return {
      elsewhere: stubSender.sent.slice(mark.sent).filter((m) => m.to !== OWNER).length,
      documents: stubSender.documents.length - mark.documents,
      customerTexts: stubSender.connectionTexts.length - mark.customerTexts,
      templates: stubSender.templates.length - mark.templates,
      mints: intentsProvider.initialized.length - mark.mints,
    };
  }
  const NOTHING_BEYOND = { elsewhere: 0, documents: 0, customerTexts: 0, templates: 0, mints: 0 };

  /* English and Pidgin side by side: the router maps both to one intent. */
  const CHAT_COMMANDS = [
    'who owes me',
    'who dey owe me',
    'records',
    'stock',
    'wetin remain',
    'payment details',
    'remind {INV}',
    'resend',
  ] as const;

  it.each(CHAT_COMMANDS)(
    'refuses "%s" to an Integrate-only plan, with no side effect at all',
    async (phrase) => {
      const business = await seedMerchant();
      const invoiceNumber = await seedBooks(business.id);
      await moveToPlan(business.id, 'integrate');
      const before = await footprint(business.id);
      const mark = sendMark();

      const said = await send(phrase.replace('{INV}', invoiceNumber));

      expect(said).toBe(REFUSED);
      // One message, the refusal, to the merchant who asked. Nothing else.
      expect(stubSender.sent.length - mark.sent).toBe(1);
      expect(beyondTheMerchant(mark)).toEqual(NOTHING_BEYOND);
      expect(stubTransport.requests).toHaveLength(0);
      await expectOnlyReplies(business.id, before, 1);
    },
  );

  it.each(['chat', 'complete'] as const)('runs every Chat command on the %s plan', async (plan) => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    await moveToPlan(business.id, plan);

    expect(await send('who owes me')).toContain('₦80,000');
    expect(await send('who dey owe me')).toContain('₦80,000');
    expect(await send('records')).toContain('Your books this month');
    expect(await send('wetin remain')).toContain('not counting any stock');
    expect(await send('payment details')).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
    expect(await send(`remind ${invoiceNumber}`)).toContain(`reminder for ${invoiceNumber}`);
    expect(await send('resend')).toContain(`Sending ${invoiceNumber} again`);
    // Free, as before: none of them reached the model.
    expect(stubTransport.requests).toHaveLength(0);
    expect((await footprint(business.id)).ai_actions).toBe('0');
  });

  it('meets the free-form question and its fixed phrase at the same boundary', async () => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);

    // The model path refuses before the model, as it always did...
    expect(await send('which of my customers still owe me money?', DEBTORS_QUESTION)).toBe(
      FREE_FORM_REFUSED,
    );
    // ...and the fixed phrase no longer walks round it.
    expect(await send('who owes me')).toBe(REFUSED);
    expect(stubTransport.requests).toHaveLength(0);
    await expectOnlyReplies(business.id, before, 2);

    // With Chat, both are answered, with the same debtor.
    await moveToPlan(business.id, 'chat');
    const freeForm = await send('which of my customers still owe me money?', DEBTORS_QUESTION);
    expect(freeForm).toContain('₦80,000');
    expect(freeForm).toMatch(/INV-\d{4}-000001/);
    const fixed = await send('who owes me');
    expect(fixed).toContain('₦80,000');
    expect(fixed).toMatch(/INV-\d{4}-000001/);
  });

  it('keeps consent, erasure, the dashboard, help and upgrade open without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    expect(await send('STOP')).toBe(replies.optedOut().text);
    expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await identity.optedOutAt(db, `+${OWNER}`)).toBeNull();

    expect(await send('dashboard')).toContain('Here are your books');
    expect(await send('help')).toBe(
      replies.helpWithoutChat(null, { owner: true, transacts: true }).text,
    );

    expect(await send('upgrade')).toBe(replies.upgradeRequested().text);
    const requests = await withBusiness(db, business.id, (tx) =>
      billingRepo.upgradeRequestsFor(tx, business.id),
    );
    expect(requests).toHaveLength(1);

    // The two-ask erasure ceremony runs to the end on a plan without Chat.
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('delete my data')).toContain('Done. Your customers');
    expect(stubTransport.requests).toHaveLength(0);
  });

  it.each(['integrate', 'lapsed'] as const)(
    'a natural opt-out is as universal as STOP when the plan is %s (G-80)',
    async (standing) => {
      const business = await seedMerchant();
      if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
      else await lapse(business.id);

      expect(await send('abeg stop')).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
      expect(await send('START')).toBe(replies.optedInWithoutChat().text);
      expect(await send('no send me again')).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(0);
    },
  );

  it('keeps consent and erasure open on a lapsed plan too', async () => {
    const business = await seedMerchant();
    await lapse(business.id);

    expect(await send('STOP')).toBe(replies.optedOut().text);
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await send('dashboard')).toContain('Here are your books');
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('delete my data')).toContain('Done. Your customers');
  });

  it('a yes between the two erasure asks still keeps the data without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    // Not refused for want of Chat: a yes is "anything else", and it keeps.
    expect(await send('yes')).toBe(replies.erasureKept().text);
    // The pair is broken, so this is a fresh first ask, not the confirmation.
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
  });

  it('a yes cannot confirm a Chat draft once the plan has no Chat', async () => {
    const business = await seedMerchant();
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const requests = stubTransport.requests.length;
    const mark = sendMark();

    expect(await send('yes')).toBe(YES_REFUSED);

    await expectOnlyReplies(business.id, before, 1);
    expect(beyondTheMerchant(mark)).toEqual(NOTHING_BEYOND);
    expect(stubTransport.requests).toHaveLength(requests);
    // Left pending, not claimed: the same yes works after an upgrade.
    expect(await draftStates(business.id)).toEqual(['pending']);
    await moveToPlan(business.id, 'chat');
    expect(await send('yes')).toContain('INV-');
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('a refused yes past a read changes nothing, not even the read', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await send('how much did I sell this month?', { ...HOW_MUCH_DID_I_SELL, period: 'month' });
    await moveToPlan(business.id, 'integrate');
    const states = await draftStates(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_REFUSED);

    // Build 6 would retire the read's draft to point back at the preview;
    // refused first, nothing moves.
    expect(await draftStates(business.id)).toEqual(states);
    await expectOnlyReplies(business.id, before, 1);
  });

  it('a no still cancels a Chat draft on a plan without Chat', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await moveToPlan(business.id, 'integrate');
    expect(await send('yes')).toBe(YES_REFUSED);

    expect(await send('no')).toBe(replies.cancelled().text);
    expect(await draftStates(business.id)).toEqual(['superseded']);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('a yes after the plan lapsed records no expense either', async () => {
    const business = await seedMerchant();
    expect(await send('fuel for generator 20k', AN_EXPENSE)).toContain('Reply *yes*');
    await lapse(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_LAPSED);

    await expectOnlyReplies(business.id, before, 1);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  it('a lapsed plan keeps the reads it is promised, and sends no new document', async () => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    await lapse(business.id);

    // What `trialEnded` promises still works.
    expect(LAPSED).toContain('*who owes me*, *records*, *payment details*');
    expect(await send('who owes me')).toContain('₦80,000');
    expect(await send('records')).toContain('Your books this month');
    expect(await send('payment details')).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
    expect(await send(`remind ${invoiceNumber}`)).toContain(`reminder for ${invoiceNumber}`);
    expect(await send('stock')).toContain('not counting any stock');

    // A resend delivers a document, which a lapsed plan does not.
    const before = await footprint(business.id);
    const mark = sendMark();
    expect(await send('resend')).toBe(LAPSED);
    await expectOnlyReplies(business.id, before, 1);
    expect(beyondTheMerchant(mark)).toEqual(NOTHING_BEYOND);
  });

  it('a short reply does not resume a read for a plan without Chat', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await moveToPlan(business.id, 'integrate');
    const requests = stubTransport.requests.length;
    const before = await footprint(business.id);

    // Not answered from the open question: the ordinary path, refused there.
    expect(await send('last month')).toBe(FREE_FORM_REFUSED);
    expect(stubTransport.requests).toHaveLength(requests);
    await expectOnlyReplies(business.id, before, 1);
  });

  /** A paid plan that lapsed: the renewal path stores it as `expired` itself. */
  async function lapsePaid(businessId: string) {
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'expired',
      expiresAt: null,
      actor: 'operator:g65',
    });
  }

  async function sendFrom(from: string, text: string) {
    await post(messagePayload(from, `wamid.G65-${++seq}`, text));
    await drain();
    await expectNoFailedJob();
    return stubSender.lastText ?? '';
  }

  it('a lapsed paid plan is told its plan ended, never that a free trial did', async () => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    await lapsePaid(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(replies.notSavedPlanEnded('plan').text);
    expect(await send('resend')).toBe(replies.planEnded().text);
    expect(stubSender.lastText).not.toContain('trial');
    await expectOnlyReplies(business.id, before, 2);
    // The reads the lapse keeps are kept here too.
    expect(await send('who owes me')).toContain('₦80,000');
  });

  it('a refused yes says first that nothing was saved, on each kind of refusal', async () => {
    for (const refused of [
      replies.notSavedNotInPlan(),
      replies.notSavedPlanEnded('trial'),
      replies.notSavedPlanEnded('plan'),
    ]) {
      expect(refused.text.startsWith('I did not save that.')).toBe(true);
    }
  });

  it('help, greeting and a failed dashboard link point only at what works on Integrate', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    const help = await send('help');
    expect(help).toBe(replies.helpWithoutChat(null, { owner: true, transacts: true }).text);
    expect(await send('hi')).toBe(replies.greetingWithoutChat(null).text);
    for (const refused of ['*records*', '*stock*', '*who owes me*', '*resend*', 'remind']) {
      expect(help).not.toContain(refused);
    }
    for (const works of ['*dashboard*', '*upgrade*', '*delete my data*', '*STOP*']) {
      expect(help).toContain(works);
    }

    // No web address configured: the link cannot be made.
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'dashboard'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    while (await runner.runOnce());
    expect(stubSender.lastText).toBe(replies.dashboardUnavailableWithoutChat().text);
    expect(stubSender.lastText).not.toContain('*records*');
  });

  it('a Chat plan keeps the ordinary help, greeting and dashboard sentence, byte for byte', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'chat');
    expect(await send('help')).toBe(replies.help().text);
    expect(await send('hi')).toBe(replies.greeting().text);

    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'dashboard'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    while (await runner.runOnce());
    expect(stubSender.lastText).toBe(replies.dashboardUnavailable().text);
  });

  it('a lapsed plan is told what still works, naming its kind of lapse', async () => {
    const business = await seedMerchant();
    await lapse(business.id);
    expect(await send('help')).toBe(
      replies.helpWithoutChat('trial', { owner: true, transacts: true }).text,
    );
    expect(await send('help')).toContain('*upgrade* and we will set you up to keep recording');
    expect(await send('hi')).toBe(replies.greetingWithoutChat('trial').text);
    await lapsePaid(business.id);
    expect(await send('help')).toBe(
      replies.helpWithoutChat('plan', { owner: true, transacts: true }).text,
    );
  });

  it('a retried yes that is refused gives back what its first attempt reserved', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);

    /* Attempt 1 meters the document unit (its own committed transaction),
     * then fails issuing: the job rolls back and the unit stays spent. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g65_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g65_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g65_once') = 1 THEN RAISE EXCEPTION 'g65: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g65_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g65_fail_once()`);

      await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await footprint(business.id)).document_credits).toBe('1');
      expect(await invoiceCount(business.id)).toBe(0);

      /* The plan loses Chat before the retry runs. */
      await moveToPlan(business.id, 'integrate');
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${business.id}::uuid
           AND state <> 'done'`);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g65_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g65_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g65_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(YES_REFUSED);
    expect((await footprint(business.id)).document_credits).toBe('0');
    expect(await invoiceCount(business.id)).toBe(0);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  it.each(['integrate', 'lapsed'] as const)(
    'cancel and no still drop a Chat draft on a %s plan',
    async (standing) => {
      for (const word of ['cancel', 'no']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        await send('Ada bought 3 wigs for 300k', A_SALE);
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);

        expect(await send(word)).toBe(replies.cancelled().text);
        expect(await draftStates(business.id)).toEqual(['superseded']);
        expect(await invoiceCount(business.id)).toBe(0);
      }
    },
  );

  it('a yes on the Complete plan confirms as on Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'complete');
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    expect(await send('yes')).toContain('INV-');
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('a lapsed plan keeps a resumed read, as it keeps records', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await lapse(business.id);
    const requests = stubTransport.requests.length;
    const before = await footprint(business.id);

    const said = await send('last month');
    expect(said).not.toBe(LAPSED);
    expect(said).not.toBe(FREE_FORM_REFUSED);
    expect(said).toMatch(/sales/i);
    expect(stubTransport.requests).toHaveLength(requests);
    expect((await footprint(business.id)).ai_actions).toBe(before.ai_actions);
  });

  it('a view-only member on Integrate meets the plan before the role', async () => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const mark = sendMark();

    expect(await sendFrom('2348039990001', `remind ${invoiceNumber}`)).toBe(REFUSED);
    expect(await sendFrom('2348039990001', 'payment details')).toBe(REFUSED);
    expect(beyondTheMerchant(mark)).toMatchObject({ documents: 0, customerTexts: 0, mints: 0 });
    await expectOnlyReplies(business.id, before, 2);

    // On a Chat plan the same member is refused by role, as before.
    await moveToPlan(business.id, 'chat');
    expect(await sendFrom('2348039990001', 'payment details')).toBe(replies.viewOnlyRole().text);
  });

  /**
   * Pinned: a yes after the plan lapsed, with a resumed read since the
   * preview, is refused before Build 6's read pointer runs. Nothing moves:
   * not the read, not the preview, not a meter.
   */
  it('a lapsed yes after a resumed read is refused and changes nothing', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await send('how much did I sell?', HOW_MUCH_DID_I_SELL);
    await send('last month');
    await lapse(business.id);
    const states = await draftStates(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_LAPSED);

    expect(await draftStates(business.id)).toEqual(states);
    await expectOnlyReplies(business.id, before, 1);
  });

  /** A voice note or a photograph, as Meta delivers it. */
  function mediaPayload(kind: 'audio' | 'image', wamid: string) {
    const media =
      kind === 'audio'
        ? { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg', voice: true } }
        : { type: 'image', image: { id: 'photo-1', mime_type: 'image/jpeg' } };
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
                messages: [{ id: wamid, from: OWNER, timestamp: '1700000000', ...media }],
              },
            },
          ],
        },
      ],
    };
  }

  it.each([
    ['trial', replies.trialEnded().text],
    ['paid', replies.planEnded().text],
  ] as const)(
    'a %s lapse hears the true sentence on the model path, voice and photo',
    async (kind, expected) => {
      const business = await seedMerchant();
      if (kind === 'trial') await lapse(business.id);
      else await lapsePaid(business.id);

      // The model path: refused before the model, as always; only the copy.
      expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toBe(expected);
      for (const media of ['audio', 'image'] as const) {
        await post(mediaPayload(media, `wamid.G65-${++seq}`));
        await drain();
        await expectNoFailedJob();
        expect(stubSender.lastText, media).toBe(expected);
      }
      expect(stubTransport.requests).toHaveLength(0);
      expect(stubStt.calls).toHaveLength(0);
      if (kind === 'paid') expect(stubSender.lastText).not.toContain('trial');
    },
  );

  it('START, a stray number and a yes with nothing waiting point at what works without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await send('7')).toBe(replies.strayNumberWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
    for (const said of [
      replies.optedInWithoutChat().text,
      replies.strayNumberWithoutChat().text,
      replies.nothingToConfirmWithoutChat().text,
    ]) {
      expect(said).not.toMatch(/sale|record/i);
    }

    await lapse(business.id);
    expect(await send('7')).toBe(replies.strayNumberWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
  });

  it('a Chat plan keeps the ordinary START, stray-number and nothing-to-confirm copy', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'chat');
    expect(await send('START')).toBe(replies.optedIn().text);
    expect(await send('7')).toBe(replies.strayNumber().text);
    expect(await send('yes')).toBe(replies.nothingToConfirm().text);
  });

  it('help names delete my data only to the owner, the one member it works for', async () => {
    const business = await seedMerchant();
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    await moveToPlan(business.id, 'integrate');

    const forMember = await sendFrom('2348039990001', 'help');
    expect(forMember).toBe(replies.helpWithoutChat(null, { owner: false, transacts: false }).text);
    expect(forMember).not.toContain('delete my data');
    expect(await send('help')).toContain('*delete my data*');
  });

  /**
   * Codex, PR #261: help named *payment details* to an accountant on a lapsed
   * plan, which then refused them by role. The rule, asserted generically:
   * every command `help` names is one THIS member can run, on THIS plan.
   */
  it.each([
    ['the owner', 'lapsed'],
    ['an accountant', 'lapsed'],
    ['the owner', 'integrate'],
    ['an accountant', 'integrate'],
  ] as const)('help names only what %s can run on a %s plan', async (who, standing) => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    if (standing === 'lapsed') await lapse(business.id);
    else await moveToPlan(business.id, 'integrate');
    const from = who === 'the owner' ? OWNER : '2348039990001';

    const help = await sendFrom(from, 'help');
    const named = [...help.matchAll(/\*([^*]+)\*/g)]
      .map((m) => m[1]!)
      // STOP works for everyone by law; sending it here would opt them out.
      .filter((command) => command !== 'STOP');
    expect(named.length).toBeGreaterThan(0);
    if (who === 'an accountant') {
      expect(named).not.toContain('payment details');
      expect(named).not.toContain('delete my data');
    }

    const REFUSALS = [
      replies.viewOnlyRole().text,
      replies.erasureNotYours().text,
      replies.chatCommandNotInPlan().text,
      replies.chatNotInPlan().text,
      replies.trialEnded().text,
      replies.planEnded().text,
    ];
    for (const command of named) {
      const said = await sendFrom(from, command);
      expect(REFUSALS, `${who} sent *${command}*`).not.toContain(said);
    }
    expect(stubTransport.requests).toHaveLength(0);
  });

  /**
   * Codex, PR #261 (second pass): the lapse sentence told an accountant that
   * *payment details* still works, which refuses them by role. Asserted on
   * both kinds of lapse, from a refused command and from the model path, by
   * sending every command the sentence names as that member.
   */
  it.each([
    ['trial', replies.trialEnded(false).text],
    ['paid', replies.planEnded(false).text],
  ] as const)(
    'a %s lapse names to a view-only member only what they can run',
    async (kind, expected) => {
      const business = await seedMerchant();
      await seedBooks(business.id);
      const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
      await identity.addMembership(db, business.id, accountant.id, 'accountant');
      if (kind === 'trial') await lapse(business.id);
      else await lapsePaid(business.id);
      const ACCOUNTANT = '2348039990001';

      expect(await sendFrom(ACCOUNTANT, 'resend')).toBe(expected);
      stubTransport.replyWith(A_SALE);
      expect(await sendFrom(ACCOUNTANT, 'Ada bought 3 wigs for 300k')).toBe(expected);
      expect(expected).not.toContain('payment details');

      const named = [...expected.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]!);
      expect(named.length).toBeGreaterThan(0);
      for (const command of named) {
        const said = await sendFrom(ACCOUNTANT, command);
        expect(
          [
            replies.viewOnlyRole().text,
            replies.trialEnded(false).text,
            replies.planEnded(false).text,
          ],
          `the accountant sent *${command}*`,
        ).not.toContain(said);
      }
      // The owner still reads the sentence every owner always has.
      expect(await send('resend')).toBe(
        kind === 'trial' ? replies.trialEnded().text : replies.planEnded().text,
      );
      expect(stubTransport.requests).toHaveLength(0);
    },
  );

  /* ── Build 7 (G-68, G-24) surfaces, after the rebase ───────────────────── */

  const A_POS_PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
    productMention: 'cartons',
    quantity: 10,
  };
  const POS_QUESTION = 'did it come from your bank account or from physical cash?';

  async function continuationRows(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ expects: string | null; state: string }>(sql`
        SELECT expects, state FROM conversation_continuations
         WHERE business_id = ${businessId}::uuid ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => `${r.expects}:${r.state}`);
  }

  async function askFunding() {
    expect(
      await send('I bought 10 cartons for 180k from Emeka with POS', A_POS_PURCHASE),
    ).toContain(POS_QUESTION);
  }

  it('a questioned yes points a plan without Chat at no yes it would refuse', async () => {
    const business = await seedMerchant();
    // Nothing waiting: what works, not "tell me a sale".
    await moveToPlan(business.id, 'integrate');
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);

    // A preview waiting from before the switch: nothing was saved, never "reply yes".
    await moveToPlan(business.id, 'chat');
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const states = await draftStates(business.id);
    expect(await send('yes?')).toBe(YES_REFUSED);
    expect(await send('na so?')).toBe(YES_REFUSED);
    await expectOnlyReplies(business.id, before, 2);
    expect(await draftStates(business.id)).toEqual(states);

    // On a lapsed plan, the lapse is named.
    await lapse(business.id);
    expect(await send('yes?')).toBe(YES_LAPSED);
  });

  it('a questioned yes still keeps the data between two erasure asks without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('yes?')).toBe(replies.erasureKept().text);
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
  });

  it('a "bank" answer on a plan without Chat is refused before the question is claimed', async () => {
    const business = await seedMerchant();
    await askFunding();
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);

    // Build 7's sentence, unchanged; the question stays open, nothing is rebuilt.
    expect(await send('bank')).toBe(replies.chatNotInPlan().text);
    expect(await continuationRows(business.id)).toEqual(['funding_source:open']);
    await expectOnlyReplies(business.id, before, 1);

    // The same "bank" works the moment Chat is back.
    await moveToPlan(business.id, 'chat');
    expect(await send('bank')).toContain('Reply *yes*');
  });

  it('a "cash" answer after a PAID lapse is told the plan ended, never a free trial', async () => {
    const business = await seedMerchant();
    await askFunding();
    await lapsePaid(business.id);
    expect(await send('cash')).toBe(replies.planEnded().text);
    expect(await continuationRows(business.id)).toEqual(['funding_source:open']);
  });

  it('a yes to the funding question re-opens nothing on a plan without Chat', async () => {
    const business = await seedMerchant();
    await askFunding();
    await moveToPlan(business.id, 'integrate');
    const rows = await continuationRows(business.id);

    // Not "Reply bank or cash": a "bank" would be refused.
    const said = await send('yes');
    expect(said).toBe(YES_REFUSED);
    expect(said).not.toContain('*bank*');
    expect(await continuationRows(business.id)).toEqual(rows);
  });

  it('a "no" with nothing waiting invites no sale on a plan without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('no')).toBe(replies.nothingToDeclineWithoutChat().text);
    expect(await send('cancel')).toBe(replies.nothingToCancel().text);
    await moveToPlan(business.id, 'chat');
    expect(await send('no')).toBe(replies.nothingToDecline().text);
  });

  it('a chosen option does not suggest *remind* to a plan without Chat', async () => {
    const business = await seedMerchant();
    const openList = async () => {
      const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
      await withBusiness(db, business.id, async (tx) => {
        const thread = await conversationsRepo.recordInbound(
          tx,
          {
            businessId: business.id,
            channel: 'meta',
            kind: 'text',
            body: '[list]',
            providerMessageId: `wamid.G65-list-${++seq}`,
          },
          { kind: 'MERCHANT', businessId: business.id, channel: 'meta' },
        );
        await continuationsRepo.openContinuation(tx, {
          businessId: business.id,
          userId: user.id,
          sourceMessageId: thread.id,
          state: {
            kind: 'clarification',
            expects: 'choice',
            topic: 'debtors',
            options: [
              { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
              { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000002' } },
            ],
          },
        });
      });
    };
    await moveToPlan(business.id, 'integrate');
    await openList();
    const said = await send('2');
    expect(said).toBe(replies.optionChosenWithoutChat('INV-2026-000002').text);
    expect(said).not.toContain('*remind');

    await moveToPlan(business.id, 'chat');
    await openList();
    expect(await send('2')).toBe(replies.optionChosen('INV-2026-000002').text);
  });

  /* ── expired drafts on a plan without Chat (post-rebase review) ────────── */

  /** Days pass: every pending draft's window closes. */
  const expireDrafts = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
         WHERE business_id = ${businessId}::uuid AND state = 'pending'`),
    );

  it.each(['integrate', 'lapsed'] as const)(
    'an expired erasure ask is "Kept" to a yes and a yes? alike on a %s plan',
    async (standing) => {
      for (const word of ['yes', 'yes?']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);
        expect(await send('delete my data')).toBe(replies.confirmErasure().text);
        await expireDrafts(business.id);
        expect(await send(word), word).toBe(replies.erasureKept().text);
      }
    },
  );

  it.each([
    ['integrate', replies.draftExpiredWithoutChat(null).text],
    ['lapsed', replies.draftExpiredWithoutChat('trial').text],
  ] as const)(
    'an expired preview invites no resend to a yes or a yes? on a %s plan',
    async (standing, expected) => {
      for (const word of ['yes', 'yes?']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        await send('Ada bought 3 wigs for 300k', A_SALE);
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);
        await expireDrafts(business.id);
        const before = await footprint(business.id);
        const said = await send(word);
        expect(said, word).toBe(expected);
        expect(said).not.toMatch(/send it again/i);
        await expectOnlyReplies(business.id, before, 1);
      }
    },
  );

  it('an expired preview on a Chat plan keeps the ordinary sentence', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await expireDrafts(business.id);
    expect(await send('yes')).toBe(replies.draftExpired().text);
  });

  it('an expired question that was never a preview is "nothing waiting" without Chat', async () => {
    const business = await seedMerchant();
    // The model asks a question: a draft, never a preview.
    expect(
      await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' }),
    ).toContain('How many wigs?');
    await moveToPlan(business.id, 'integrate');
    await expireDrafts(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
  });

  it('a period Rekoda cannot count keeps no question open for a plan without Chat', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await moveToPlan(business.id, 'integrate');
    // Not "I can count these windows": the ordinary path, refused there.
    expect(await send('yesterday')).toBe(FREE_FORM_REFUSED);
  });

  /**
   * A yes that reached Rekoda before the preview it would confirm (CG2) is
   * told "a preview is waiting, reply yes". On a plan that has lost Chat
   * since, that invites a yes it would refuse: it is told nothing was saved.
   */
  it('a yes that arrived before its preview invites no refused yes without Chat', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith(AN_EXPENSE);
    // Both arrive before either is handled.
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'bought fuel 20k cash'));
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'yes'));
    // The preview is written while the plan still holds Chat...
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *yes*');
    // ...and the yes is handled after the switch.
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    await drain();
    await expectNoFailedJob();

    expect(stubSender.lastText).toBe(YES_REFUSED);
    await expectOnlyReplies(business.id, before, 1);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  /**
   * Codex, PR #261 (final head): a live question Rekoda asked, never a
   * preview, is not something a "yes?" could have saved. Without Chat it is
   * "nothing waiting", as the Chat-plan path says, never "I did not save that".
   */
  it('a yes? to a live question that was never a preview is "nothing waiting" without Chat', async () => {
    const business = await seedMerchant();
    expect(
      await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' }),
    ).toContain('How many wigs?');
    await moveToPlan(business.id, 'integrate');
    const states = await draftStates(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
    expect(await draftStates(business.id)).toEqual(states);
    await lapse(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
  });

  /**
   * "yes" and "yes?" agree on a draft the merchant was never shown as a
   * preview (final-head review): a live question Rekoda asked, and a preview
   * whose send failed (marked unseen). Both are "nothing waiting" on a plan
   * without Chat; neither is told a save was refused.
   */
  it.each([
    ['integrate', 'a live question'],
    ['lapsed', 'a live question'],
    ['integrate', 'an unseen preview'],
    ['lapsed', 'an unseen preview'],
  ] as const)('on a %s plan, yes and yes? agree on %s', async (standing, kind) => {
    const answers: string[] = [];
    for (const word of ['yes', 'yes?']) {
      await truncateAll(urls);
      const business = await seedMerchant();
      if (kind === 'a live question') {
        await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' });
      } else {
        await send('Ada bought 3 wigs for 300k', A_SALE);
        // The preview's send failed: the draft is marked as never seen.
        await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`
            UPDATE command_drafts SET previewed = false
             WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
        );
      }
      if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
      else await lapse(business.id);
      const states = await draftStates(business.id);
      answers.push(await send(word));
      expect(await draftStates(business.id), word).toEqual(states);
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toBe(replies.nothingToConfirmWithoutChat().text);
  });
});

/**
 * G-81, OD-23: one real-world purchase must never become two financial
 * truths, and two real purchases must never be collapsed because they share
 * an amount, a product, a supplier or a day. A purchase that may be one
 * already waiting or booked is ASKED about ("same" or "separate"), never
 * silently dropped and never silently booked; the final net sits in the
 * purchase work, under a lock, before any posting.
 */
describe('one real purchase, one financial truth (G-81, OD-23)', () => {
  const OWNER = '2348031234567';
  const DELEGATE = '2348039990002';
  const UNCLEAR = { intent: 'Unclear', clarification: 'What would you like me to do?' };
  const MILO = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons of Milo',
    amount: 100_000,
    reportedPayment: 100_000,
    paymentMethod: 'cash',
    productMention: 'Milo',
    quantity: 10,
  };
  const QUESTION = 'Is this the same purchase?';
  const SAME_DONE = 'OK, nothing more was saved.';
  const SEPARATE_LEAD = 'OK, this is a separate purchase.\n\nPlease check this before I save it:';
  const REASK = 'Please reply *same* or *separate*';
  const CLOSED = 'That question has closed, so nothing was saved.';
  const RACE = 'Nothing was saved from your yes.';

  async function seedMerchant(phone = `+${OWNER}`) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Provisions',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function addDelegate(businessId: string) {
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, businessId, delegate.id, 'delegate');
    return delegate.id;
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(wamid: string, command: Record<string, unknown>, text: string, from = OWNER) {
    stubTransport.replyWith(command);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function reply(wamid: string, text: string, from = OWNER) {
    stubTransport.replyWith(UNCLEAR);
    await post(messagePayload(from, wamid, text));
    await drain();
  }

  async function purchaseStates(businessId: string): Promise<string[]> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string }>(sql`
        SELECT state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent = 'RecordPurchase'
         ORDER BY insertion_seq`),
    );
    return [...rows].map((r) => r.state);
  }

  /** Every row a purchase confirmation can write, counted (test 6). */
  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS arrivals,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM ledger_entries WHERE business_id = ${businessId}::uuid) AS entries,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT coalesce(sum(last_seq), 0)::int FROM doc_counters WHERE business_id = ${businessId}::uuid) AS numbers,
            (SELECT count(*)::int FROM outbox_events WHERE business_id = ${businessId}::uuid AND type = 'purchase.recorded') AS events,
            (SELECT count(*)::int FROM idempotency_records WHERE business_id = ${businessId}::uuid) AS keys,
            (SELECT coalesce(sum(used), 0)::int FROM usage_counters WHERE business_id = ${businessId}::uuid) AS units,
            (SELECT count(*)::int FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
              WHERE e.business_id = ${businessId}::uuid AND a.code IN ('1000', '1010', '1020', '2000')) AS cash_bank_ap,
            (SELECT count(*)::int FROM documents WHERE business_id = ${businessId}::uuid) AS documents,
            (SELECT count(*)::int FROM audit_events WHERE business_id = ${businessId}::uuid) AS audit
        `),
      )),
    ];
    return row!;
  }

  async function purchases(businessId: string): Promise<number> {
    return (await footprint(businessId)).purchases!;
  }

  /** Known identities, as a business that has traded before has them. */
  async function knownSupplier(businessId: string, name: string) {
    const known = await deps.gateway.resolveSupplierMention(businessId, name);
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE suppliers SET created_at = clock_timestamp() - interval '30 days'
         WHERE business_id = ${businessId}::uuid AND id = ${known!.supplierId}::uuid`),
    );
  }

  /** A TRUSTED product (owner ruling D3): linked to a catalogue item. */
  async function knownProduct(businessId: string, name: string) {
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
      await tx.execute(sql`
        UPDATE products SET external_catalogue_id = ${`cat-${product.id}`}
         WHERE business_id = ${businessId}::uuid AND id = ${product.id}::uuid`);
    });
  }

  async function bookMilo(businessId: string, tag: string, from = OWNER) {
    await say(
      `wamid.${tag}-buy`,
      MILO,
      'I bought 10 cartons of Milo from Emeka for 100k cash',
      from,
    );
    expect(stubSender.lastText).toContain('Paid in full by cash');
    await reply(`wamid.${tag}-yes`, 'yes', from);
    expect(stubSender.lastText).toContain('Saved ✅ ₦100,000 stock purchase.');
  }

  describe('1. a provider replay is a no-op', () => {
    it('the same message delivered twice gives one draft, one reply and one booking', async () => {
      const business = await seedMerchant();
      stubTransport.replyWith(MILO);
      const payload = messagePayload(
        OWNER,
        'wamid.R1-buy',
        'I bought 10 cartons of Milo for 100k cash',
      );
      await post(payload);
      await post(payload);
      await drain();
      await post(payload);
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['pending']);
      const yes = messagePayload(OWNER, 'wamid.R1-yes', 'yes');
      await post(yes);
      await drain();
      await post(yes);
      await drain();
      expect(await purchases(business.id)).toBe(1);
      expect(stubSender.sent.length).toBe(2);
    });
  });

  describe('2. the same member sending it again never books it twice', () => {
    it('a resend while the first preview waits replaces it, and two yeses book it once', async () => {
      const business = await seedMerchant();
      await say('wamid.S2-a', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await say('wamid.S2-b', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain('Your earlier preview of ₦100,000 was replaced');
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await reply('wamid.S2-yes-1', 'yes');
      await reply('wamid.S2-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a resend after the purchase was booked is asked about, and "same" saves nothing more', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'S2b');
      await say('wamid.S2b-again', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('sent by you');
      await reply('wamid.S2b-ask-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.S2b-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.S2b-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('3. two members, one purchase', () => {
    it('the delegate is asked, and every yes books it ONCE', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.X3-o', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await say(
        'wamid.X3-d',
        MILO,
        'I bought 10 cartons of Milo from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('another member');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      await reply('wamid.X3-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.X3-o-yes', 'yes');
      await reply('wamid.X3-d-same', 'same', DELEGATE);
      await reply('wamid.X3-d-yes-2', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('after the owner booked it, the delegate sending it again is asked, never booked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'X3b');
      await say('wamid.X3b-d', MILO, 'I bought 10 cartons of Milo from Emeka for 100k', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('A stock purchase of ₦100,000 was already saved');
      await reply('wamid.X3b-d-yes', 'yes', DELEGATE);
      await reply('wamid.X3b-d-yes-2', 'na so', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('4. a draft with no recorded requester is never the same member', () => {
    it('a member and an unattributed preview of one purchase cannot both book', async () => {
      const business = await seedMerchant();
      await say('wamid.N4-a', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET requested_by = NULL WHERE business_id = ${business.id}::uuid`),
      );
      await say('wamid.N4-b', MILO, 'I bought 10 cartons of Milo from Emeka for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).not.toContain('replaced');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      await reply('wamid.N4-yes-1', 'yes');
      await reply('wamid.N4-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(0);
      await reply('wamid.N4-same', 'same');
      await reply('wamid.N4-yes-3', 'yes');
      await reply('wamid.N4-yes-4', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('5 and 6. a duplicate that reaches a yes is stopped in the purchase work', () => {
    /* Two pending previews of one purchase that nothing proves separate:
     * built here by hand, as drafts from before this fix would leave them,
     * because the chat flow no longer produces them. */
    async function twoPendingPreviews(businessId: string) {
      await addDelegate(businessId);
      await say(
        'wamid.F6-o',
        { ...MILO, supplierReference: 'invoice 0101' },
        'Milo 100k, receipt EMK-0101',
      );
      await say(
        'wamid.F6-d',
        { ...MILO, supplierReference: 'invoice 0202' },
        'Milo 100k, receipt EMK-0202',
        DELEGATE,
      );
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command - 'supplierReference'
           WHERE business_id = ${businessId}::uuid`),
      );
      expect(await purchaseStates(businessId)).toEqual(['pending', 'pending']);
    }

    it('the second yes is refused truthfully, and leaves no footprint', async () => {
      const business = await seedMerchant();
      await twoPendingPreviews(business.id);
      /* OD-15: a yes confirms the newest preview, the delegate's. */
      await reply('wamid.F6-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      const before = await footprint(business.id);
      await reply('wamid.F6-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await footprint(business.id)).toEqual(before);
      expect(await purchaseStates(business.id)).toEqual(['held', 'confirmed']);
      await reply('wamid.F6-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await footprint(business.id)).toEqual(before);
    });

    it('through the command bus too: no idempotency record survives the refusal', async () => {
      const config = deps.config as { commandRecordPurchase: boolean };
      const was = config.commandRecordPurchase;
      config.commandRecordPurchase = true;
      try {
        const business = await seedMerchant();
        await twoPendingPreviews(business.id);
        await reply('wamid.F6b-yes-1', 'yes');
        const before = await footprint(business.id);
        expect(before.keys).toBe(1);
        await reply('wamid.F6b-yes-2', 'yes');
        expect(stubSender.lastText).toContain(RACE);
        expect(await footprint(business.id)).toEqual(before);
      } finally {
        config.commandRecordPurchase = was;
      }
    });
  });

  describe('7. two real purchases of the same amount are both bookable', () => {
    it('"another 10 cartons" is asked about, and "separate" books the second', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'N7');
      await say(
        'wamid.N7-d',
        MILO,
        'I bought another 10 cartons of Milo from Emeka for ₦100,000 today',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.N7-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await reply('wamid.N7-d-yes', 'yes', DELEGATE);
      const books = await footprint(business.id);
      expect(books.purchases).toBe(2);
      expect(books.arrivals).toBe(2);
    });
  });

  describe('8. a different KNOWN product is a different purchase (dormant: no catalogue writer yet)', () => {
    /* DORMANT in production (fresh review of 75fd1c9): nothing writes
     * `external_catalogue_id` today, so this proof is set up by hand here and
     * no live purchase is proven separate by product. Before any catalogue
     * writer ships, product proof must never rest on a raw name match. */
    it('same supplier and amount, another known product: no question, both book', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownSupplier(business.id, 'Emeka');
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await bookMilo(business.id, 'P8');
      await say(
        'wamid.P8-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).not.toContain(QUESTION);
      await reply('wamid.P8-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    it('a product named for the first time proves nothing: asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownSupplier(business.id, 'Emeka');
      await bookMilo(business.id, 'P8b');
      await say(
        'wamid.P8b-new',
        { ...MILO, description: '10 cartons of Milo 400g', productMention: 'Milo 400g' },
        'I bought 10 cartons of Milo 400g from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('quantity alone never proves a different purchase', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P8c');
      await say(
        'wamid.P8c-q',
        { ...MILO, quantity: 12, description: '12 cartons of Milo' },
        'I bought 12 cartons of Milo from Emeka for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('9. a different explicit reference is a different purchase', () => {
    it('same product and amount, another supplier receipt number: no question, both book', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F9-a',
        { ...MILO, supplierReference: 'receipt 0041' },
        'Milo 100k receipt EMK-0041',
      );
      await reply('wamid.F9-a-yes', 'yes');
      await say(
        'wamid.F9-b',
        { ...MILO, supplierReference: 'receipt 0042' },
        'Milo 100k receipt EMK-0042',
        DELEGATE,
      );
      expect(stubSender.lastText).not.toContain(QUESTION);
      await reply('wamid.F9-b-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    it('the SAME reference is asked about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.F9c-a',
        { ...MILO, supplierReference: 'receipt 0041' },
        'Milo 100k receipt EMK-0041',
      );
      await reply('wamid.F9c-a-yes', 'yes');
      await say(
        'wamid.F9c-b',
        { ...MILO, supplierReference: 'RCPT-41' },
        'Milo 100k receipt emk 0041',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('10. the same purchase in other words is still found', () => {
    it('different wording and a different supplier and product spelling: asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'W10');
      await say(
        'wamid.W10-d',
        {
          ...MILO,
          supplierMention: 'Emeka Stores',
          description: 'milo ten cartons',
          productMention: 'cartons of milo',
          paymentMethod: 'transfer',
        },
        'Milo, ten cartons, Emeka Stores, 100k transfer',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('a booked purchase older than 24 hours is not compared', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'W10b');
      /* D2 measures from the earlier purchase's MESSAGE: it and its booking
       * both happened 25 hours ago. */
      await withBusiness(db, business.id, async (tx) => {
        for (const table of ['expenses', 'conversation_messages', 'external_events']) {
          await tx.execute(sql`
            UPDATE ${sql.raw(table)} SET created_at = clock_timestamp() - interval '25 hours'
             WHERE business_id = ${business.id}::uuid`);
        }
      });
      await say('wamid.W10b-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });
  });

  describe('11. an expired question cannot execute', () => {
    it('"separate" after the question closed rebuilds nothing, and a yes saves nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'E11');
      await say('wamid.E11-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 hour'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '1 hour'
           WHERE business_id = ${business.id}::uuid`);
      });
      const before = await footprint(business.id);
      await reply('wamid.E11-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(CLOSED);
      /* No model call, so no unit, and nothing written. */
      expect(stubTransport.requests).toHaveLength(0);
      expect(await footprint(business.id)).toEqual(before);
      await reply('wamid.E11-d-yes', 'yes', DELEGATE);
      /* Past its window the question asks nothing (fresh review of #262): the
       * yes is answered as one with nothing waiting, and saves nothing. */
      expect(stubSender.lastText).toBe(replies.nothingToConfirm().text);
      expect(await purchases(business.id)).toBe(1);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });
  });

  describe('12. G-23 still governs every preview', () => {
    it('the fresh preview "separate" shows has its own window, and the held draft never expires into a yes', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G12');
      await say('wamid.G12-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await withBusiness(db, business.id, (tx) =>
        conversationsRepo.expireStaleDrafts(tx, business.id, {
          now: new Date(Date.now() + 86_400_000),
        }),
      );
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      await reply('wamid.G12-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 day'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await reply('wamid.G12-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toBe(replies.draftExpired().text);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('13. G-61 still asks where the money came from first', () => {
    const POS = { ...MILO, paymentMethod: 'pos' };
    const POS_QUESTION = 'did it come from your bank account or from physical cash?';

    it('a POS duplicate is asked the funding question, then the identity question on "cash"', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G13');
      await say('wamid.G13-pos', POS, 'I bought 10 cartons of Milo for 100k by POS', DELEGATE);
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await reply('wamid.G13-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.G13-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.G13-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('14. Pidgin answers and continuation rules', () => {
    it('"na the same" is same', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14a');
      await say('wamid.P14a-d', MILO, 'I buy 10 carton Milo 100k cash', DELEGATE);
      await reply('wamid.P14a-same', 'na the same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"same?" is unsure and re-asks; "abeg na another one o" is separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14b');
      await say('wamid.P14b-d', MILO, 'I buy another 10 carton Milo 100k cash', DELEGATE);
      await reply('wamid.P14b-unsure', 'same?', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      await reply('wamid.P14b-sep', 'abeg na another one o', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.P14b-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });

    /* G-85: "same" or "separate" with a mark drawn over it decides nothing:
     * no link, no second booking, the purchase stays held and is asked
     * about again. */
    it.each(['same⃘', 'na sameͯ', 'separate͓', 'another one⃚'])(
      'G-85: a marked %j re-asks, and the purchase stays held',
      async (text) => {
        const business = await seedMerchant();
        await addDelegate(business.id);
        await bookMilo(business.id, 'G85i');
        await say('wamid.G85i-d', MILO, 'I buy another 10 carton Milo 100k cash', DELEGATE);
        await reply('wamid.G85i-marked', text, DELEGATE);
        expect(stubSender.lastText).toContain(REASK);
        /* `reply` resets the transport log: none since means no model. */
        expect(stubTransport.requests).toHaveLength(0);
        expect(await purchases(business.id)).toBe(1);
        expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
        /* A plain answer still decides it. */
        await reply('wamid.G85i-same', 'same', DELEGATE);
        expect(stubSender.lastText).toContain(SAME_DONE);
        expect(await purchases(business.id)).toBe(1);
      },
    );

    it('another member\'s "same" answers nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14c');
      await say('wamid.P14c-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.P14c-o-same', 'same');
      expect(stubSender.lastText).not.toContain(SAME_DONE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });

    it('a question that was never delivered is withdrawn, and "same" answers nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'P14d');
      stubSender.failWith();
      await say('wamid.P14d-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      await reply('wamid.P14d-same', 'same', DELEGATE);
      expect(stubSender.lastText).not.toContain(SAME_DONE);
    });
  });

  describe('15. the answers meet the plan gates (G-65 compatible)', () => {
    it('"same" sends no document, and "separate" on a lapsed plan drafts nothing', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'G15');
      await say('wamid.G15-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      const documents = stubSender.documents.length;
      await billingRepo.setPlan(db, {
        businessId: business.id,
        plan: 'trial',
        expiresAt: new Date(Date.now() - 1_000),
        actor: 'operator:test-clock',
      });
      await reply('wamid.G15-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toBe(replies.trialEnded().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      await reply('wamid.G15-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.documents.length).toBe(documents);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of #262', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };

    /* Two pending previews of one purchase nothing proves separate, as in
     * tests 5 and 6: built by hand, because the chat flow no longer makes
     * them. The owner's is older; a yes confirms the delegate's first. */
    async function twoPending(businessId: string, tag: string) {
      await addDelegate(businessId);
      await say(
        `wamid.${tag}-o`,
        { ...MILO, supplierReference: 'invoice 0101' },
        'Milo 100k EMK-0101',
      );
      await say(
        `wamid.${tag}-d`,
        { ...MILO, supplierReference: 'invoice 0202' },
        'Milo 100k EMK-0202',
        DELEGATE,
      );
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command - 'supplierReference'
           WHERE business_id = ${businessId}::uuid`),
      );
    }

    it('P1: "separate" after a refusal at the yes excuses the booking it was asked about', async () => {
      const business = await seedMerchant();
      await twoPending(business.id, 'C1');
      await reply('wamid.C1-yes-1', 'yes');
      await reply('wamid.C1-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      await reply('wamid.C1-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.C1-yes-3', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('P2: a refusal whose question never reached the merchant puts the preview back', async () => {
      const business = await seedMerchant();
      await twoPending(business.id, 'C3');
      await reply('wamid.C3-yes-1', 'yes');
      stubSender.failWith();
      await reply('wamid.C3-yes-2', 'yes');
      /* Fresh review of #262: put back as it was before the yes (pending),
       * so the next yes is refused and asked again (see I5 below). */
      expect(await purchaseStates(business.id)).toEqual(['pending', 'confirmed']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P1: a yes from a member being asked never books an older preview behind another member’s question', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C4');
      /* An older, unrelated preview of the owner's, still waiting. */
      await say('wamid.C4-rice', RICE, 'bought 5 bags rice 50k cash');
      /* The owner is asked about Milo; then the delegate is asked too. */
      await say('wamid.C4-o-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await say('wamid.C4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.C4-o-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: a funding answer whose identity question never reached the merchant gives the funding question back', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C5');
      await say(
        'wamid.C5-pos',
        { ...MILO, paymentMethod: 'pos' },
        'I bought 10 cartons of Milo for 100k by POS',
        DELEGATE,
      );
      stubSender.failWith();
      await reply('wamid.C5-cash-1', 'cash', DELEGATE);
      await reply('wamid.C5-cash-2', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: "same" about another member’s waiting preview never says only they can confirm it', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.C6-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say('wamid.C6-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.C6-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.lastText).not.toContain('member who sent it');
    });
  });

  describe('Codex review of #262, round 2', () => {
    const REF = (supplierReference: string) => ({ ...MILO, supplierReference });

    it('P2: a question asked by a job that ran late opens its window when it is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D1');
      stubTransport.replyWith(MILO);
      await post(
        messagePayload(DELEGATE, 'wamid.D1-d', 'I bought 10 cartons of Milo for 100k cash'),
      );
      /* The webhook was stored fifteen minutes before its job ran, and the
       * owner's purchase had been booked before that. */
      await withBusiness(db, business.id, async (tx) => {
        /* The owner's messages reached Rekoda before this one did. */
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '30 minutes'
           WHERE business_id = ${business.id}::uuid AND external_id <> 'wamid.D1-d'`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '15 minutes'
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.D1-d'`);
        await tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '20 minutes'
           WHERE business_id = ${business.id}::uuid`);
      });
      await drain();
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.D1-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
    });

    it('P1: "separate" after a re-asked question excuses the match it was re-asked about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D2');
      /* The delegate is asked about the owner's booking. */
      await say('wamid.D2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* Meanwhile the owner books another, declared separate. */
      await say('wamid.D2-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.D2-o-sep', 'separate');
      await reply('wamid.D2-o-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
      /* The delegate's "separate" is asked about the new booking ... */
      await reply('wamid.D2-d-sep-1', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* ... and a second "separate" is about THAT one, so it proceeds. */
      await reply('wamid.D2-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.D2-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(3);
    });

    it('P2: a re-asked question that never reached the merchant can still be answered', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'D3');
      await say('wamid.D3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.D3-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.D3-o-sep', 'separate');
      await reply('wamid.D3-o-yes', 'yes');
      stubSender.failWith();
      await reply('wamid.D3-d-sep-1', 'separate', DELEGATE);
      /* Nobody saw the re-asked question: the question stays answerable, and
       * the new booking is NOT treated as one the delegate declared separate. */
      await reply('wamid.D3-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(2);
    });

    it('P1: a yes retried more than 24 hours after a matching booking is still refused', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.D4-o', REF('invoice 0101'), 'Milo 100k EMK-0101');
      await say('wamid.D4-d', REF('invoice 0202'), 'Milo 100k EMK-0202', DELEGATE);
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command - 'supplierReference'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.D4-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      /* Both previews and the booking happened 25 hours before this yes ran. */
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE conversation_messages SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE command_drafts SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.D4-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P1: a purchase recorded after a "separate" answer is never excused by its message time', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.D5-o', REF('invoice 0707'), 'Milo 100k EMK-0707');
      await reply('wamid.D5-o-yes', 'yes');
      await say('wamid.D5-d', REF('invoice 0707'), 'Milo 100k EMK-0707', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.D5-d-sep', 'separate', DELEGATE);
      await reply('wamid.D5-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
      /* The first booking leaves the window, so only the "separate" one is left. */
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE expenses SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid
             AND source_id = (SELECT d.id::text FROM command_drafts d
                               JOIN conversation_messages m ON m.id = d.conversation_message_id
                              WHERE m.provider_message_id = 'wamid.D5-o')`),
      );
      /* A purchase whose message reached Rekoda BEFORE the question, but
       * whose draft is recorded only now. */
      await say('wamid.D5-late', REF('invoice 0808'), 'Milo 100k EMK-0808');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command - 'supplierReference'
           WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
      );
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE conversation_messages SET created_at = (
            SELECT created_at - interval '1 second' FROM conversation_messages
             WHERE provider_message_id = 'wamid.D5-d')
           WHERE provider_message_id = 'wamid.D5-late'`),
      );
      await reply('wamid.D5-late-yes', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(2);
    });
  });

  describe('fresh review of #262', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };
    const POS_QUESTION = 'did it come from your bank account or from physical cash?';

    async function backdate(businessId: string, table: string, column: string, interval: string) {
      await withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = clock_timestamp() - ${interval}::interval
               WHERE business_id = ${businessId}::uuid`,
        ),
      );
    }

    it('D3: suppliers that existed long before never prove a purchase separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await deps.gateway.resolveSupplierMention(business.id, 'Emeka');
      await deps.gateway.resolveSupplierMention(business.id, 'Chidi');
      await backdate(business.id, 'suppliers', 'created_at', '30 days');
      await bookMilo(business.id, 'R1');
      await say(
        'wamid.R1-chidi',
        { ...MILO, supplierMention: 'Chidi' },
        'I bought 10 cartons of Milo from Chidi for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('D3: products made from chat long ago never prove it either', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await withBusiness(db, business.id, async (tx) => {
        await stockRepo.findOrCreateProduct(tx, business.id, 'Milo');
        await stockRepo.findOrCreateProduct(tx, business.id, 'Peak milk');
      });
      await backdate(business.id, 'products', 'created_at', '30 days');
      await bookMilo(business.id, 'R2');
      await say(
        'wamid.R2-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });

    it('B1: a question names every match it may be about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'B1');
      await say('wamid.B1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.B1-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      /* The owner sends the same real purchase while the delegate's fresh
       * preview waits: the question must name both. */
      await say('wamid.B1-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).toContain('2 stock purchases of ₦100,000');
    });

    it('I1: one member double-sending before the first is processed still gets ONE preview', async () => {
      const business = await seedMerchant();
      stubTransport.replyWith(MILO);
      await post(messagePayload(OWNER, 'wamid.I1-a', 'I bought 10 cartons of Milo for 100k cash'));
      await post(messagePayload(OWNER, 'wamid.I1-b', 'I bought 10 cartons of Milo for 100k cash'));
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      expect(stubSender.lastText).toContain('Your earlier preview of ₦100,000 was replaced');
    });

    it('I1: two members sending together before either is processed: the second is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      stubTransport.replyWith(MILO);
      await post(messagePayload(OWNER, 'wamid.I1c-o', 'I bought 10 cartons of Milo for 100k cash'));
      await post(
        messagePayload(DELEGATE, 'wamid.I1c-d', 'I bought 10 cartons of Milo for 100k cash'),
      );
      await drain();
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
    });

    it('I4: a yes from a member still being asked never books an older preview, after another message', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I4');
      await say('wamid.I4-rice', RICE, 'bought 5 bags rice 50k cash');
      await say('wamid.I4-o-milo', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.I4-o-stock', 'stock');
      await say('wamid.I4-d-milo', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I4-o-yes', 'yes');
      expect(stubSender.lastText).toContain(REASK);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I5: a refused yes whose question never reached the merchant puts the preview back, and the next yes is asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.I5-o', { ...MILO, supplierReference: 'invoice 0011' }, 'Milo 100k EMK-0011');
      await say(
        'wamid.I5-d',
        { ...MILO, supplierReference: 'invoice 0022' },
        'Milo 100k EMK-0022',
        DELEGATE,
      );
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command - 'supplierReference'
           WHERE business_id = ${business.id}::uuid`),
      );
      await reply('wamid.I5-yes-1', 'yes');
      stubSender.failWith();
      await reply('wamid.I5-yes-2', 'yes');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'confirmed']);
      await reply('wamid.I5-yes-3', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I6: an unrecognised reply keeps the question open, and "seperate" answers it', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I6');
      await say('wamid.I6-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I6-hmm', 'hmm let me check', DELEGATE);
      await reply('wamid.I6-sep', 'seperate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('I6: a bare "same" days after a question is an ordinary message, never "closed"', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'I6b');
      await say('wamid.I6b-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 days'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '3 days'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.I6b-same', 'same', DELEGATE);
      expect(stubSender.lastText).not.toContain(CLOSED);
    });

    it('I7: an own waiting preview is not replaced by a purchase that is held and asked', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.I7-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say('wamid.I7-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.I7-d-sep', 'separate', DELEGATE);
      await reply('wamid.I7-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
      /* The owner's own preview waits; a matching booking exists. */
      await say('wamid.I7-o-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      expect(stubSender.lastText).not.toContain('replaced by this one');
      expect((await purchaseStates(business.id))[0]).toBe('pending');
    });

    it('minor: "same" closes the stale G-61 question the held purchase was blocking', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M1');
      await say('wamid.M1-pos', { ...MILO, paymentMethod: 'pos' }, 'Milo 100k POS');
      expect(stubSender.lastText).toContain(POS_QUESTION);
      await say('wamid.M1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M1-d-same', 'same', DELEGATE);
      expect(await purchaseStates(business.id)).not.toContain('abandoned');
    });

    it('minor: a resend after "separate" replaces the fresh preview without asking again', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'M2');
      await say('wamid.M2-a', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.M2-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await say('wamid.M2-b', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('was replaced');
      await reply('wamid.M2-yes-1', 'yes');
      await reply('wamid.M2-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('minor: a "no" to the question says how to save nothing (same, never cancel: Codex review of 5bfe87e)', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M3');
      await say('wamid.M3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M3-no', 'no', DELEGATE);
      expect(stubSender.lastText).toContain('If you do not want it saved, reply *same*');
      expect(stubSender.lastText).not.toContain('*cancel*');
      /* Following it literally: the question closes and nothing more is saved. */
      await reply('wamid.M3-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('minor: a closed question mentions the fresh preview still waiting', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'M4');
      await say('wamid.M4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await reply('wamid.M4-sep', 'separate', DELEGATE);
      await reply('wamid.M4-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain('still waiting for a yes');
    });
  });

  describe('on a plan without Chat while the question is open (G-65 integration)', () => {
    async function askedWithoutChat(tag: string) {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, tag);
      await say(`wamid.${tag}-d`, MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await billingRepo.setPlan(db, {
        businessId: business.id,
        plan: 'integrate',
        expiresAt: null,
        actor: 'operator:g81',
      });
      return business;
    }

    it('a yes is told nothing was saved, and invites no "separate"', async () => {
      const business = await askedWithoutChat('NC1');
      await reply('wamid.NC1-d-yes', 'yes', DELEGATE);
      expect(stubSender.lastText).toBe(replies.notSavedNotInPlan().text);
      expect(await purchases(business.id)).toBe(1);
    });

    it('a no is told nothing was saved, and invites no "separate"', async () => {
      const business = await askedWithoutChat('NC2');
      await reply('wamid.NC2-no', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.notSavedNotInPlan().text);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"same" still closes it, writing nothing, with copy that invites no refused yes', async () => {
      const business = await askedWithoutChat('NC3');
      await reply('wamid.NC3-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(stubSender.lastText).not.toMatch(/reply \*yes\*|send the purchase again/i);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('"separate" is refused before anything is drafted', async () => {
      const business = await askedWithoutChat('NC4');
      await reply('wamid.NC4-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toBe(replies.chatNotInPlan().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of cfc4720', () => {
    it('P2: a purchase whose job ran late is aged from its webhook arrival, not from when it ran', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C5a');
      /* The owner's purchase reached Rekoda 25 hours ago, but its job (and the
       * booking) ran only 23 hours ago, after a backlog. */
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '25 hours'
           WHERE business_id = ${business.id}::uuid`);
        for (const table of ['conversation_messages', 'expenses']) {
          await tx.execute(sql`
            UPDATE ${sql.raw(table)} SET created_at = clock_timestamp() - interval '23 hours'
             WHERE business_id = ${business.id}::uuid`);
        }
      });
      await say('wamid.C5a-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).not.toContain(QUESTION);
      expect(stubSender.lastText).toContain('Paid in full by cash');
    });

    it('P1: a two-line received order and a chat purchase of its second product are asked about', async () => {
      const business = await seedMerchant();
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      /* A received purchase order of ₦100,000 with two catalogue-linked lines. */
      await withBusiness(db, business.id, async (tx) => {
        const milo = await stockRepo.findOrCreateProduct(tx, business.id, 'Milo');
        const peak = await stockRepo.findOrCreateProduct(tx, business.id, 'Peak milk');
        await spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0001',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0001',
          supplierId: null,
        });
        for (const product of [milo, peak]) {
          await stockRepo.recordDelivery(tx, {
            businessId: business.id,
            product,
            quantity: 5,
            costK: 5_000_000,
            sourceType: 'purchase_order',
            sourceId: 'po-0001',
          });
        }
      });
      await say(
        'wamid.C5b-peak',
        { ...MILO, description: '10 cartons of Peak milk', productMention: 'Peak milk' },
        'I bought 10 cartons of Peak milk for 100k cash',
      );
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });

  describe('Codex review of 3fcc173', () => {
    const RICE = {
      ...MILO,
      description: '5 bags of rice',
      amount: 50_000,
      reportedPayment: 50_000,
      productMention: 'bags of rice',
      quantity: 5,
    };

    it('P1: a yes sent while a preview was waiting never claims an older one once that preview is held', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      /* An older, unrelated preview of the delegate's. */
      await say('wamid.C6-rice', RICE, 'bought 5 bags rice 50k cash', DELEGATE);
      /* The owner's Milo preview, the newest. */
      await say('wamid.C6-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      /* A received order of the same total is booked after it was shown. */
      await withBusiness(db, business.id, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0007',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0007',
          supplierId: null,
        }),
      );
      /* The owner's yes is refused at the work, and the preview is held. */
      await reply('wamid.C6-o-yes', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchaseStates(business.id)).toEqual(['pending', 'held']);
      /* A delegate yes that reached Rekoda BEFORE that preview was held (its
       * job ran late): it was about the Milo preview, never the rice. */
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, 'wamid.C6-d-yes', 'yes'));
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE external_events SET created_at = (
            SELECT created_at + interval '10 milliseconds' FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND state = 'held')
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.C6-d-yes'`),
      );
      await drain();
      expect(await purchases(business.id)).toBe(1);
      expect(stubSender.lastText).toContain('Nothing was saved from your yes.');
    });
  });

  describe('Codex review of 71fad6b', () => {
    it('P2: "separate" still answers a held question after an unrelated question opened since', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C7a');
      await say('wamid.C7a-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* A spending question with no period opens "Which period?". */
      await say(
        'wamid.C7a-q',
        {
          intent: 'Query',
          topic: 'expenses_summary',
          customer: null,
          period: null,
          periodText: null,
          format: 'chat',
        },
        'how much did I spend?',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain('which period');
      await reply('wamid.C7a-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('P2: the supplier reference a merchant confirmed reaches the bill', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.C7b',
        { ...MILO, reportedPayment: 0, paymentMethod: null, supplierReference: 'EMK-0041' },
        'Milo 100k on credit, their invoice EMK-0041',
      );
      expect(stubSender.lastText).toContain('Reference: 0041');
      expect(stubSender.lastText).not.toContain('EMK');
      await reply('wamid.C7b-yes', 'yes');
      const rows = await withBusiness(db, business.id, (tx) =>
        tx.execute<{ ref: string | null }>(sql`
          SELECT supplier_reference AS ref FROM bills WHERE business_id = ${business.id}::uuid`),
      );
      expect([...rows].map((r) => r.ref)).toEqual(['Reference 0041']);
    });
  });

  describe('fresh review of 75fd1c9', () => {
    it('I1: an invoice number and a receipt number for one purchase are asked about, never booked twice', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say(
        'wamid.V1-o',
        { ...MILO, supplierReference: 'invoice 2231' },
        'Milo 100k, invoice 2231',
      );
      await reply('wamid.V1-o-yes', 'yes');
      await say(
        'wamid.V1-d',
        { ...MILO, supplierReference: 'receipt RCPT-0041' },
        'Milo 100k, receipt RCPT-0041',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('I2: a reference that is a name with digits stores no letters, on the draft or the bill', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.V2',
        { ...MILO, reportedPayment: 0, paymentMethod: null, supplierReference: 'TOLU-77' },
        'Milo 100k on credit, TOLU-77',
      );
      await reply('wamid.V2-yes', 'yes');
      const [row] = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ draft: string | null; bill: string | null }>(sql`
            SELECT (SELECT command->>'supplierReference' FROM command_drafts
                     WHERE business_id = ${business.id}::uuid AND intent = 'RecordPurchase') AS draft,
                   (SELECT supplier_reference FROM bills WHERE business_id = ${business.id}::uuid) AS bill`),
        )),
      ];
      expect(row!.draft ?? '').not.toMatch(/TOLU/i);
      expect(row!.bill ?? '').not.toMatch(/TOLU/i);
    });

    it('minor: after the question expired, "no" and "cancel" behave as with nothing waiting', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V3');
      await say('wamid.V3-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await withBusiness(db, business.id, async (tx) => {
        await tx.execute(sql`
          UPDATE command_drafts SET expires_at = clock_timestamp() - interval '3 hours'
           WHERE business_id = ${business.id}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations SET expires_at = clock_timestamp() - interval '3 hours'
           WHERE business_id = ${business.id}::uuid`);
      });
      await reply('wamid.V3-no', 'no', DELEGATE);
      expect(stubSender.lastText).toBe(replies.nothingToDecline().text);
      await reply('wamid.V3-cancel', 'cancel', DELEGATE);
      expect(stubSender.lastText).toBe(replies.nothingToCancel().text);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'held']);
    });

    it('minor: a re-asked question nobody saw keeps a continuation that ends with the restored window', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V4');
      await say('wamid.V4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.V4-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.V4-o-sep', 'separate');
      await reply('wamid.V4-o-yes', 'yes');
      stubSender.failWith();
      await reply('wamid.V4-d-sep-1', 'separate', DELEGATE);
      const rows = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ held: string; open: string }>(sql`
            SELECT h.expires_at::text AS held, c.expires_at::text AS open
              FROM command_drafts h
              JOIN conversation_continuations c
                ON c.business_id = h.business_id AND c.draft_id = h.id AND c.state = 'open'
             WHERE h.business_id = ${business.id}::uuid AND h.state = 'held'`),
        )),
      ];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.open).toBe(rows[0]!.held);
    });

    it('minor: a second "cash" while the rebuilt purchase is held points at the identity question', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'V5');
      await say(
        'wamid.V5-pos',
        { ...MILO, paymentMethod: 'pos' },
        'I bought 10 cartons of Milo for 100k by POS',
        DELEGATE,
      );
      await reply('wamid.V5-cash', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.V5-cash-2', 'cash', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      expect(stubSender.lastText).not.toBe(replies.fundingQuestionClosed().text);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of 7f173b6', () => {
    /** The delegate's question was asked 15 minutes ago and closed 5 minutes
     * ago; their answer reached Rekoda 8 minutes ago, inside the window, and
     * its job runs only now (a backlog or a retry). */
    async function answerSentInsideProcessedAfter(businessId: string, wamid: string, text: string) {
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, wamid, text));
      await withBusiness(db, businessId, async (tx) => {
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '30 minutes'
           WHERE business_id = ${businessId}::uuid AND external_id <> ${wamid}`);
        await tx.execute(sql`
          UPDATE external_events SET created_at = clock_timestamp() - interval '8 minutes'
           WHERE business_id = ${businessId}::uuid AND external_id = ${wamid}`);
        await tx.execute(sql`
          UPDATE command_drafts
             SET created_at = clock_timestamp() - interval '15 minutes',
                 expires_at = clock_timestamp() - interval '5 minutes'
           WHERE business_id = ${businessId}::uuid AND state = 'held'`);
        await tx.execute(sql`
          UPDATE conversation_continuations
             SET created_at = clock_timestamp() - interval '15 minutes',
                 expires_at = clock_timestamp() - interval '5 minutes'
           WHERE business_id = ${businessId}::uuid AND expects = 'purchase_identity'`);
      });
      await drain();
    }

    it('P2: "same" sent inside the window but processed after it is answered, not closed', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'X1');
      await say('wamid.X1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await answerSentInsideProcessedAfter(business.id, 'wamid.X1-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchaseStates(business.id)).toEqual(['confirmed', 'superseded']);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: "separate" sent inside the window but processed after it shows the fresh preview', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'X2');
      await say('wamid.X2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await answerSentInsideProcessedAfter(business.id, 'wamid.X2-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
    });

    it('P2: a known product with no usable quantity proves nothing against a booked one', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await bookMilo(business.id, 'X3');
      await say(
        'wamid.X3-d',
        { ...MILO, productMention: 'Peak milk', quantity: null },
        'I bought Peak milk for 100k cash',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain(QUESTION);
      expect(await purchases(business.id)).toBe(1);
    });

    it('P2: a waiting preview whose product has no quantity proves nothing either', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await knownProduct(business.id, 'Milo');
      await knownProduct(business.id, 'Peak milk');
      await say(
        'wamid.X4-o',
        { ...MILO, productMention: 'Peak milk', quantity: null },
        'I bought Peak milk for 100k cash',
      );
      await say('wamid.X4-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
    });
  });
  describe('Codex review of 30a5c8f', () => {
    it('P1: a "separate" sent before the question was re-asked never excuses what the re-ask named', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Y1');
      await say('wamid.Y1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* The owner books another of the same total, declared separate. */
      await say('wamid.Y1-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await reply('wamid.Y1-o-sep', 'separate');
      await reply('wamid.Y1-o-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
      /* The delegate's later "separate" is processed first and re-asks,
       * naming the new booking. */
      await reply('wamid.Y1-d-sep-late', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      /* An earlier "separate", sent before that re-ask, arrives only now. */
      stubTransport.replyWith(UNCLEAR);
      await post(messagePayload(DELEGATE, 'wamid.Y1-d-sep-early', 'separate'));
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE external_events SET created_at = (
            SELECT created_at - interval '10 milliseconds' FROM external_events
             WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.Y1-d-sep-late')
           WHERE business_id = ${business.id}::uuid AND external_id = 'wamid.Y1-d-sep-early'`),
      );
      await drain();
      expect(stubSender.lastText).not.toContain(SEPARATE_LEAD);
      await reply('wamid.Y1-d-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(2);
    });
  });

  describe('Codex review of 0e9bf52', () => {
    it('P2: a refused fresh preview keeps what its first answer declared separate', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Z1');
      await say('wamid.Z1-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.Z1-d-sep', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      /* A received order of the same total is booked after that preview. */
      await withBusiness(db, business.id, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId: business.id,
          description: 'PO-0009',
          amountK: 10_000_000,
          paidK: 0,
          method: null,
          sourceType: 'purchase_order',
          sourceId: 'po-0009',
          supplierId: null,
        }),
      );
      await reply('wamid.Z1-d-yes-1', 'yes', DELEGATE);
      expect(stubSender.lastText).toContain(RACE);
      /* "separate" to THAT is about the order only: the owner's booking was
       * already declared separate, so it is not asked about again. */
      await reply('wamid.Z1-d-sep-2', 'separate', DELEGATE);
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      await reply('wamid.Z1-d-yes-2', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(3);
    });

    it('P2: a yes re-ask nobody saw gives back the newer question it retired', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'Z2');
      await say('wamid.Z2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await say(
        'wamid.Z2-q',
        {
          intent: 'Query',
          topic: 'expenses_summary',
          customer: null,
          period: null,
          periodText: null,
          format: 'chat',
        },
        'how much did I spend?',
        DELEGATE,
      );
      expect(stubSender.lastText).toContain('which period');
      stubSender.failWith();
      await reply('wamid.Z2-d-yes', 'yes', DELEGATE);
      const open = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ expects: string | null }>(sql`
            SELECT expects FROM conversation_continuations
             WHERE business_id = ${business.id}::uuid AND state = 'open'`),
        )),
      ].map((r) => r.expects);
      expect(open).toEqual(['period']);
      expect(await purchases(business.id)).toBe(1);
    });
  });

  describe('Codex review of 5bfe87e', () => {
    const POS_MILO = { ...MILO, paymentMethod: 'pos' };

    it("the sender's own undelivered preview is replaced by their resend, silently (was G-91)", async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U1-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The preview never reached them: still pending, never described. */
      expect(await purchaseStates(business.id)).toEqual(['pending']);
      await say('wamid.U1-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      expect(stubSender.lastText).not.toContain(QUESTION);
      /* One confirmable draft, so two yeses book it once. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await reply('wamid.U1-yes-1', 'yes');
      await reply('wamid.U1-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a replacing preview whose own send fails gives back the undelivered draft (final-head review of eb0ad6d)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U6-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      stubSender.failWith();
      await say('wamid.U6-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The resend reached nobody, so what it replaced comes back and the
       * resend is withdrawn: still one confirmable draft. */
      expect(await purchaseStates(business.id)).toEqual(['pending', 'superseded']);
      await reply('wamid.U6-yes-1', 'yes');
      await reply('wamid.U6-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a purchase held back for an arithmetic question is no undelivered copy (final-head review of 77e9da8)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U5-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* Paid more than the total: CG1 asks, and its draft is unpreviewed. */
      await say(
        'wamid.U5-cg1',
        { ...MILO, reportedPayment: 150_000 },
        'I bought 10 cartons of Milo for 100k, paid 150k',
      );
      await say('wamid.U5-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The question is not counted, so the one undelivered preview is the
       * single match and is replaced. */
      expect((await purchaseStates(business.id))[0]).toBe('superseded');
      expect((await purchaseStates(business.id)).at(-1)).toBe('pending');
    });

    it('an undelivered draft proven separate by its reference is never replaced (final-head review of ffb5404)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say(
        'wamid.U3-milo',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      await say(
        'wamid.U3-rice',
        {
          ...MILO,
          description: '4 bags of rice',
          productMention: 'rice',
          quantity: 4,
          supplierReference: 'invoice 5590',
        },
        'I bought 4 bags of rice for 100k cash, invoice 5590',
      );
      expect(await purchaseStates(business.id)).toEqual(['pending', 'pending']);
    });

    it('a resend replaces only the one undelivered draft it may be, never another proven separate', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say(
        'wamid.U4-a',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      stubSender.failWith();
      await say(
        'wamid.U4-b',
        { ...MILO, supplierReference: 'invoice 5590' },
        'I bought 10 cartons of Milo for 100k cash, invoice 5590',
      );
      await say(
        'wamid.U4-again',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      /* The invoice 2231 draft is replaced; invoice 5590 is another purchase. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending', 'pending']);
    });

    it("another member's undelivered preview is never replaced by it", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      stubSender.failWith();
      await say('wamid.U2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.U2-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'pending']);
    });

    it('a rebuild the member declared "separate" is never replaced by the fresh preview', async () => {
      const business = await seedMerchant();
      /* A funding-answer rebuild with invoice 2231. */
      await say(
        'wamid.L1-pos',
        { ...POS_MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k, paid by POS, invoice 2231',
      );
      await reply('wamid.L1-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      /* A typed purchase with invoice 2281: proven separate, both wait. */
      await say(
        'wamid.L1-typed',
        { ...MILO, supplierReference: 'invoice 2281' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2281',
      );
      expect(stubSender.lastText).toContain('is still waiting');
      /* The same total with no reference matches both: asked about both. */
      await say('wamid.L1-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.L1-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      expect(stubSender.lastText).not.toContain('was replaced by this one');
      /* The rebuild, the typed preview and the fresh one all still wait. */
      expect((await purchaseStates(business.id)).filter((s) => s === 'pending')).toHaveLength(3);
      await reply('wamid.L1-yes-1', 'yes');
      await reply('wamid.L1-yes-2', 'yes');
      await reply('wamid.L1-yes-3', 'yes');
      expect(await purchases(business.id)).toBe(3);
    });

    it('a funding-answer rebuild that replaced an own preview, then failed to send, leaves the question answerable (fan-out review of 8dfce8f)', async () => {
      const business = await seedMerchant();
      await say('wamid.R7-cash', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await say('wamid.R7-pos', POS_MILO, 'I bought 10 cartons of Milo for 100k, paid by POS');
      /* The rebuild replaces the member's own waiting preview, and its send
       * fails: everything goes back as the member last saw it. */
      stubSender.failWith();
      await reply('wamid.R7-bank-1', 'bank');
      await reply('wamid.R7-bank-2', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(stubSender.lastText).not.toContain(CLOSED);
      await reply('wamid.R7-yes-1', 'yes');
      await reply('wamid.R7-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a reference equal to the reported part payment is not stored', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.R1-buy',
        { ...MILO, reportedPayment: 35_000, supplierReference: 'invoice 35000' },
        'I bought 10 cartons of Milo for 100k, paid 35k, invoice 35000',
      );
      const [row] = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ ref: string | null }>(sql`
            SELECT command->>'supplierReference' AS ref FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordPurchase'`),
        )),
      ];
      expect(row!.ref).toBeNull();
    });

    it('the re-ask after a no never offers cancel', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C9');
      await say('wamid.C9-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.C9-no', 'no', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      expect(stubSender.lastText).not.toMatch(/cancel/i);
    });
  });
});

/**
 * Build 9, OD-4 (approved 8 Oct 2026): the command bus is the default door.
 *
 * The rest of this file now runs every write through the bus by default;
 * these prove it at the ingress, side by side with the rollback. Two
 * merchants, one on the default configuration and one with that command's
 * flag at `0`, book the same thing: the business truth (documents, money,
 * stock and every ledger account's net movement) must be identical, and
 * the only difference is the bus's own idempotency claim.
 */
describe('the command bus is the default door, and 0 rolls back to the same truth (Build 9)', () => {
  const BUS = '2348039991011';
  const DIRECT = '2348039991012';
  const SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 100_000,
    paymentMethod: 'cash',
    productMention: 'cartons',
    quantity: 10,
  };

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, `+${phone}`);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function say(phone: string, wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload(phone, wamid, text));
    await drain();
  }

  async function plain(phone: string, wamid: string, text: string) {
    await post(messagePayload(phone, wamid, text));
    await drain();
  }

  /** Run `fn` with one command flag set as an operator's `0` would set it. */
  async function rolledBack<T>(flag: keyof ApiConfig, fn: () => Promise<T>): Promise<T> {
    const config = deps.config as unknown as Record<string, boolean>;
    const was = config[flag as string]!;
    config[flag as string] = false;
    try {
      return await fn();
    } finally {
      config[flag as string] = was;
    }
  }

  async function claims(businessId: string, command: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ key: string; completed: boolean }>(sql`
        SELECT key, completed_at IS NOT NULL AS completed FROM idempotency_records
         WHERE business_id = ${businessId}::uuid AND command_name = ${command}
         ORDER BY created_at`),
    );
    return [...rows];
  }

  /** The business truth: documents, money, stock, and every account's net. */
  async function truth(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS movements,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM outbox_events WHERE business_id = ${businessId}::uuid) AS announcements,
            (SELECT count(*)::int FROM jobs WHERE business_id = ${businessId}::uuid AND kind = 'document.render') AS documents
        `),
      )),
    ];
    const nets: Record<string, number> = {};
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    for (const e of entries) nets[e.account] = (nets[e.account] ?? 0) + e.debitK - e.creditK;
    return { counts: row!, nets };
  }

  it('a Chat sale takes the bus by default; 0 books the same sale, payment, receipt and ledger directly', async () => {
    const bus = await seedMerchant(BUS);
    const direct = await seedMerchant(DIRECT);

    await say(BUS, 'wamid.B9-s-bus', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
    await plain(BUS, 'wamid.B9-s-bus-yes', 'yes');
    await rolledBack('commandRecordSale', async () => {
      await say(DIRECT, 'wamid.B9-s-dir', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
      await plain(DIRECT, 'wamid.B9-s-dir-yes', 'yes');
    });

    const onBus = await truth(bus.id);
    expect(onBus.counts).toMatchObject({ invoices: 1, payments: 1, receipts: 1 });
    expect(await truth(direct.id)).toEqual(onBus);
    /* The only difference is the bus's claim, keyed on the confirmed draft. */
    const busClaims = await claims(bus.id, 'RecordSale');
    expect(busClaims).toHaveLength(1);
    expect(busClaims[0]!.key).toMatch(/^draft:/);
    expect(busClaims[0]!.completed).toBe(true);
    expect(await claims(direct.id, 'RecordSale')).toHaveLength(0);
  });

  it('a redelivered yes, and a second yes, on the bus book nothing twice', async () => {
    const bus = await seedMerchant(BUS);
    await say(BUS, 'wamid.B9-r', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
    await plain(BUS, 'wamid.B9-r-yes', 'yes');
    const once = await truth(bus.id);
    /* Meta redelivers the same webhook (dropped by the message's own
     * dedupe), and the merchant says yes again (a new message: the draft is
     * already claimed, so nothing reaches the bus a second time). */
    await plain(BUS, 'wamid.B9-r-yes', 'yes');
    await plain(BUS, 'wamid.B9-r-yes-2', 'yes');
    expect(await truth(bus.id)).toEqual(once);
    expect(await claims(bus.id, 'RecordSale')).toHaveLength(1);
  });

  it('a Chat purchase takes the bus by default; 0 books the same purchase, stock, bill and accounts', async () => {
    const bus = await seedMerchant(BUS);
    const direct = await seedMerchant(DIRECT);

    await say(BUS, 'wamid.B9-p-bus', PURCHASE, 'bought 10 cartons from Emeka 180k, paid 100k cash');
    await plain(BUS, 'wamid.B9-p-bus-yes', 'yes');
    await rolledBack('commandRecordPurchase', async () => {
      await say(
        DIRECT,
        'wamid.B9-p-dir',
        PURCHASE,
        'bought 10 cartons from Emeka 180k, paid 100k cash',
      );
      await plain(DIRECT, 'wamid.B9-p-dir-yes', 'yes');
    });

    const onBus = await truth(bus.id);
    /* G-61 unchanged: the paid part leaves Cash, the rest is owed. */
    expect(onBus.counts).toMatchObject({ purchases: 1, bills: 1, movements: 1 });
    expect(onBus.nets).toMatchObject({
      INVENTORY: 18_000_000,
      CASH: -10_000_000,
      ACCOUNTS_PAYABLE: -8_000_000,
    });
    expect(await truth(direct.id)).toEqual(onBus);
    expect(await claims(bus.id, 'RecordPurchase')).toHaveLength(1);
    expect(await claims(direct.id, 'RecordPurchase')).toHaveLength(0);
  });

  it('one command rolled back leaves every other command on the bus', async () => {
    const bus = await seedMerchant(BUS);
    await rolledBack('commandRecordSale', async () => {
      await say(BUS, 'wamid.B9-o-p', PURCHASE, 'bought 10 cartons from Emeka 180k, paid 100k cash');
      await plain(BUS, 'wamid.B9-o-p-yes', 'yes');
      await say(BUS, 'wamid.B9-o-s', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
      await plain(BUS, 'wamid.B9-o-s-yes', 'yes');
    });
    expect(await claims(bus.id, 'RecordPurchase')).toHaveLength(1);
    expect(await claims(bus.id, 'RecordSale')).toHaveLength(0);
  });
});
