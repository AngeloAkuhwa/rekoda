/**
 * A top-up pack is paid for once and credited once (backlog row 10).
 *
 * The matrix a pack must satisfy, read off the METER (`usage_counters.bonus`)
 * rather than the charge row, because the existing pack tests only look at the
 * charge and the plan and so cannot tell a grant from no grant:
 *
 *   payment pending / underpaid / failed / still processing -> no units
 *   payment confirmed                                        -> units, once
 *   duplicate or replayed webhook, redelivered event         -> no second grant
 *   two settlements racing                                   -> one grant
 *
 * Money never enters the merchant's books here either (billing-charge covers
 * that for plans; the pack path is asserted again below).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscriptionReference, usagePeriod } from '@rekoda/core';
import {
  billingRepo,
  createDb,
  events,
  identity,
  issueRepo,
  settleRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { applySettledCharge } from './billing.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-bill-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let deps: RunnerDeps;

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = loadConfig();

  provider = new StubPaymentProvider();
  const stubSender = new StubSender();
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
    replySender: new ReplySender(config, stubSender),
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: provider,
    paymentIntents: new PaymentIntentsService(config, appDb, provider),
    stt: new StubSpeechToText(),
    ocr: new StubTextExtraction(),
    audioProbe: new ContainerAudioProbe(),
    commandBus: new CommandBus(new RiskPolicyService()),
  };
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
});

let phoneSeq = 0;

async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481900000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const CHAT_K = 990_000;

/** A pending first-purchase charge, as the billing endpoint would open one. */
async function openSubscriptionCharge(
  businessId: string,
  opts: { amountK?: number; kind?: 'first_purchase' | 'add_on'; packId?: string } = {},
): Promise<string> {
  const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
  const now = new Date();
  await withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: opts.kind ?? 'first_purchase',
      plan: opts.kind === 'add_on' ? null : 'chat',
      packId: opts.packId ?? null,
      amountK: opts.amountK ?? CHAT_K,
      reference,
      periodStart: opts.kind === 'add_on' ? null : now,
      periodEnd: opts.kind === 'add_on' ? null : new Date(now.getTime() + 30 * 86_400_000),
    }),
  );
  return reference;
}

let nextTransactionId = 7_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
async function storeChargeSuccess(reference: string, amountK = CHAT_K): Promise<string> {
  const transactionId = ++nextTransactionId;
  const body = {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      amount: amountK,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'owner@example.com' },
    },
  };
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId: `${transactionId}:${body.event}`,
    payload: sealPayload(body, config.vaultKey, 'paystack', `${transactionId}:${body.event}`),
    businessId: null,
  });
  return storedEventId(recorded);
}

const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });

async function drainJobs(): Promise<number> {
  const runner = buildRunner(workerDb, appDb, deps);
  let ran = 0;
  while (await runner.runOnce()) ran += 1;
  return ran;
}

const chargeOf = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.chargeByReference(tx, businessId, reference),
  );

const subscriptionOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.subscriptionFor(tx, businessId));

const PACK_K = 250_000;
const PACK_UNITS = 100; // messages_100 -> AI_ACTIONS

const bonusOf = async (businessId: string): Promise<number> => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'AI_ACTIONS')?.bonus ?? 0;
};

async function openPack(businessId: string): Promise<string> {
  return openSubscriptionCharge(businessId, {
    kind: 'add_on',
    packId: 'messages_100',
    amountK: PACK_K,
  });
}

async function payPack(businessId: string, reference: string, amountK = PACK_K): Promise<string> {
  provider.willVerify(reference, { amountK });
  const eventId = await storeChargeSuccess(reference, amountK);
  // The event must reach the billing handler, or a refusal below proves nothing.
  expect(await pump()).toBe(1);
  await drainJobs();
  return eventId;
}

describe('a top-up pack payment', () => {
  it('grants no units while the charge is pending', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('grants no units for a payment a kobo short', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    const eventId = await payPack(businessId, reference, PACK_K - 1);

    /* The handler ran and refused: a job that threw would leave the same pending
     * charge and zero bonus, so the event's own outcome is what proves it. */
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('underpaid');

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('grants no units when the provider says the attempt failed', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { succeeded: false, providerStatus: 'failed', amountK: PACK_K });
    const eventId = await storeChargeSuccess(reference);
    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('provider_failed');
    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('grants no units while the provider still reports the payment as processing', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'ongoing',
      amountK: PACK_K,
    });
    await storeChargeSuccess(reference);
    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('believes the verify call, not a webhook that lied about the amount', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K / 10 });
    const eventId = await storeChargeSuccess(reference, PACK_K);
    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('underpaid');
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');

    expect(await bonusOf(businessId)).toBe(0);
  });

  it('grants exactly the pack when the payment is confirmed, and leaves the plan alone', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await payPack(businessId, reference);

    const charge = await chargeOf(businessId, reference);
    expect(charge?.status).toBe('paid');
    expect(charge?.packId).toBe('messages_100');
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
    const rows = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    // Bought capacity is not consumption.
    expect(rows.find((row) => row.unit === 'AI_ACTIONS')?.used).toBe(0);
  });

  it('grants once for an overpayment and leaves the excess to a human', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await payPack(businessId, reference, PACK_K + 50_000);

    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('does not grant a second time for a redelivered webhook (new transaction id)', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await payPack(businessId, reference);
    await payPack(businessId, reference);

    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('does not grant a second time when the pump and queue run again over the same stored event', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K });
    await storeChargeSuccess(reference);
    expect(await pump()).toBe(1);
    await drainJobs();
    /* Nothing new is stored. This is queue deduplication; the handler itself
     * being replayed is the redelivered-webhook case above. */
    await pump();
    await drainJobs();

    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('grants once when two settlements of the same charge race', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const settle = (providerReference: string) =>
      withBusiness(appDb, businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference,
          providerReference,
          paidAmountK: PACK_K,
          when: new Date(),
          config,
        }),
      );

    const answers = await Promise.all([settle('ps_race_1'), settle('ps_race_2')]);

    expect(answers.filter((answer) => answer === 'applied')).toHaveLength(1);
    expect(answers.filter((answer) => answer === 'already_settled')).toHaveLength(1);
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('never writes the pack payment into the merchant books', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await payPack(businessId, reference);

    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.paymentCount(tx))).toBe(0);
    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.receiptCount(tx))).toBe(0);
    const entries = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toHaveLength(0);
  });
});
