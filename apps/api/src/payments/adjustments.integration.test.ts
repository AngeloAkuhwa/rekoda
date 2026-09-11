/**
 * Refunds, reversals and chargebacks arriving from the provider (spec §6.1,
 * §14.2–§14.3, §21; launch gap G-06), against real PostgreSQL: stored
 * event → attribution pump → processing job → books.
 *
 * The defect these pin: a `refund.processed`, a provider-side reversal or a
 * dispute used to be routed by REFERENCE alone and then judged as if it were
 * a fresh confirmation of the original charge, so every one of them ended as
 * `already_booked` (or, for Paystack's real refund envelope, whose charge
 * rides in `transaction_reference`, as `no_payment_reference`) and the books
 * kept saying the customer had paid. The repos that record and post these
 * facts existed (0091, 0092) and were reachable from no event.
 *
 * Same harness as pipeline.integration.test.ts, plus a payment CONNECTION on
 * every merchant — production always has one (an intent cannot be minted
 * without it), and the clearing account it provisions is where a
 * pre-settlement refund or reversal is credited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference, subscriptionReference } from '@rekoda/core';
import {
  accountsRepo,
  chargebacksRepo,
  createDb,
  events,
  identity,
  issueRepo,
  jobsRepo,
  paymentsHub,
  projectionsRepo,
  refundsRepo,
  settleRepo,
  settlementsRepo,
  sql,
  subscriptionsRepo,
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
import { StubPaymentProvider } from './provider.stub.js';
import { pumpPaystackEvents } from './paystack-pump.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import {
  chargebackPaymentWork,
  refundPaymentWork,
} from '../commands/payment-adjustment-commands.js';
import { sweepSettlements } from './settlement-sweep.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-adj-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let stubSender: StubSender;
let deps: RunnerDeps;

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
  stubSender = new StubSender();
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

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  provider.reset();
  stubSender.reset();
});

/* ── seeding ─────────────────────────────────────────────────────────────── */

let phoneSeq = 0;

async function seedBusiness(): Promise<{ businessId: string; connectionId: string }> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481300${String(phoneSeq).padStart(5, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const connection = await withBusiness(appDb, business.id, (tx) =>
    paymentsHub.upsertConnection(tx, { businessId: business.id, providerType: 'paystack' }),
  );
  return { businessId: business.id, connectionId: connection.id };
}

/** An unpaid invoice with a live intent, the normal way in. */
async function seedObligation(businessId: string, totalK = 15_000_000, expectedK = totalK) {
  return withBusiness(appDb, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
      subtotalK: totalK,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK,
      paidK: 0,
      balanceDueK: totalK,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${randomBytes(3).toString('hex')}`,
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: expectedK,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    return { sale, intent };
  });
}

let nextObjectId = 7_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
async function storeEvent(
  body: { event: string; data: Record<string, unknown> },
  externalIdOverride?: string,
): Promise<string> {
  const externalId = externalIdOverride ?? `${body.data['id']}:${body.event}`;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId,
    payload: sealPayload(body, config.vaultKey, 'paystack', externalId),
    businessId: null,
  });
  return storedEventId(recorded);
}

function chargeSuccess(reference: string, amountK = 15_000_000, id = ++nextObjectId) {
  return {
    event: 'charge.success',
    data: { id, reference, amount: amountK, currency: 'NGN', status: 'success' },
  };
}

/** Paystack's refund envelope: the CHARGE it refunds rides in `transaction_reference`. */
function refundEvent(
  reference: string,
  amountK: number,
  opts: { id?: number; status?: string; event?: string } = {},
) {
  const id = opts.id ?? ++nextObjectId;
  return {
    event: opts.event ?? 'refund.processed',
    data: {
      id,
      transaction_reference: reference,
      refund_reference: `RF-${id}`,
      amount: amountK,
      currency: 'NGN',
      status: opts.status ?? 'processed',
    },
  };
}

/** Paystack's dispute envelope: the charge rides in `transaction.reference`. */
function disputeEvent(
  reference: string,
  amountK: number,
  opts: { id?: number; event?: string; status?: string; resolution?: string | null } = {},
) {
  const id = opts.id ?? ++nextObjectId;
  return {
    event: opts.event ?? 'charge.dispute.create',
    data: {
      id,
      refund_amount: amountK,
      currency: 'NGN',
      status: opts.status ?? 'awaiting-merchant-feedback',
      resolution: opts.resolution ?? null,
      transaction: { id: 1, reference, amount: amountK },
    },
  };
}

const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });

async function drainJobs(): Promise<number> {
  const runner = buildRunner(workerDb, appDb, deps);
  let ran = 0;
  while (await runner.runOnce()) ran += 1;
  return ran;
}

/** Book the obligation through the real pipeline: one charge, one payment. */
async function bookPayment(businessId: string, reference: string, amountK = 15_000_000) {
  provider.willVerify(reference, { amountK });
  const eventId = await storeEvent(chargeSuccess(reference, amountK));
  await pump();
  await drainJobs();
  const idRows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM payments WHERE rekoda_reference = ${reference}`),
  );
  const paymentId = [...idRows][0]?.id;
  if (!paymentId) throw new Error('booking did not produce a payment');
  return { eventId, paymentId };
}

/** The provider pays the payment out: a SETTLED payout covering it (§20). */
async function settle(
  businessId: string,
  connectionId: string,
  paymentId: string,
  amountK: number,
) {
  const outcome = await withBusiness(appDb, businessId, (tx) =>
    settlementsRepo.recordSettlement(tx, {
      businessId,
      paymentConnectionId: connectionId,
      providerSettlementId: `STL-${randomBytes(3).toString('hex')}`,
      status: 'SETTLED',
      grossK: amountK,
      netK: amountK,
      settledAt: new Date(),
      items: [{ paymentId, amountK }],
      components: [],
    }),
  );
  expect(outcome.outcome).toBe('recorded');
}

/* ── read-backs ──────────────────────────────────────────────────────────── */

const invoiceState = (businessId: string, invoiceId: string) =>
  withBusiness(appDb, businessId, (tx) => issueRepo.invoiceForPayment(tx, businessId, invoiceId));

const refundsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => refundsRepo.refundsFor(tx, businessId));

const reversalsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => refundsRepo.reversalsFor(tx, businessId));

const chargebacksOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => chargebacksRepo.chargebacksFor(tx, businessId));

const reconciliationsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.reconciliationsFor(tx));

const paymentStatus = async (businessId: string, paymentId: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ status: string }>(sql`SELECT status FROM payments WHERE id = ${paymentId}::uuid`),
  );
  return [...rows][0]?.status;
};

const standing = (businessId: string, paymentId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    settleRepo.standingAllocationsFor(tx, businessId, paymentId),
  );

async function ledgerTotals(businessId: string): Promise<{ d: number; c: number; lines: number }> {
  const entries = await withBusiness(appDb, businessId, (tx) =>
    issueRepo.ledgerEntriesFor(tx, businessId),
  );
  return {
    d: entries.reduce((sum, e) => sum + Number(e.debitK), 0),
    c: entries.reduce((sum, e) => sum + Number(e.creditK), 0),
    lines: entries.length,
  };
}

