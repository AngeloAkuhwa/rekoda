/**
 * OD-40 (PR B item 1): a Rekoda charge carries three separate times.
 *
 *   provider_paid_at     when Paystack says the payment happened (its verified `paid_at`)
 *   provider_settled_at  when Paystack confirmed settlement (nullable; no feed writes it yet)
 *   units_credited_at    when Rekoda committed the units a pack bought (Rekoda's own clock)
 *
 * None of them is the webhook's receipt time, and none replaces `paid_at`, which stays
 * the time Rekoda recorded the payment. Each is written once, from verified evidence or
 * from the committing transaction, and a replay, a redelivery or a later event never
 * overwrites it. Unit crediting and its month are unchanged (OD-40 records times only).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addOnReference, subscriptionReference, usagePeriod } from '@rekoda/core';
import {
  createDb,
  events,
  identity,
  sql,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  migrate,
  requireUrls,
  setPlanAsOwner,
  truncateAll,
  type Urls,
  settlementDb,
} from '@rekoda/db/testing';
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
import { BillingService } from './billing.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-od40-'));
const HOUR = 3_600_000;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let deps: RunnerDeps;

const testKey = (label: string) =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

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
    settlementDb: settlementDb(),
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
    `+23481910000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const PACK_K = 250_000;
const PACK_UNITS = 100; // messages_100 -> AI_ACTIONS
const CHAT_K = 990_000;

async function openPack(businessId: string): Promise<string> {
  const reference = addOnReference(new Date(), (n) => randomBytes(n));
  await withBusiness(settlementDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: 'add_on',
      packId: 'messages_100',
      amountK: PACK_K,
      reference,
    }),
  );
  return reference;
}

async function openFirstPurchase(businessId: string): Promise<string> {
  const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
  const now = new Date();
  await withBusiness(settlementDb(), businessId, (tx) =>
    subscriptionsRepo.openCharge(tx, {
      businessId,
      kind: 'first_purchase',
      plan: 'chat',
      amountK: CHAT_K,
      reference,
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * 86_400_000),
    }),
  );
  return reference;
}

let nextTransactionId = 8_100_000;
/** Store a signed event the way the ingress controller does; its body's own `paid_at` is a HINT. */
async function storeEvent(
  reference: string,
  amountK: number,
  event = 'charge.success',
  bodyPaidAt: string | null = null,
): Promise<void> {
  const transactionId = ++nextTransactionId;
  const body = {
    event,
    data: {
      id: transactionId,
      reference,
      amount: amountK,
      currency: 'NGN',
      status: 'success',
      ...(bodyPaidAt ? { paid_at: bodyPaidAt } : {}),
      customer: { email: 'owner@example.com' },
    },
  };
  await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId: `${transactionId}:${body.event}`,
    payload: sealPayload(body, config.vaultKey, 'paystack', `${transactionId}:${body.event}`),
    businessId: null,
  });
}

const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });
async function drainJobs(): Promise<void> {
  const runner = buildRunner(workerDb, appDb, deps);
  while (await runner.runOnce()) {
    /* drain */
  }
}

async function deliver(reference: string, amountK: number, bodyPaidAt: string | null = null) {
  await storeEvent(reference, amountK, 'charge.success', bodyPaidAt);
  expect(await pump()).toBe(1);
  await drainJobs();
}

interface Times {
  status: string;
  paid_at: Date | null;
  provider_paid_at: Date | null;
  provider_settled_at: Date | null;
  units_credited_at: Date | null;
}
async function timesOf(businessId: string, reference: string): Promise<Times> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<Record<string, string | null>>(sql`
      SELECT status, paid_at, provider_paid_at, provider_settled_at, units_credited_at
      FROM subscription_charges
      WHERE business_id = ${businessId}::uuid AND reference = ${reference}`),
  );
  const row = [...rows][0]!;
  const at = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    status: String(row['status']),
    paid_at: at(row['paid_at']),
    provider_paid_at: at(row['provider_paid_at']),
    provider_settled_at: at(row['provider_settled_at']),
    units_credited_at: at(row['units_credited_at']),
  };
}

const bonusOf = async (businessId: string, period = usagePeriod(new Date())) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, period),
  );
  return rows.find((row) => row.unit === 'AI_ACTIONS')?.bonus ?? 0;
};

const dbNow = async (): Promise<Date> => {
  const rows = await appDb.execute<{ now: string }>(sql`SELECT now() AS now`);
  return new Date([...rows][0]!.now);
};

