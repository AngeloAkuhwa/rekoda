/**
 * A merchant paying REKODA, end to end (ADR 0024): stored event → pump →
 * billing job → the plan actually moves.
 *
 * This path did not exist. `applySettledCharge` and `businessForCharge` both
 * shipped with no caller, and the pump discarded a subscription reference as
 * `foreign_reference` — somebody else's traffic — so a merchant could pay for
 * a plan and nothing would happen at all.
 *
 * Two claims underneath every scenario. The webhook body is a HINT: the
 * authoritative amount comes from the scripted verify call, and one test
 * makes the webhook lie to prove which one is believed. And OUR revenue never
 * enters THEIR books: a paid subscription writes no payment, no receipt and
 * no ledger line.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscriptionReference } from '@rekoda/core';
import {
  createDb,
  events,
  identity,
  issueRepo,
  settleRepo,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
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
  return recorded.id;
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

describe('a subscription payment', () => {
  it('reaches the plan, through the pump and the job', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, { amountK: CHAT_K });
    await storeChargeSuccess(reference);

    expect(await pump()).toBe(1);
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    const sub = await subscriptionOf(businessId);
    expect(sub?.plan).toBe('chat');
    expect(sub?.planExpiresAt).not.toBeNull();
  });

  it('never touches the merchant BOOKS: our revenue is not theirs', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, { amountK: CHAT_K });
    await storeChargeSuccess(reference);
    await pump();
    await drainJobs();

    /* A subscription is an expense of their business in real life, but
     * recording it would be Rekoda deciding what appears in a merchant's
     * profit and loss without being asked. */
    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.paymentCount(tx))).toBe(0);
    expect(await withBusiness(appDb, businessId, (tx) => settleRepo.receiptCount(tx))).toBe(0);
    const entries = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toHaveLength(0);
  });

  it('believes the VERIFY call, not the webhook that lied about the amount', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    // The body claims the full price; the provider says a tenth of it.
    provider.willVerify(reference, { amountK: 99_000 });
    await storeChargeSuccess(reference, CHAT_K);

    await pump();
    await drainJobs();

    // Underpaid, so nothing settles and no plan is unlocked.
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('does not unlock a plan for part of its price', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, { amountK: CHAT_K - 1 });
    await storeChargeSuccess(reference, CHAT_K - 1);

    await pump();
    await drainJobs();

    /* There is no balance on a plan to reduce: either the month is paid for
     * or it is not, and a kobo short is not. */
    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('accepts an overpayment and leaves the excess to a human', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, { amountK: CHAT_K + 100_000 });
    await storeChargeSuccess(reference, CHAT_K + 100_000);

    await pump();
    await drainJobs();

    // The month IS paid for. Refunding the excess is a decision, not a rule.
    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect((await subscriptionOf(businessId))?.plan).toBe('chat');
  });

  it('closes the charge when the provider says the attempt failed', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'failed',
      amountK: CHAT_K,
    });
    await storeChargeSuccess(reference);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    // The attempt is over; the obligation is not. A retry is a NEW charge.
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('leaves a pending provider status alone rather than calling it a failure', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'ongoing',
      amountK: CHAT_K,
    });
    await storeChargeSuccess(reference);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
  });

  it('applies an add-on pack to the meter rather than to the plan', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId, {
      kind: 'add_on',
      packId: 'messages_100',
      amountK: 250_000,
    });
    provider.willVerify(reference, { amountK: 250_000 });
    await storeChargeSuccess(reference, 250_000);

    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    // A pack buys capacity, not a plan.
    expect((await subscriptionOf(businessId))?.plan).toBe('trial');
  });

  it('does not apply the same payment twice when the webhook is redelivered', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    provider.willVerify(reference, { amountK: CHAT_K });

    await storeChargeSuccess(reference);
    await pump();
    await drainJobs();
    const first = await subscriptionOf(businessId);

    // A second delivery, a different transaction id, the same reference.
    await storeChargeSuccess(reference);
    await pump();
    await drainJobs();

    const second = await subscriptionOf(businessId);
    expect(second?.planExpiresAt?.toISOString()).toBe(first?.planExpiresAt?.toISOString());
  });

  it('flags a subscription reference resolving to nothing, rather than filing it as somebody else', async () => {
    await seedBusiness();
    const orphan = subscriptionReference(new Date(), (n) => randomBytes(n));
    const eventId = await storeChargeSuccess(orphan);

    expect(await pump()).toBe(0);

    /* Shaped like ours and naming no charge is the case that most deserves a
     * human's eyes. Before the routing existed it was filed as
     * `foreign_reference` -- somebody else's traffic -- which is how a
     * merchant's own payment disappears without anybody noticing. */
    const status = await events.eventStatus(workerDb, eventId);
    expect(status?.error).toBe('unknown_reference');
    expect(status?.businessId).toBeNull();
  });

  it('keeps a merchant INVOICE payment on its own path, not this one', async () => {
    const businessId = await seedBusiness();
    // An RKD-PAY reference belongs to the payments pipeline and must not be
    // mistaken for our revenue, however similar the two references look.
    const invoiceRef = 'RKD-PAY-20260821-A83F92';
    const eventId = await storeChargeSuccess(invoiceRef);

    await pump();

    const status = await events.eventStatus(workerDb, eventId);
    // No intent for it in this suite, so it stops at the payments pipeline's
    // own diagnosis rather than being routed into billing.
    expect(status?.error).toBe('unknown_reference');
    const charges = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargesFor(tx, businessId),
    );
    expect(charges).toEqual({ rows: [], count: 0 });
  });
});