async function balanceByCode(businessId: string, code: string): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT coalesce(sum(e.debit_k - e.credit_k), 0)::bigint AS n
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid AND a.code = ${code}
    `),
  );
  return Number([...rows][0]!.n);
}

async function balanceByRole(
  businessId: string,
  role: 'PAYMENT_PROVIDER_CLEARING' | 'PROVIDER_CHARGEBACK_PAYABLE',
  connectionId: string,
): Promise<number> {
  return withBusiness(appDb, businessId, async (tx) => {
    const account = await accountsRepo.accountByRole(tx, businessId, role, connectionId);
    if (!account) throw new Error(`no ${role} account`);
    const rows = await tx.execute<{ n: number }>(sql`
      SELECT coalesce(sum(debit_k - credit_k), 0)::bigint AS n
      FROM ledger_entries WHERE account_id = ${account.id}::uuid
    `);
    return Number([...rows][0]!.n);
  });
}

const AR = '1100';
/** Chart code of the BANK_PAYSTACK ledger key ("Bank (Paystack settlements)");
 * 1020 is the generic bank account, which no Paystack posting touches. */
const BANK_PAYSTACK = '1010';

async function countRows(businessId: string, table: string, where = 'true'): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)),
  );
  return Number([...rows][0]!.n);
}

async function auditRows(businessId: string, action: string) {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ entity_id: string; new_value: Record<string, unknown> }>(sql`
      SELECT entity_id, new_value FROM audit_events
      WHERE business_id = ${businessId}::uuid AND entity = 'payment' AND action = ${action}
    `),
  );
  return [...rows];
}

/* ── the successful path, unchanged (G-06 invariant 15) ─────────────────── */

describe('the successful payment path is untouched', () => {
  it('payment → verification → booking → allocation → receipt → ledger, exactly as before', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { eventId, paymentId } = await bookPayment(businessId, intent.reference);

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('paid');
    expect(invoice?.balanceDueK).toBe(0);
    expect(await countRows(businessId, 'receipts')).toBe(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 15_000_000 }]);
    // Sale posting (2 lines) + the payment posting (2 lines): clearing
    // holds the money, the receivable is answered.
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect(totals.lines).toBe(4);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      15_000_000,
    );
    expect(await balanceByCode(businessId, AR)).toBe(0);
    expect(await events.eventStatus(workerDb, eventId)).toMatchObject({
      processed: true,
      error: null,
      businessId,
    });
    // A second confirming event is still the replay it always was.
    const second = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, second))?.error).toBe('already_booked');
    expect(await countRows(businessId, 'payments')).toBe(1);
    expect((await ledgerTotals(businessId)).lines).toBe(4);
  });
});

/* ── refunds ─────────────────────────────────────────────────────────────── */

describe('a provider refund of a booked payment (G-06)', () => {
  it('refund.processed BEFORE settlement: refund row, clearing credited, invoice reopened, one balanced posting', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('501', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 501 }));
    expect(await pump()).toBe(1);
    await drainJobs();

    const refunds = await refundsOf(businessId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId,
      amountK: 15_000_000,
      method: 'provider',
      providerRefundId: '501',
    });

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('issued');
    expect(invoice?.balanceDueK).toBe(15_000_000);
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');

    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect(totals.lines).toBe(linesBefore + 2);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    // The money never left the provider, so clearing gives it back — the
    // bank, which never received it, is untouched.
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(0);

    expect(await events.eventStatus(workerDb, eventId)).toMatchObject({
      processed: true,
      error: null,
    });
    // The receipt and the original booking are history, untouched.
    expect(await countRows(businessId, 'receipts')).toBe(1);
    expect(await countRows(businessId, 'payments')).toBe(1);
  });

  it('refund.processed AFTER settlement: the bank gives it back, settlement evidence stands', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const settlementItemsBefore = await countRows(businessId, 'settlement_items');
    const clearingBefore = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );

    provider.willVerifyRefund('502', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 502 }));
    await pump();
    await drainJobs();

    const [refund] = await refundsOf(businessId);
    expect(refund).toMatchObject({ method: 'bank', amountK: 15_000_000 });
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    // Clearing is exactly where the settlement left it; the bank is what moved
    // (the settle() helper records the payout without posting it, so the bank
    // starts at zero and the refund's credit is the only movement).
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingBefore,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(-15_000_000);
    expect(await countRows(businessId, 'settlement_items')).toBe(settlementItemsBefore);
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a PARTIAL refund unwinds only the refunded amount and re-allocates the rest', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('503', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 503 }));
    await pump();
    await drainJobs();

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('partially_paid');
    expect(invoice?.balanceDueK).toBe(4_000_000);
    // The original allocation is reversed in full and the customer's
    // remaining ₦110,000 answers the invoice through a fresh row (§14.2).
    const rows = await standing(businessId, paymentId);
    expect(rows.map((r) => r.amountK)).toEqual([11_000_000]);
    expect(await countRows(businessId, 'payment_allocations', 'reversal_of_id IS NOT NULL')).toBe(
      1,
    );
    expect(await countRows(businessId, 'payment_allocations', 'amount_k < 0')).toBe(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    expect(await balanceByCode(businessId, AR)).toBe(4_000_000);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a payment allocated across TWO invoices unwinds newest first, never negative, never over-unpaid', async () => {
    const { businessId } = await seedBusiness();
    const a = await seedObligation(businessId, 15_000_000);
    const b = await seedObligation(businessId, 6_000_000);
    const { paymentId } = await bookPayment(businessId, a.intent.reference);

    /* A human re-matches the ₦150,000: ₦90,000 stays on A, ₦60,000 answers B
     * (the §14.2 path — full reversal, fresh allocations). */
    await withBusiness(appDb, businessId, async (tx) => {
      const [original] = await settleRepo.standingAllocationsFor(tx, businessId, paymentId);
      const reversed = await settleRepo.reverseAllocation(tx, {
        businessId,
        allocationId: original!.id,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      expect(reversed.outcome).toBe('reversed');
      await settleRepo.allocatePayment(tx, {
        businessId,
        paymentId,
        invoiceId: a.sale.invoiceId,
        amountK: 9_000_000,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      await settleRepo.allocatePayment(tx, {
        businessId,
        paymentId,
        invoiceId: b.sale.invoiceId,
        amountK: 6_000_000,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
      await projectionsRepo.rebuildInvoiceProjection(tx, businessId, a.sale.invoiceId);
      await projectionsRepo.rebuildInvoiceProjection(tx, businessId, b.sale.invoiceId);
    });
    expect((await invoiceState(businessId, a.sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect((await invoiceState(businessId, b.sale.invoiceId))?.balanceDueK).toBe(0);

    /* The provider refunds ₦100,000: B (newest, ₦60,000) is unwound whole,
     * then ₦40,000 of A — A keeps ₦50,000. */
    provider.willVerifyRefund('504', {
      amountK: 10_000_000,
      transactionReference: a.intent.reference,
    });
    await storeEvent(refundEvent(a.intent.reference, 10_000_000, { id: 504 }));
    await pump();
    await drainJobs();

    expect(await invoiceState(businessId, b.sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 6_000_000,
    });
    expect(await invoiceState(businessId, a.sale.invoiceId)).toMatchObject({
      status: 'partially_paid',
      balanceDueK: 10_000_000,
    });
    const rows = await standing(businessId, paymentId);
    expect(rows.map((r) => ({ invoiceId: r.invoiceId, amountK: r.amountK }))).toEqual([
      { invoiceId: a.sale.invoiceId, amountK: 5_000_000 },
    ]);
    // Every reversal negates its original exactly; nothing else is negative.
    const negatives = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ bad: number }>(sql`
        SELECT count(*)::int AS bad FROM payment_allocations r
        WHERE r.business_id = ${businessId}::uuid AND r.amount_k < 0
          AND (r.reversal_of_id IS NULL OR r.amount_k <> -(SELECT o.amount_k FROM payment_allocations o WHERE o.id = r.reversal_of_id))
      `),
    );
    expect(Number([...negatives][0]!.bad)).toBe(0);
    // The customer's outstanding, from authoritative rows: A ₦100,000 + B ₦60,000.
    expect(await balanceByCode(businessId, AR)).toBe(16_000_000);
  });

  it('a DUPLICATE refund notification records nothing twice', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('505', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });

    const first = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 505 }));
    // Layer 1: the same delivery again is one row (ingress fingerprint).
    const again = await events.recordEvent(appDb, {
      provider: 'paystack',
      eventType: 'refund.processed',
      externalId: '505:refund.processed',
      payload: {},
      businessId: null,
    });
    expect(again.isNew).toBe(false);
    // Layer 2: a re-notification that somehow carries a fresh fingerprint
    // still meets the refund's provider id and changes nothing.
    const redelivered = await storeEvent(
      refundEvent(intent.reference, 15_000_000, { id: 505 }),
      '505:refund.processed:redelivery',
    );
    await pump();
    await drainJobs();

    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await countRows(businessId, 'ledger_transactions', "source_type = 'refund'")).toBe(1);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect(await countRows(businessId, 'payment_allocations')).toBe(2); // original + one reversal
    expect((await events.eventStatus(workerDb, first))?.error).toBeNull();
    expect((await events.eventStatus(workerDb, redelivered))?.error).toBe(
      'refund_already_recorded',
    );
  });

  it('refund.pending and refund.failed move no money', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    const pending = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 506,
        event: 'refund.pending',
        status: 'pending',
      }),
    );
    const failed = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 507,
        event: 'refund.failed',
        status: 'failed',
      }),
    );
    await pump();
    await drainJobs();

    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect((await events.eventStatus(workerDb, pending))?.error).toBe('refund_pending');
    expect((await events.eventStatus(workerDb, failed))?.error).toBe('refund_failed');
  });

  it('an UNMATCHED refund is filed for a human, never absorbed', async () => {
    const { businessId } = await seedBusiness();
    // A Rekoda-shaped reference nobody minted.
    const stray = paymentReference(new Date(), (n) => randomBytes(n));
    const unknown = await storeEvent(refundEvent(stray, 5_000_000, { id: 508 }));
    // An intent that exists but was never paid.
    const { intent } = await seedObligation(businessId);
    const unbooked = await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 509 }));
    // A refund the provider cannot find when asked.
    const { intent: paid } = await seedObligation(businessId);
    await bookPayment(businessId, paid.reference);
    const unverifiable = await storeEvent(refundEvent(paid.reference, 5_000_000, { id: 510 }));

    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, unknown))?.error).toBe('unknown_reference');
    expect((await events.eventStatus(workerDb, unbooked))?.error).toBe(
      'refund_without_booked_payment',
    );
    /* The provider cannot find the refund yet: the attempt fails and is
     * retried (the redelivery would be dropped at ingress), and on the last
     * attempt the disagreement becomes an exception, never a dead job. */
    expect((await events.eventStatus(workerDb, unverifiable))?.processed).toBe(false);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      await drainJobs();
    }
    expect((await events.eventStatus(workerDb, unverifiable))?.error).toBe(
      'refund_verify_not_found',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['refund_verify_not_found', 'refund_without_booked_payment']);
  });

  it('a provider truth that does not describe this payment is a question, not a posting', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('511', {
      amountK: 15_000_000,
      transactionReference: 'RKD-PAY-OTHER',
    });
    const wrongRef = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 511 }));
    provider.willVerifyRefund('512', {
      amountK: 20_000_000,
      transactionReference: intent.reference,
    });
    const tooMuch = await storeEvent(refundEvent(intent.reference, 20_000_000, { id: 512 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, wrongRef))?.error).toBe('refund_reference_mismatch');
    expect((await events.eventStatus(workerDb, tooMuch))?.error).toBe('refund_amount_mismatch');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('a refund that reaches into an OVERPAYMENT credit is refused to a human: the payment was overpaid, so the whole adjustment is OD-8', async () => {
    const { businessId } = await seedBusiness();
    // ₦100,000 owed, ₦150,000 paid: ₦50,000 sits in customer credit.
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');

    provider.willVerifyRefund('513', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 513 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_overpaid_payment');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'refund_overpaid_payment'),
    ).toBe(true);
  });

  it('an event attributed to the WRONG tenant touches nothing', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const { intent } = await seedObligation(a.businessId);
    await bookPayment(a.businessId, intent.reference);
    provider.willVerifyRefund('514', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });

    // Attribution lands on B (a stray id, a bug, an operator's slip): the
    // tenant-scoped read in B's job finds no such intent and stops.
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 514 }));
    expect(await events.attributeEvent(workerDb, eventId, b.businessId)).toBe(true);
    await pump(); // the stranded lane enqueues it under B
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('intent_missing_for_tenant');
    expect(await refundsOf(a.businessId)).toHaveLength(0);
    expect(await refundsOf(b.businessId)).toHaveLength(0);
    expect(await countRows(b.businessId, 'ledger_entries')).toBe(0);
  });
});

/* ── reversals ───────────────────────────────────────────────────────────── */

/* SYNTHETIC INGRESS. These cases store a fresh `charge.success` with a NEW
 * object id so the re-verify runs and reports `reversed`. A real redelivery
 * of the original charge event carries the same id and is dropped at ingress
 * as a duplicate, and Paystack publishes no charge-reversal webhook for an
 * inbound charge: whether anything triggers this branch in production is
 * OD-10(a), confirmed only by the G-05 drill. These cases prove the branch's
 * accounting, not its reachability. */
describe('a provider-side reversal of a booked payment (§14.3 PaymentReversal)', () => {
  it('BEFORE settlement: reversed whole, back through clearing, invoice reopened', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    // The provider now reports the charge reversed; the redelivered
    // (or fresh) charge event is what carries the news.
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-1',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect(await reversalsOf(businessId)).toMatchObject([
      { paymentId, amountK: 15_000_000, providerReversalId: 'pst-rev-1' },
    ]);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    // The intent stays succeeded: the payment happened, then was undone.
    const after = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.intentByReference(tx, businessId, intent.reference),
    );
    expect(after?.status).toBe('succeeded');
  });

  it('AFTER settlement: not a reversal any more — filed for a human, settlement evidence untouched', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('reversal_after_settlement');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'reversal_after_settlement'),
    ).toBe(true);
  });

  it('a DUPLICATE reversal notification reverses once', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
    });
    await storeEvent(chargeSuccess(intent.reference));
    const again = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect(await reversalsOf(businessId)).toHaveLength(1);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect((await events.eventStatus(workerDb, again))?.error).toBe('reversal_already_recorded');
  });
});

/* ── disputes and chargebacks ───────────────────────────────────────────── */

describe('disputes (§21): open is a risk state, lost is a chargeback', () => {
  it('a dispute OPENING reverses nothing and files one exception, however many reminders follow', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('601', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 601 }));
    const reminded = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, { id: 601, event: 'charge.dispute.remind' }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect((await events.eventStatus(workerDb, reminded))?.error).toBe('dispute_reminder');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['dispute_opened']);
  });

  it('a dispute the merchant LOST before settlement is a chargeback through clearing, and the customer owes again', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('602', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const eventId = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 602,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toMatchObject([
      {
        paymentId,
        providerChargebackId: '602',
        amountK: 15_000_000,
        timing: 'PRE_SETTLEMENT',
        status: 'RECOVERED',
        recoveredVia: 'CLEARING_REVERSAL',
      },
    ]);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(0);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
  });

  it('a dispute LOST after settlement raises a payable to the provider — a liability, never a second receivable', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);

    provider.willVerifyDispute('603', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'auto-accepted',
      outcome: 'lost',
    });
    await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 603,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'auto-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toMatchObject([
      { timing: 'POST_SETTLEMENT', status: 'OPEN', recoveredVia: null },
    ]);
    expect(await balanceByRole(businessId, 'PROVIDER_CHARGEBACK_PAYABLE', connectionId)).toBe(
      -15_000_000,
    );
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(15_000_000);
    expect(await countRows(businessId, 'settlements', "status = 'SETTLED'")).toBe(1);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a dispute the merchant WON moves nothing', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyDispute('604', {
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'declined',
      outcome: 'won',
    });
    const eventId = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 604,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'declined',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('dispute_won');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('a duplicate LOST notification charges back once', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyDispute('605', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const body = disputeEvent(intent.reference, 15_000_000, {
      id: 605,
      event: 'charge.dispute.resolve',
      status: 'resolved',
      resolution: 'merchant-accepted',
    });
    await storeEvent(body);
    const again = await storeEvent(body, '605:charge.dispute.resolve:redelivery');
    await pump();
    await drainJobs();

    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(
      await countRows(businessId, 'ledger_transactions', "posting_purpose = 'CHARGEBACK'"),
    ).toBe(1);
    expect((await events.eventStatus(workerDb, again))?.error).toBe('chargeback_already_recorded');
  });
});

/* ── the two payment domains cannot cross (G-06 invariant 10) ───────────── */

describe("Rekoda's own revenue and a merchant's customer money never meet", () => {
  it('a refund of a SUBSCRIPTION charge is flagged for an operator and never enters the merchant ledger', async () => {
    const { businessId } = await seedBusiness();
    const reference = subscriptionReference(new Date(), (n) => randomBytes(n));
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        amountK: 990_000,
        reference,
        plan: 'chat',
      }),
    );
    const ledgerBefore = await countRows(businessId, 'ledger_entries');
    provider.willVerifyRefund('701', { amountK: 990_000, transactionReference: reference });
    const eventId = await storeEvent(refundEvent(reference, 990_000, { id: 701 }));
    expect(await pump()).toBe(1);
    await drainJobs();

    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.map((j) => j.kind)).toEqual(['billing.process']);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('billing_refund_event');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await countRows(businessId, 'ledger_entries')).toBe(ledgerBefore);
    const charge = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, reference),
    );
    expect(charge?.status).toBe('pending');
  });

  it("a refund of a CUSTOMER payment never enters Rekoda's billing", async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('702', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 702 }));
    await pump();
    await drainJobs();

    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.map((j) => j.kind)).not.toContain('billing.process');
    expect(await countRows(businessId, 'subscription_charges')).toBe(0);
    expect(await refundsOf(businessId)).toHaveLength(1);
  });
});

/* ── auditability (G-06 invariant 14) ───────────────────────────────────── */

describe('every provider event that moved money back can be explained afterwards', () => {
  it('keeps the event, links the refund to it, and never rewrites the original booking', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { eventId: bookingEvent, paymentId } = await bookPayment(businessId, intent.reference);
    provider.willVerifyRefund('801', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      refundedAtIso: '2026-09-11T10:00:00.000Z',
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 801 }));
    await pump();
    await drainJobs();

    /* The provider event row: provider, type, id, ingestion, processing. */
    const row = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{
        provider: string;
        event_type: string;
        external_id: string;
        created_at: Date;
        processed_at: Date | null;
        error: string | null;
      }>(sql`
        SELECT provider, event_type, external_id, created_at, processed_at, error
        FROM external_events WHERE id = ${refundEventId}::uuid
      `),
    );
    expect([...row][0]).toMatchObject({
      provider: 'paystack',
      event_type: 'refund.processed',
      external_id: '801:refund.processed',
      error: null,
    });
    expect([...row][0]?.processed_at).not.toBeNull();

    /* The refund names the provider's id; the audit row links payment,
     * event and refund with the amount and what moved. */
    const [refund] = await refundsOf(businessId);
    expect(refund?.providerRefundId).toBe('801');
    const audit = await auditRows(businessId, 'refunded');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity_id).toBe(paymentId);
    expect(audit[0]?.new_value).toMatchObject({
      eventId: refundEventId,
      refundId: refund?.id,
      providerRefundId: '801',
      amountK: 15_000_000,
      lifecycle: 'refunded',
    });

    /* The original booking's own trail is intact. */
    expect(await auditRows(businessId, 'confirmed')).toHaveLength(1);
    expect((await events.eventStatus(workerDb, bookingEvent))?.error).toBeNull();
    const original = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ amount_k: number; initial_confirmation_source: string; verified: number }>(sql`
        SELECT amount_k::int AS amount_k, initial_confirmation_source, verified FROM payments WHERE id = ${paymentId}::uuid
      `),
    );
    expect([...original][0]).toMatchObject({
      amount_k: 15_000_000,
      initial_confirmation_source: 'PROVIDER_VERIFIED',
      verified: 1,
    });
    expect(
      await countRows(
        businessId,
        'ledger_transactions',
        "posting_purpose = 'PAYMENT_CONFIRMATION'",
      ),
    ).toBe(1);
  });
});

/* ── the independent review of 11 Sep 2026 ───────────────────────────────── */

describe('a dispute is filed once per reason while open, not once per obligation', () => {
  it('an OVERPAID obligation (an open exception already on file) still gets its dispute-opened row', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId); // ₦150,000 owed
    await bookPayment(businessId, intent.reference, 20_000_000); // ₦200,000 paid
    const before = (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION');
    expect(before.map((r) => r.reason)).toEqual(['overpaid']);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');

    provider.willVerifyDispute('611', {
      amountK: 20_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 20_000_000, { id: 611 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    const after = (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION');
    expect(after.map((r) => r.reason).sort()).toEqual(['dispute_opened', 'overpaid']);
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
  });

  it('an obligation whose earlier exception a human RESOLVED still gets its dispute-opened row, and a reminder adds none', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    await withBusiness(appDb, businessId, async (tx) => {
      await settleRepo.recordException(tx, {
        businessId,
        reason: 'late_confirmation',
        expectationKind: 'invoice',
        expectationId: sale.invoiceId,
        amountK: 15_000_000,
      });
      const [row] = (await settleRepo.reconciliationsFor(tx)).filter(
        (r) => r.reason === 'late_confirmation',
      );
      expect(await settleRepo.resolveException(tx, businessId, row!.id, 'ops')).toBe(true);
    });

    provider.willVerifyDispute('612', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const opened = await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 612 }));
    const reminded = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, { id: 612, event: 'charge.dispute.remind' }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect((await events.eventStatus(workerDb, reminded))?.error).toBe('dispute_reminder');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason).sort()).toEqual(['dispute_opened', 'late_confirmation']);
    // Exactly one dispute-opened row, and it is the open one.
    const disputes = exceptions.filter((r) => r.reason === 'dispute_opened');
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.resolvedAt).toBeNull();
  });
});

describe('a refund.processed event whose provider read disagrees', () => {
  it('a read that still says PENDING fails the attempt, keeps the event live, and books once the read catches up', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('520', {
      succeeded: false,
      providerStatus: 'pending',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 520 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce(); // the read lags: the attempt fails and rolls back

    expect((await events.eventStatus(workerDb, refundEventId))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    const retry = jobs.find((j) => j.state === 'pending');
    expect(retry).toBeDefined();
    expect(retry?.attempts).toBe(1);
    // Nothing was retired: the exception queue is as empty as it was.
    expect(
      (await reconciliationsOf(businessId)).filter((r) => r.status === 'EXCEPTION'),
    ).toHaveLength(0);

    /* The provider's record catches up; the retry (brought forward past
     * its backoff) books the refund exactly once. */
    provider.willVerifyRefund('520', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a read that says FAILED contradicts the envelope: an exception for a human, no posting', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('521', {
      succeeded: false,
      providerStatus: 'failed',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 521 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBe(
      'refund_failed_on_processed_event',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_failed_on_processed_event']);
  });
});

describe('a chargeback with nowhere to post leaves no chargeback row', () => {
  it('a LOST post-settlement dispute with no PROVIDER_CHARGEBACK_PAYABLE account is flagged, and nothing is written', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const linesBefore = (await ledgerTotals(businessId)).lines;
    const standingBefore = await standing(businessId, paymentId);

    /* The account the posting needs is unavailable (deactivated with no
     * replacement: a provisioning gap, not a merchant act). `accountByRole`
     * answers only active accounts; the role itself is immutable (0061). */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = false, deactivated_at = now()
         WHERE business_id = ${businessId}::uuid AND system_role = 'PROVIDER_CHARGEBACK_PAYABLE'
      `),
    );

    provider.willVerifyDispute('613', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 613,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_no_clearing_account',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await standing(businessId, paymentId)).toEqual(standingBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['chargeback_no_clearing_account']);
  });
});

