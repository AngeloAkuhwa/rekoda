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
import { applySettledCharge } from './billing.service.js';
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
  opts: {
    amountK?: number;
    kind?: 'first_purchase' | 'add_on';
    packId?: string;
    quantity?: number;
  } = {},
): Promise<string> {
  const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
  const now = new Date();
  await withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: opts.kind ?? 'first_purchase',
      plan: opts.kind === 'add_on' ? null : 'chat',
      packId: opts.packId ?? null,
      ...(opts.quantity !== undefined ? { quantity: opts.quantity } : {}),
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
    const eventId = await storeChargeSuccess(reference, CHAT_K + 100_000);

    await pump();
    await drainJobs();

    // The month IS paid for. Refunding the excess is a decision, not a rule.
    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect((await subscriptionOf(businessId))?.plan).toBe('chat');
    /* G-107: the excess is neither lost nor silent. What the provider took is
     * stored on the charge, and the event is flagged so a human decides. */
    expect((await chargeOf(businessId, reference))?.paidAmountK).toBe(CHAT_K + 100_000);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('overpaid');
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

  it('queues a superseded payment ONCE: on the charge queue, not also as a flagged event (G-104)', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    await billingRepo.setPlan(appDb, {
      businessId,
      plan: 'integrate',
      expiresAt: new Date(Date.now() + 20 * 86_400_000),
      actor: 'operator:test-g104',
    }); // a newer decision than the charge
    provider.willVerify(reference, { amountK: CHAT_K });
    await storeChargeSuccess(reference);
    await pump();
    await drainJobs();

    const unapplied = await subscriptionsRepo.unappliedCharges(workerDb, 50);
    expect(unapplied.map((c) => c.reference)).toEqual([reference]);
    const queue = await events.exceptionQueue(workerDb, 50);
    expect(queue.flagged).toEqual([]);
    expect((await subscriptionOf(businessId))?.plan).toBe('integrate');
  });

  it('a REDELIVERED success for an already-unapplied payment is not queued a second time (G-104)', async () => {
    const businessId = await seedBusiness();
    const reference = await openSubscriptionCharge(businessId);
    await billingRepo.setPlan(appDb, {
      businessId,
      plan: 'integrate',
      expiresAt: new Date(Date.now() + 20 * 86_400_000),
      actor: 'operator:test-g104',
    });
    provider.willVerify(reference, { amountK: CHAT_K });
    await storeChargeSuccess(reference);
    await pump();
    await drainJobs();
    expect((await subscriptionsRepo.unappliedCharges(workerDb, 50)).length).toBe(1);

    await storeChargeSuccess(reference); // the provider delivers it again
    await pump();
    await drainJobs();

    expect((await events.exceptionQueue(workerDb, 50)).flagged).toEqual([]);
    expect((await subscriptionsRepo.unappliedCharges(workerDb, 50)).length).toBe(1);
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

/**
 * A top-up pack is granted exactly once.
 *
 * The pack test above proves a settled pack leaves the plan alone; it never
 * looked at the meter. This is the matrix for the thing the merchant paid
 * for: the bought units land on this month's counter once, however the
 * payment arrives, and not at all unless the provider verified the full price.
 */
describe('a top-up pack', () => {
  const PACK_K = 250_000;
  const PACK_UNITS = 100; // messages_100

  /**
   * The bonus on the meter, summed over the Lagos months around now. A payment
   * is credited to the month it is processed in, so a run that straddles a
   * month boundary must not read the other month's empty counter. Each test
   * starts from an empty estate, so the sum is this test's grants only.
   */
  const bonusOf = async (businessId: string, unit = 'AI_ACTIONS'): Promise<number> => {
    const day = 86_400_000;
    const periods = new Set(
      [-day, 0, day].map((offset) => usagePeriod(new Date(Date.now() + offset))),
    );
    let total = 0;
    for (const period of periods) {
      const rows = await withBusiness(appDb, businessId, (tx) =>
        usageRepo.usageFor(tx, businessId, period),
      );
      total += rows.find((row) => row.unit === unit)?.bonus ?? 0;
    }
    return total;
  };

  const openPack = (businessId: string, opts: { quantity?: number; amountK?: number } = {}) =>
    openSubscriptionCharge(businessId, {
      kind: 'add_on',
      packId: 'messages_100',
      amountK: opts.amountK ?? PACK_K,
      ...(opts.quantity !== undefined ? { quantity: opts.quantity } : {}),
    });

  /** Deliver one success for `reference` and run it all the way through. */
  const deliver = async (reference: string, amountK: number): Promise<void> => {
    provider.willVerify(reference, { amountK });
    await storeChargeSuccess(reference, amountK);
    await pump();
    await drainJobs();
  };

  it('credits the units it sells to this month, through the webhook and the job', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await deliver(reference, PACK_K);

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('credits nothing more when the same payment is delivered again', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await deliver(reference, PACK_K);
    await deliver(reference, PACK_K); // a second delivery, a different transaction id
    await deliver(reference, PACK_K);

    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('credits once when two settlements of one reference race', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const settle = () =>
      withBusiness(appDb, businessId, (tx) =>
        applySettledCharge(tx, {
          businessId,
          reference,
          providerReference: 'ps_race',
          paidAmountK: PACK_K,
          when: new Date(),
          config,
        }),
      );

    const answers = await Promise.all([settle(), settle()]);

    expect([...answers].sort()).toEqual(['already_settled', 'applied']);
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('credits nothing for part of its price, and leaves the charge payable', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await deliver(reference, PACK_K / 2);

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('believes the verify call, not a webhook that claims the full price', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    provider.willVerify(reference, { amountK: 100 }); // what the provider really took
    await storeChargeSuccess(reference, PACK_K); // what the webhook body says
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('pending');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('credits once for an overpayment and leaves the excess to a human', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    await deliver(reference, PACK_K * 2);

    expect((await chargeOf(businessId, reference))?.status).toBe('paid');
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('credits nothing when the provider says the attempt failed', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);

    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'failed',
      amountK: PACK_K,
    });
    await storeChargeSuccess(reference, PACK_K);
    await pump();
    await drainJobs();

    expect((await chargeOf(businessId, reference))?.status).toBe('failed');
    expect(await bonusOf(businessId)).toBe(0);
  });

  it('credits quantity times the pack when several are bought in one charge', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId, { quantity: 3, amountK: PACK_K * 3 });

    await deliver(reference, PACK_K * 3);

    expect(await bonusOf(businessId)).toBe(PACK_UNITS * 3);
  });

  it('credits each separate purchase once, so two charges are two grants', async () => {
    const businessId = await seedBusiness();
    const first = await openPack(businessId);
    await deliver(first, PACK_K);
    const second = await openPack(businessId);
    await deliver(second, PACK_K);

    expect(await bonusOf(businessId)).toBe(PACK_UNITS * 2);
  });

  it('credits the business that paid, never another', async () => {
    const payer = await seedBusiness();
    const bystander = await seedBusiness();
    const reference = await openPack(payer);

    await deliver(reference, PACK_K);

    expect(await bonusOf(payer)).toBe(PACK_UNITS);
    expect(await bonusOf(bystander)).toBe(0);
  });
});