describe('OD-40: the provider payment time', () => {
  it('is the time Paystack verified, not the time the webhook arrived or was processed', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const paystackPaidAt = new Date(Date.now() - 2 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: paystackPaidAt.toISOString() });

    const before = await dbNow();
    await deliver(reference, PACK_K);

    const t = await timesOf(businessId, reference);
    expect(t.status).toBe('paid');
    expect(t.provider_paid_at?.toISOString()).toBe(paystackPaidAt.toISOString());
    // paid_at keeps its meaning: when Rekoda recorded the payment.
    expect(t.paid_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(t.paid_at!.getTime()).not.toBe(paystackPaidAt.getTime());
  });

  it('believes the verify call, never a paid_at the webhook body claimed', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const verified = new Date(Date.now() - 3 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: verified.toISOString() });

    await deliver(reference, PACK_K, '2020-01-01T00:00:00.000Z');

    expect((await timesOf(businessId, reference)).provider_paid_at?.toISOString()).toBe(
      verified.toISOString(),
    );
  });

  it('stays null when Paystack verified the payment without a paid_at, rather than borrowing a receipt time', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: null });

    await deliver(reference, PACK_K);

    const t = await timesOf(businessId, reference);
    expect(t.status).toBe('paid');
    expect(t.provider_paid_at).toBeNull();
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('stays null for a paid_at that is not a valid instant', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: 'yesterday afternoon' });

    await deliver(reference, PACK_K);

    const t = await timesOf(businessId, reference);
    expect(t.status).toBe('paid');
    expect(t.provider_paid_at).toBeNull();
  });

  it('is stored as the same UTC instant whatever offset Paystack wrote it in', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: '2026-08-19T13:00:00.000+01:00' });

    await deliver(reference, PACK_K);

    expect((await timesOf(businessId, reference)).provider_paid_at?.toISOString()).toBe(
      '2026-08-19T12:00:00.000Z',
    );
  });

  it('is recorded on a plan charge too', async () => {
    const businessId = await seedBusiness();
    const reference = await openFirstPurchase(businessId);
    const paystackPaidAt = new Date(Date.now() - HOUR);
    provider.willVerify(reference, { amountK: CHAT_K, paidAtIso: paystackPaidAt.toISOString() });

    await deliver(reference, CHAT_K);

    const t = await timesOf(businessId, reference);
    expect(t.status).toBe('paid');
    expect(t.provider_paid_at?.toISOString()).toBe(paystackPaidAt.toISOString());
  });
});

describe('OD-40: the settlement time', () => {
  it('stays null: no Paystack settlement evidence exists for a Rekoda charge', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, {
      amountK: PACK_K,
      paidAtIso: new Date(Date.now() - HOUR).toISOString(),
    });

    await deliver(reference, PACK_K);

    expect((await timesOf(businessId, reference)).provider_settled_at).toBeNull();
  });
});

describe('OD-40: the units-credited time', () => {
  it('is the database time of the transaction that credited the units, separate from the payment time', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const paystackPaidAt = new Date(Date.now() - 5 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: paystackPaidAt.toISOString() });

    const before = await dbNow();
    await deliver(reference, PACK_K);
    const after = await dbNow();

    const t = await timesOf(businessId, reference);
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
    expect(t.units_credited_at).not.toBeNull();
    expect(t.units_credited_at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(t.units_credited_at!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(t.units_credited_at!.getTime()).not.toBe(t.provider_paid_at!.getTime());
  });

  it('keeps the month a pack counts toward unchanged: the month it was credited in', async () => {
    const businessId = await seedBusiness();
    /* A paid business: a trial's bonus goes to its trial row whatever the month (OWN-54), which
     * would hide a credit written to the Paystack payment month. */
    await setPlanAsOwner(urls, businessId, {
      plan: 'chat',
      planExpiresAt: new Date(Date.now() + 20 * 24 * HOUR),
    });
    const reference = await openPack(businessId);
    /* Paid at Paystack 40 days ago (a long-delayed webhook): the units still land in
     * the month they are credited, exactly as before OD-40. */
    const longAgo = new Date(Date.now() - 40 * 24 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: longAgo.toISOString() });

    await deliver(reference, PACK_K);

    /* Read the stored meter rows: `usageFor` on a trial reads the trial row whatever month
     * is asked, so only the rows themselves show which month the units were written to. */
    const credited = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ period: string; bonus: number }>(sql`
        SELECT period, bonus FROM usage_counters
        WHERE business_id = ${businessId}::uuid AND bonus > 0`),
    );
    expect([...credited]).toEqual([{ period: usagePeriod(new Date()), bonus: PACK_UNITS }]);
    expect([...credited].some((row) => row.period === usagePeriod(longAgo))).toBe(false);
    expect((await timesOf(businessId, reference)).provider_paid_at?.toISOString()).toBe(
      longAgo.toISOString(),
    );
  });

  it('is null on a plan charge, which credits no units', async () => {
    const businessId = await seedBusiness();
    const reference = await openFirstPurchase(businessId);
    provider.willVerify(reference, { amountK: CHAT_K, paidAtIso: new Date().toISOString() });

    await deliver(reference, CHAT_K);

    const t = await timesOf(businessId, reference);
    expect(t.status).toBe('paid');
    expect(t.units_credited_at).toBeNull();
  });

  it('is null while a payment is pending, underpaid or failed, as are the provider times', async () => {
    const businessId = await seedBusiness();
    const pending = await openPack(businessId);
    provider.willVerify(pending, { succeeded: false, providerStatus: 'ongoing', amountK: PACK_K });
    await deliver(pending, PACK_K);
    let t = await timesOf(businessId, pending);
    expect(t.status).toBe('pending');
    expect(t.provider_paid_at).toBeNull();
    expect(t.units_credited_at).toBeNull();

    provider.willVerify(pending, {
      amountK: PACK_K - 1,
      paidAtIso: new Date().toISOString(),
    });
    await deliver(pending, PACK_K - 1);
    t = await timesOf(businessId, pending);
    expect(t.status).toBe('pending');
    expect(t.provider_paid_at).toBeNull();
    expect(t.units_credited_at).toBeNull();
    expect(await bonusOf(businessId)).toBe(0);
  });
});