/* ── the third independent review of 11 Sep 2026 ─────────────────────────── */

describe('an OVERPAID payment is adjusted whole or not at all (OD-8)', () => {
  it('a refund of ANY part of it is refused: the invoice stays paid, the credit stands, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    // ₦100,000 owed, ₦150,000 paid: ₦50,000 sits in customer credit.
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const linesBefore = (await ledgerTotals(businessId)).lines;

    /* The excess itself (the likeliest refund), then the invoice half:
     * each fits inside the standing allocation and each is refused. */
    provider.willVerifyRefund('530', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    const excess = await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 530 }));
    provider.willVerifyRefund('531', {
      amountK: 10_000_000,
      transactionReference: intent.reference,
    });
    const half = await storeEvent(refundEvent(intent.reference, 10_000_000, { id: 531 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, excess))?.error).toBe('refund_overpaid_payment');
    expect((await events.eventStatus(workerDb, half))?.error).toBe('refund_overpaid_payment');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'paid',
      balanceDueK: 0,
    });
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['overpaid', 'refund_overpaid_payment', 'refund_overpaid_payment']);
  });

  it('a LOST dispute on it is refused: no chargeback row, no posting, the invoice stays paid', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('620', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 620,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_overpaid_payment',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some((r) => r.reason === 'chargeback_overpaid_payment'),
    ).toBe(true);
  });
});

describe('a refund read that never turns processed ends in the exception queue, not in a dead job', () => {
  it('on the last attempt the disagreement is filed and the event retired; no posting, no dead job', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('540', {
      succeeded: false,
      providerStatus: 'pending',
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    const refundEventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 540 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    const maxAttempts = 5; // the queue's default (migration 0004)
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
      if (attempt < maxAttempts) {
        expect((await events.eventStatus(workerDb, refundEventId))?.processed).toBe(false);
      }
    }

    expect((await events.eventStatus(workerDb, refundEventId))?.error).toBe(
      'refund_read_never_processed',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_read_never_processed']);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });
});

/* ── the model fan-out reviews of 11 Sep 2026 ───────────────────────────── */

describe('a reversal with nowhere to post leaves no reversal row', () => {
  it('a pre-settlement reversal with no PAYMENT_PROVIDER_CLEARING account is flagged, nothing is written, and it posts once the account is back', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;
    const standingBefore = await standing(businessId, paymentId);

    /* The clearing account is unavailable (deactivated with no replacement:
     * a provisioning gap, not a merchant act). The role itself is immutable
     * (0061); `accountByRole` answers only active accounts. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = false, deactivated_at = now()
         WHERE business_id = ${businessId}::uuid
           AND system_role = 'PAYMENT_PROVIDER_CLEARING'
           AND scope_payment_connection_id = ${connectionId}::uuid
      `),
    );

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-9',
    });
    const first = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, first))?.error).toBe('reversal_no_clearing_account');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await standing(businessId, paymentId)).toEqual(standingBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(
      (await reconciliationsOf(businessId)).some(
        (r) => r.reason === 'reversal_no_clearing_account',
      ),
    ).toBe(true);

    /* The account is restored and the provider's news is delivered again:
     * the reversal posts, once. Nothing about the first delivery stood in
     * the way. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        UPDATE accounts SET active = true, deactivated_at = NULL
         WHERE business_id = ${businessId}::uuid
           AND system_role = 'PAYMENT_PROVIDER_CLEARING'
           AND scope_payment_connection_id = ${connectionId}::uuid
      `),
    );
    const second = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect(await reversalsOf(businessId)).toMatchObject([
      { paymentId, amountK: 15_000_000, providerReversalId: 'pst-rev-9' },
    ]);
    expect(await countRows(businessId, 'ledger_transactions', "posting_purpose = 'REVERSAL'")).toBe(
      1,
    );
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a reversal of an OVERPAID payment is refused whole (OD-8)', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId, 10_000_000, 15_000_000);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      succeeded: false,
      providerStatus: 'reversed',
      providerTransactionId: 'pst-rev-10',
    });
    const eventId = await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('reversal_overpaid_payment');
    expect(await reversalsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 10_000_000 }]);
  });
});

describe('one movement of money, two provider facts (OD-11)', () => {
  it("a PARTIAL dispute lost, then a refund for the same money: the refund is a human's, the receivable moves once", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('630', {
      amountK: 6_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 6_000_000, {
        id: 630,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, resolved))?.error).toBeNull();
    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    const linesAfterChargeback = (await ledgerTotals(businessId)).lines;

    /* Paystack's own refund for the accepted part arrives as a refund object. */
    provider.willVerifyRefund('631', {
      amountK: 6_000_000,
      transactionReference: intent.reference,
    });
    const refund = await storeEvent(refundEvent(intent.reference, 6_000_000, { id: 631 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, refund))?.error).toBe(
      'refund_payment_under_chargeback',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterChargeback);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
    expect(
      (await reconciliationsOf(businessId)).some(
        (r) => r.reason === 'refund_payment_under_chargeback',
      ),
    ).toBe(true);
  });

  it("a PARTIAL refund, then a dispute lost on the same payment: the chargeback is a human's", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('632', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 632 }));
    await pump();
    await drainJobs();
    expect(await refundsOf(businessId)).toHaveLength(1);
    const linesAfterRefund = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('633', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 5_000_000, {
        id: 633,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_payment_already_refunded',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterRefund);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(4_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 11_000_000 }]);
  });

  it('a resolution word Rekoda does not know is its own exception, never hidden behind an open dispute', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('640', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(disputeEvent(intent.reference, 15_000_000, { id: 640 }));
    await pump();
    await drainJobs();

    provider.willVerifyDispute('640', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'pending-review',
      outcome: 'open',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 640,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'pending-review',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'dispute_resolution_unrecognised',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    const reasons = (await reconciliationsOf(businessId))
      .filter((r) => r.status === 'EXCEPTION')
      .map((r) => r.reason)
      .sort();
    expect(reasons).toEqual(['dispute_opened', 'dispute_resolution_unrecognised']);
  });
});

/* ── the seventh independent review of 11 Sep 2026 ───────────────────────── */

describe('two lanes, one payment: adjustments serialise on the payment row', () => {
  const refundInput = (businessId: string, paymentId: string, connectionId: string) => ({
    businessId,
    paymentId,
    paymentAmountK: 15_000_000,
    amountK: 6_000_000,
    providerRefundId: 'race-rf-1',
    paymentConnectionId: connectionId,
    reason: 'provider refund race-rf-1',
    actor: 'system',
    eventId: 'race-refund-event',
  });
  const chargebackInput = (businessId: string, paymentId: string, connectionId: string) => ({
    businessId,
    paymentId,
    paymentAmountK: 15_000_000,
    paymentConnectionId: connectionId,
    providerChargebackId: 'race-cb-1',
    amountK: 6_000_000,
    reason: 'dispute race-cb-1 merchant-accepted',
    actor: 'system',
    eventId: 'race-dispute-event',
  });

  /**
   * Lane A does its work and then HOLDS its transaction open; lane B starts
   * while A is uncommitted. Without the row lock B's guard reads see no
   * chargeback and a full standing allocation, and B's unwind then collides
   * with A's uncommitted reversal (a unique-index wait that ends in an
   * error, or, with a different interleaving, a second posting). With the
   * lock B waits on the payment row, then reads A's commit and refuses.
   */
  async function race<A, B>(
    businessId: string,
    laneA: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<A>,
    laneB: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<B>,
  ): Promise<{ a: A; b: B }> {
    let aDone!: () => void;
    const aHasWritten = new Promise<void>((resolve) => (aDone = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const a = withBusiness(appDb, businessId, async (tx) => {
      const result = await laneA(tx);
      aDone();
      await hold;
      return result;
    });
    await aHasWritten;
    const b = withBusiness(appDb, businessId, (tx) => laneB(tx));
    // B is now blocked on the payment row (or, without the lock, racing).
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    return { a: ra, b: rb };
  }

  it('a chargeback then a concurrent refund: the refund waits, sees the chargeback, and refuses', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) => chargebackPaymentWork(tx, chargebackInput(businessId, paymentId, connectionId)),
      (tx) => refundPaymentWork(tx, refundInput(businessId, paymentId, connectionId)),
    );
    expect(a.outcome).toBe('charged_back');
    expect(b.outcome).toBe('payment_under_chargeback');

    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });

  it('a refund then a concurrent chargeback: the chargeback waits, sees the refund, and refuses', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) => refundPaymentWork(tx, refundInput(businessId, paymentId, connectionId)),
      (tx) => chargebackPaymentWork(tx, chargebackInput(businessId, paymentId, connectionId)),
    );
    expect(a.outcome).toBe('refunded');
    expect(b.outcome).toBe('payment_already_refunded');

    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect(await balanceByCode(businessId, AR)).toBe(6_000_000);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(6_000_000);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 9_000_000 }]);
  });

  it('two concurrent partial refunds whose sum exceeds the payment: one posts, the other is refused, never an error', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const { a, b } = await race(
      businessId,
      (tx) =>
        refundPaymentWork(tx, {
          ...refundInput(businessId, paymentId, connectionId),
          amountK: 10_000_000,
          providerRefundId: 'race-rf-2',
        }),
      (tx) =>
        refundPaymentWork(tx, {
          ...refundInput(businessId, paymentId, connectionId),
          amountK: 10_000_000,
          providerRefundId: 'race-rf-3',
        }),
    );
    expect(a.outcome).toBe('refunded');
    expect(b.outcome).toBe('exceeds_allocations');
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 5_000_000 }]);
  });
});