describe('OD-40: replays, redeliveries and late events never move a recorded time', () => {
  it('a duplicate success webhook leaves all three times exactly as the first wrote them', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const first = new Date(Date.now() - 2 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: first.toISOString() });
    await deliver(reference, PACK_K);
    const once = await timesOf(businessId, reference);

    /* The redelivery verifies to a DIFFERENT paid_at (a provider correction or a lie). */
    provider.willVerify(reference, {
      amountK: PACK_K,
      paidAtIso: new Date(Date.now() - 30 * HOUR).toISOString(),
    });
    await deliver(reference, PACK_K);

    expect(await timesOf(businessId, reference)).toEqual(once);
    expect(await bonusOf(businessId)).toBe(PACK_UNITS);
  });

  it('a pending event arriving after the success (out of order) changes nothing', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, {
      amountK: PACK_K,
      paidAtIso: new Date(Date.now() - HOUR).toISOString(),
    });
    await deliver(reference, PACK_K);
    const once = await timesOf(businessId, reference);

    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'ongoing',
      amountK: PACK_K,
    });
    await deliver(reference, PACK_K);

    expect(await timesOf(businessId, reference)).toEqual(once);
  });

  it('a pending event first, then the success: the times come from the success', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    provider.willVerify(reference, {
      succeeded: false,
      providerStatus: 'ongoing',
      amountK: PACK_K,
    });
    await deliver(reference, PACK_K);

    const paystackPaidAt = new Date(Date.now() - HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: paystackPaidAt.toISOString() });
    await deliver(reference, PACK_K);

    const t = await timesOf(businessId, reference);
    expect(t.provider_paid_at?.toISOString()).toBe(paystackPaidAt.toISOString());
    expect(t.units_credited_at).not.toBeNull();
  });

  it('the repository writes each time once: a second write is conditional and loses', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const first = new Date(Date.now() - 2 * HOUR);
    await withBusiness(settlementDb(), businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      const settled = await subscriptionsRepo.settleCharge(tx, {
        reference,
        status: 'paid',
        providerReference: 'stub-retry-1',
        paidAmountK: PACK_K,
        providerPaidAt: first,
        when: new Date(),
      });
      expect(settled?.providerPaidAt?.toISOString()).toBe(first.toISOString());
      expect(await subscriptionsRepo.markUnitsCredited(tx, businessId, reference)).toBe(true);
    });
    const once = await timesOf(businessId, reference);

    await withBusiness(settlementDb(), businessId, async (tx) => {
      // A retried settle finds nothing pending and writes nothing.
      expect(
        await subscriptionsRepo.settleCharge(tx, {
          reference,
          status: 'paid',
          providerReference: 'stub-retry-2',
          providerPaidAt: new Date(),
          when: new Date(),
        }),
      ).toBeNull();
      expect(await subscriptionsRepo.markUnitsCredited(tx, businessId, reference)).toBe(false);
    });

    expect(await timesOf(businessId, reference)).toEqual(once);
  });

  it('a units-credited mark cannot land on an unpaid charge', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.markUnitsCredited(tx, businessId, reference),
      ),
    ).toBe(false);
    expect((await timesOf(businessId, reference)).units_credited_at).toBeNull();
  });
});

describe('OD-40: the payment record shows the three times separately', () => {
  it('labels Paystack payment time, Rekoda record time and units-added time apart', async () => {
    const businessId = await seedBusiness();
    const reference = await openPack(businessId);
    const paystackPaidAt = new Date(Date.now() - 4 * HOUR);
    provider.willVerify(reference, { amountK: PACK_K, paidAtIso: paystackPaidAt.toISOString() });
    await deliver(reference, PACK_K);

    const record = await new BillingService(config, appDb, settlementDb()).paymentRecord(
      businessId,
      reference,
    );
    const t = await timesOf(businessId, reference);
    expect(record?.providerPaidAt).toBe(paystackPaidAt.toISOString());
    expect(record?.paidAt).toBe(t.paid_at!.toISOString());
    expect(record?.unitsCreditedAt).toBe(t.units_credited_at!.toISOString());
    expect(record?.providerSettledAt).toBeNull();
  });
});