describe("the amount a chargeback posts is the provider's, never the envelope's", () => {
  it("a LOST dispute whose read carries no amount: chargeback_without_amount is a human's, nothing posts", async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('660', {
      amountK: null,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 660,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe('chargeback_without_amount');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    // The envelope's figure describes the exception, so the human sees it.
    expect(exceptions).toMatchObject([
      { reason: 'chargeback_without_amount', amountK: 15_000_000 },
    ]);
  });
});

describe('the Starter-cap figure is GROSS processed volume (ADR 0019)', () => {
  it('a partial and then a full refund leave collected-to-date unchanged', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const collected = () =>
      withBusiness(appDb, businessId, (tx) => settleRepo.collectedToDate(tx, businessId));
    expect(await collected()).toBe(15_000_000);

    provider.willVerifyRefund('670', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 670 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    expect(await collected()).toBe(15_000_000);

    provider.willVerifyRefund('671', {
      amountK: 11_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 11_000_000, { id: 671 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect(await collected()).toBe(15_000_000);
    const rows = await withBusiness(appDb, businessId, (tx) => settleRepo.collectedByBusiness(tx));
    expect(rows.find((r) => r.businessId === businessId)?.collectedK).toBe(15_000_000);
  });
});

describe('a second partial refund', () => {
  it('unwinds the retained row, empties the payment and stamps it refunded, with every reversal negating its original', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('680', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 680 }));
    await pump();
    await drainJobs();
    expect(await standing(businessId, paymentId)).toMatchObject([{ amountK: 11_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');

    provider.willVerifyRefund('681', {
      amountK: 11_000_000,
      transactionReference: intent.reference,
    });
    const second = await storeEvent(refundEvent(intent.reference, 11_000_000, { id: 681 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(2);
    expect(await standing(businessId, paymentId)).toEqual([]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect(await invoiceState(businessId, sale.invoiceId)).toMatchObject({
      status: 'issued',
      balanceDueK: 15_000_000,
    });
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
    // original, its reversal, retained ₦110,000, its reversal: four rows, two negative.
    expect(await countRows(businessId, 'payment_allocations')).toBe(4);
    expect(await countRows(businessId, 'payment_allocations', 'amount_k < 0')).toBe(2);
    const negatives = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ bad: number }>(sql`
        SELECT count(*)::int AS bad FROM payment_allocations r
        WHERE r.business_id = ${businessId}::uuid AND r.amount_k < 0
          AND (r.reversal_of_id IS NULL OR r.amount_k <> -(SELECT o.amount_k FROM payment_allocations o WHERE o.id = r.reversal_of_id))
      `),
    );
    expect(Number([...negatives][0]!.bad)).toBe(0);
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);
  });
});

/* ── the eighth independent review of 11 Sep 2026 ────────────────────────── */

describe('where a refund leaves from is decided inside the payment lock', () => {
  it('a payment settled before the refund is refunded from the BANK, whatever an earlier read believed', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const clearingBefore = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );

    /* The settlement lands after the handler would have looked but before
     * the command runs: the command must see it. */
    await settle(businessId, connectionId, paymentId, 15_000_000);
    const result = await withBusiness(appDb, businessId, (tx) =>
      refundPaymentWork(tx, {
        businessId,
        paymentId,
        paymentAmountK: 15_000_000,
        amountK: 15_000_000,
        providerRefundId: 'settled-rf-1',
        paymentConnectionId: connectionId,
        reason: 'provider refund settled-rf-1',
        actor: 'system',
        eventId: 'settled-refund-event',
      }),
    );
    expect(result.outcome).toBe('refunded');
    const [refund] = await refundsOf(businessId);
    expect(refund).toMatchObject({ method: 'bank', amountK: 15_000_000 });
    /* The refund left from the bank, so clearing is exactly what it was
     * (the settlement helper records the payout; its own posting is the
     * settlement poster's job and is not part of this case). */
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingBefore,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(-15_000_000);
    expect(await balanceByCode(businessId, AR)).toBe(15_000_000);
  });
});

describe('a provider read that names no charge is not evidence', () => {
  it('a refund read with no transaction reference is refund_reference_missing, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyRefund('690', { amountK: 15_000_000, transactionReference: null });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 690 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_reference_missing');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
  });

  it('a lost dispute read with no transaction reference is chargeback_reference_missing, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    provider.willVerifyDispute('691', {
      amountK: 15_000_000,
      transactionReference: null,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 691,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe(
      'chargeback_reference_missing',
    );
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
  });
});

/* ── the ninth independent review of 11 Sep 2026 ─────────────────────────── */

describe('a payout that covers a payment adjusted BEFORE it is not posted from derived totals (OD-10)', () => {
  it('after a pre-settlement provider refund, a totals-only payout is an exception, never a fee posting', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyRefund('700', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 700 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    const clearingAfterRefund = await balanceByRole(
      businessId,
      'PAYMENT_PROVIDER_CLEARING',
      connectionId,
    );
    expect(clearingAfterRefund).toBe(10_000_000);
    const linesAfterRefund = (await ledgerTotals(businessId)).lines;

    /* The provider reports the payout at the charge's full gross with the
     * refund netted out of the total: derived as one fee, the refund would
     * be booked as processing fees and clearing credited for it twice. */
    provider.willSettle({
      references: [intent.reference],
      grossK: 15_000_000,
      netK: 15_000_000 - 223_750 - 5_000_000,
    });
    await sweepSettlements({ workerDb, appDb, provider });

    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesAfterRefund);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearingAfterRefund,
    );
    expect(await balanceByCode(businessId, '6050')).toBe(0);
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION' && r.reason === 'settlement_components_unknown',
    );
    expect(exceptions).toHaveLength(1);

    // Re-polling the same batch adds nothing and posts nothing.
    await sweepSettlements({ workerDb, appDb, provider });
    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect(
      (await reconciliationsOf(businessId)).filter(
        (r) => r.reason === 'settlement_components_unknown',
      ),
    ).toHaveLength(1);

    /* The payment is HELD, not settled: the money is still in clearing on
     * the books, so the next adjustment keeps going through clearing. */
    const stamp = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ settlement_status: string | null }>(
        sql`SELECT settlement_status FROM payments WHERE id = ${paymentId}::uuid`,
      ),
    );
    expect([...stamp][0]?.settlement_status).toBe('held');
    provider.willVerifyRefund('701', {
      amountK: 4_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 4_000_000, { id: 701 }));
    await pump();
    await drainJobs();
    const refunds = await refundsOf(businessId);
    expect(refunds.map((r) => [r.providerRefundId, r.method])).toEqual([
      ['700', 'provider'],
      ['701', 'provider'],
    ]);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      6_000_000,
    );
    expect(await balanceByCode(businessId, BANK_PAYSTACK)).toBe(0);
  });
});

/* ── the tenth independent review of 11 Sep 2026: Paystack's documented shapes ─ */

describe('the documented refund envelope and refund read (no refund id, charge named by transaction id)', () => {
  /** Book through the real pipeline with a KNOWN provider transaction id. */
  async function bookWithTransactionId(businessId: string, reference: string, txId: string) {
    provider.willVerify(reference, { amountK: 15_000_000, providerTransactionId: txId });
    await storeEvent(chargeSuccess(reference));
    await pump();
    await drainJobs();
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ id: string; provider_reference: string | null }>(sql`
        SELECT p.id, i.provider_reference
          FROM payments p JOIN payment_intents i ON i.id = p.payment_intent_id
         WHERE p.rekoda_reference = ${reference}
      `),
    );
    const row = [...rows][0];
    if (!row?.id) throw new Error('booking did not produce a payment');
    expect(row.provider_reference).toBe(txId);
    return row.id;
  }

  /** The published sample shape: digit-string amount, no data.id. */
  function documentedRefundEvent(reference: string, amountK: number, status = 'processed') {
    return {
      event: status === 'processed' ? 'refund.processed' : `refund.${status}`,
      data: {
        status,
        transaction_reference: reference,
        refund_reference: null,
        amount: String(amountK),
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
      },
    };
  }

  it('an id-less refund.processed with a string amount is stored, matched through the refund list, and books once', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-900');

    /* The provider's list names the charge by transaction id only. */
    provider.willVerifyRefund('900', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-900',
    });
    const eventId = await storeEvent(
      documentedRefundEvent(intent.reference, 15_000_000),
      'sha256:documented-refund-900',
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    const refunds = await refundsOf(businessId);
    expect(refunds).toMatchObject([{ providerRefundId: '900', amountK: 15_000_000 }]);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);

    /* A byte-different redelivery (the same fact) is one refund still. */
    await storeEvent(
      documentedRefundEvent(intent.reference, 15_000_000),
      'sha256:documented-refund-900-again',
    );
    await pump();
    await drainJobs();
    expect(await refundsOf(businessId)).toHaveLength(1);
  });

  it('a refund read that names the charge by transaction id (Fetch shape) books against the payment that stored it', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-901');

    provider.willVerifyRefund('901', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-901',
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 901 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
  });

  it('a refund read whose transaction id is ANOTHER charge is a mismatch, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-902');

    provider.willVerifyRefund('902', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-other',
    });
    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 902 }));
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_reference_mismatch');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
  });

  it('a refund the provider cannot find yet is retried and books when it appears; one that never appears is an exception', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-903');

    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 903 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce(); // 404: the attempt fails, nothing retired
    expect((await events.eventStatus(workerDb, eventId))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(0);

    provider.willVerifyRefund('903', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, eventId))?.error).toBeNull();
    expect(await refundsOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('refunded');

    /* A second payment whose refund never becomes readable: five attempts,
     * then an exception and a retired event, never a dead job. */
    const second = await seedObligation(businessId);
    await bookWithTransactionId(businessId, second.intent.reference, 'pst-tx-904');
    const never = await storeEvent(refundEvent(second.intent.reference, 15_000_000, { id: 904 }));
    await pump();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }
    expect((await events.eventStatus(workerDb, never))?.error).toBe('refund_verify_not_found');
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a provider that cannot be read on any attempt ends as an exception, never a dead job', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-905');
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const eventId = await storeEvent(refundEvent(intent.reference, 15_000_000, { id: 905 }));
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      provider.failNextRefundReadWith(new Error('refund read returned an unreadable response'));
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_read_unavailable');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['refund_read_unavailable']);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a totals-only payout with gross equal to net over a refunded payment is still refused', async () => {
    const { businessId, connectionId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const paymentId = await bookWithTransactionId(businessId, intent.reference, 'pst-tx-906');
    provider.willVerifyRefund('906', {
      amountK: 5_000_000,
      transactionReference: intent.reference,
    });
    await storeEvent(refundEvent(intent.reference, 5_000_000, { id: 906 }));
    await pump();
    await drainJobs();
    expect(await paymentStatus(businessId, paymentId)).toBe('partially_refunded');
    const clearing = await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId);

    provider.willSettle({ references: [intent.reference], grossK: 15_000_000, netK: 15_000_000 });
    await sweepSettlements({ workerDb, appDb, provider });

    expect(await countRows(businessId, 'settlements')).toBe(0);
    expect(await balanceByRole(businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId)).toBe(
      clearing,
    );
    expect(
      (await reconciliationsOf(businessId)).filter(
        (r) => r.reason === 'settlement_components_unknown',
      ),
    ).toHaveLength(1);
  });
});

/* ── the eleventh independent review of 11 Sep 2026 ──────────────────────── */

describe('the published dispute object (null fields) reaches the books', () => {
  it('charge.dispute.create with transaction_reference, refund_amount and currency null is stored and files dispute_opened', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    provider.willVerifyDispute('2867', { amountK: null, transactionReference: intent.reference });
    const opened = await storeEvent({
      event: 'charge.dispute.create',
      data: {
        id: 2867,
        refund_amount: null,
        currency: null,
        status: 'awaiting-merchant-feedback',
        resolution: null,
        domain: 'live',
        transaction: {
          id: 5991760,
          status: 'success',
          reference: intent.reference,
          amount: 15_000_000,
          currency: 'NGN',
        },
        transaction_reference: null,
        category: 'general',
        resolvedAt: null,
        evidence: null,
        note: null,
      },
    });
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, opened))?.error).toBe('dispute_opened');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions.map((r) => r.reason)).toEqual(['dispute_opened']);
  });
});

describe('two equal partial refunds announced without refund ids', () => {
  it('the second id-less event books the refund not yet on file, and a redelivery of either adds nothing', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-920',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    const idless = (suffix: string) => ({
      event: 'refund.processed',
      data: {
        status: 'processed',
        transaction_reference: intent.reference,
        refund_reference: null,
        amount: '5000000',
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
        _delivery: suffix,
      },
    });

    provider.willVerifyRefund('920', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-920',
    });
    await storeEvent(idless('first'), 'sha256:idless-920-first');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId)).toEqual(['920']);

    provider.willVerifyRefund('921', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-920',
    });
    await storeEvent(idless('second'), 'sha256:idless-920-second');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId).sort()).toEqual([
      '920',
      '921',
    ]);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);

    const again = await storeEvent(idless('again'), 'sha256:idless-920-again');
    await pump();
    await drainJobs();
    expect((await events.eventStatus(workerDb, again))?.error).toBe('refund_already_recorded');
    expect(await refundsOf(businessId)).toHaveLength(2);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);
  });
});

describe("Paystack's refund.needs-attention is a human's, not a label", () => {
  it('files refund_needs_attention and posts nothing', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const eventId = await storeEvent(
      refundEvent(intent.reference, 15_000_000, {
        id: 930,
        event: 'refund.needs-attention',
        status: 'needs-attention',
      }),
    );
    await pump();
    await drainJobs();

    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('refund_needs_attention');
    expect(await refundsOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions).toMatchObject([{ reason: 'refund_needs_attention', amountK: 15_000_000 }]);
  });
});

/* ── the twelfth independent review of 11 Sep 2026 ───────────────────────── */

describe("a dispute read that fails is retried, then a human's, never a dead job", () => {
  it('a provider unreadable on every attempt of a LOST dispute: dispute_read_unavailable, nothing posts', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);
    const linesBefore = (await ledgerTotals(businessId)).lines;

    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 940,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      provider.failNextDisputeReadWith(new Error('dispute read failed with HTTP 503'));
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }

    expect((await events.eventStatus(workerDb, resolved))?.error).toBe('dispute_read_unavailable');
    expect(await chargebacksOf(businessId)).toHaveLength(0);
    expect((await ledgerTotals(businessId)).lines).toBe(linesBefore);
    expect(await paymentStatus(businessId, paymentId)).toBe('confirmed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('paid');
    const exceptions = (await reconciliationsOf(businessId)).filter(
      (r) => r.status === 'EXCEPTION',
    );
    expect(exceptions).toMatchObject([{ reason: 'dispute_read_unavailable', amountK: 15_000_000 }]);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });

  it('a dispute the provider cannot find yet is retried and charges back once when it appears', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    const { paymentId } = await bookPayment(businessId, intent.reference);

    const resolved = await storeEvent(
      disputeEvent(intent.reference, 15_000_000, {
        id: 941,
        event: 'charge.dispute.resolve',
        status: 'resolved',
        resolution: 'merchant-accepted',
      }),
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true); // 404: fails, retried
    expect((await events.eventStatus(workerDb, resolved))?.processed).toBe(false);
    expect(await chargebacksOf(businessId)).toHaveLength(0);

    provider.willVerifyDispute('941', {
      amountK: 15_000_000,
      transactionReference: intent.reference,
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, resolved))?.error).toBeNull();
    expect(await chargebacksOf(businessId)).toHaveLength(1);
    expect(await paymentStatus(businessId, paymentId)).toBe('reversed');
    expect((await invoiceState(businessId, sale.invoiceId))?.status).toBe('issued');
  });
});

describe('an id-less refund event waits for a refund the provider lists but has not processed', () => {
  it('the second of two equal refunds still processing: retried, then booked once it is processed', async () => {
    const { businessId } = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-950',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();
    const idless = (suffix: string) => ({
      event: 'refund.processed',
      data: {
        status: 'processed',
        transaction_reference: intent.reference,
        refund_reference: null,
        amount: '5000000',
        currency: 'NGN',
        processor: 'instant-transfer',
        integration: 412829,
        domain: 'live',
        _delivery: suffix,
      },
    });

    provider.willVerifyRefund('950', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
    });
    await storeEvent(idless('first'), 'sha256:idless-950-first');
    await pump();
    await drainJobs();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId)).toEqual(['950']);

    /* The provider lists the second refund, still processing. */
    provider.willVerifyRefund('951', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
      succeeded: false,
      providerStatus: 'processing',
    });
    const second = await storeEvent(idless('second'), 'sha256:idless-950-second');
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true);
    expect((await events.eventStatus(workerDb, second))?.processed).toBe(false);
    expect(await refundsOf(businessId)).toHaveLength(1);

    provider.willVerifyRefund('951', {
      amountK: 5_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-950',
    });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
    );
    await drainJobs();
    expect((await events.eventStatus(workerDb, second))?.error).toBeNull();
    expect((await refundsOf(businessId)).map((r) => r.providerRefundId).sort()).toEqual([
      '950',
      '951',
    ]);
    expect((await invoiceState(businessId, sale.invoiceId))?.balanceDueK).toBe(10_000_000);
  });

  it('one that never turns processed is refund_read_never_processed on the last attempt, never a dead job', async () => {
    const { businessId } = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, {
      amountK: 15_000_000,
      providerTransactionId: 'pst-tx-952',
    });
    await storeEvent(chargeSuccess(intent.reference));
    await pump();
    await drainJobs();

    provider.willVerifyRefund('952', {
      amountK: 15_000_000,
      transactionReference: null,
      transactionId: 'pst-tx-952',
      succeeded: false,
      providerStatus: 'pending',
    });
    const eventId = await storeEvent(
      {
        event: 'refund.processed',
        data: {
          status: 'processed',
          transaction_reference: intent.reference,
          refund_reference: null,
          amount: '15000000',
          currency: 'NGN',
          processor: 'instant-transfer',
          integration: 412829,
          domain: 'live',
        },
      },
      'sha256:idless-952',
    );
    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET run_at = now() WHERE state = 'pending'`),
      );
      expect(await runner.runOnce()).toBe(true);
    }
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe(
      'refund_read_never_processed',
    );
    expect(await refundsOf(businessId)).toHaveLength(0);
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((j) => j.state === 'dead' || j.state === 'pending')).toHaveLength(0);
  });
});
