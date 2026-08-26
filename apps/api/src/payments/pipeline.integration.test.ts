/**
 * The webhook-processing pipeline (docs/payments-v1.md §20–25, §37), against
 * real PostgreSQL: stored event → attribution pump → processing job → books.
 *
 * Events are seeded exactly as the ingress controller writes them (sealed
 * payload, fingerprint external id, businessId NULL) — the controller's own
 * integration suite pins that write, so the composition holds end to end.
 *
 * The claim underneath every scenario: the webhook body is a HINT. The
 * authoritative amount, currency and status come from the scripted verify
 * call, and one test makes the webhook LIE precisely to prove which one the
 * books believe.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import { encryptFacet, matchKeyFor } from '@rekoda/core/vault';
import {
  createDb,
  customersRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  paymentsHub,
  settleRepo,
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
import { StubPaymentProvider } from './provider.stub.js';
import { pumpPaystackEvents } from './paystack-pump.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-pay-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
let provider: StubPaymentProvider;
let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;
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
  stubStt = new StubSpeechToText();
  stubOcr = new StubTextExtraction();
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
    replySender: new ReplySender(config, stubSender),
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: provider,
    paymentIntents: new PaymentIntentsService(config, appDb, provider),
    stt: stubStt,
    ocr: stubOcr,
    audioProbe: new ContainerAudioProbe(),
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

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, '+2348130000001');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** An unpaid ₦150,000 invoice with a live intent, the normal way in. */
async function seedObligation(businessId: string, opts: { expiresAt?: Date } = {}) {
  return withBusiness(appDb, businessId, async (tx) => {
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
      sourceId: 'draft-1',
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: 15_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
      expiresAt: opts.expiresAt ?? null,
    });
    return { sale, intent };
  });
}

let nextTransactionId = 9_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
async function storeChargeSuccess(
  reference: string,
  opts: { amountK?: number; transactionId?: number } = {},
): Promise<string> {
  const transactionId = opts.transactionId ?? ++nextTransactionId;
  const body = {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      amount: opts.amountK ?? 15_000_000,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'adaeze.okonkwo@example.com' },
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

/* ── read-backs, all through the pinned repo layer ───────────────────────── */

const invoiceState = (businessId: string, invoiceId: string) =>
  withBusiness(appDb, businessId, (tx) => issueRepo.invoiceForPayment(tx, businessId, invoiceId));

const paymentCount = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.paymentCount(tx));

const receiptCount = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.receiptCount(tx));

const reconciliationsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.reconciliationsFor(tx));

const intentAfter = (businessId: string, reference: string) =>
  withBusiness(appDb, businessId, (tx) => paymentsHub.intentByReference(tx, businessId, reference));

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

/* ── the pipeline ────────────────────────────────────────────────────────── */

describe('the full payment (§37: "full payment")', () => {
  it('stored event → attributed → verified → booked: invoice PAID, receipt, balanced ledger', async () => {
    const businessId = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { amountK: 15_000_000, providerFeeK: 225_000 });
    const eventId = await storeChargeSuccess(intent.reference);

    expect(await pump()).toBe(1);
    // Three jobs, one chain: process books the money, render makes the
    // receipt's paper, deliver puts it on the owner's WhatsApp.
    expect(await drainJobs()).toBe(3);

    const invoice = await invoiceState(businessId, sale.invoiceId);
    expect(invoice?.status).toBe('paid');
    expect(invoice?.balanceDueK).toBe(0);

    expect(await receiptCount(businessId)).toBe(1);

    /* The owner's "money in" moment: ONE message carrying the confirmed
     * figure, the invoice it answers, and the receipt PDF itself. */
    const delivered = stubSender.lastDocument;
    expect(delivered?.to).toBe('+2348130000001');
    expect(delivered?.filename).toMatch(/^RCT-\d{4}-000001\.pdf$/);
    expect(delivered?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(delivered?.caption).toContain('Money in ✅ ₦150,000 confirmed for');
    expect(delivered?.caption).toContain(invoice?.invoiceNumber);
    const docs = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    expect(docs.map((d) => d.kind)).toContain('receipt_pdf');

    const [payment] = (await withBusiness(appDb, businessId, (tx) => settleRepo.paymentsFor(tx)))
      .rows;
    expect(payment?.verified).toBe(1);
    expect(payment?.status).toBe('confirmed');
    expect(payment?.rekodaReference).toBe(intent.reference);
    // ₦150,000 gross − ₦2,250 fee, merchant-borne by default.
    expect(payment?.settlementAmountK).toBe(14_775_000);

    const totals = await ledgerTotals(businessId);
    expect(totals.d).toBe(totals.c);

    expect((await intentAfter(businessId, intent.reference))?.status).toBe('succeeded');
    expect(await events.eventStatus(workerDb, eventId)).toMatchObject({
      processed: true,
      error: null,
      businessId,
    });
  });

  it('believes the VERIFY amount, not the webhook`s — a lying event books what the provider confirms', async () => {
    const businessId = await seedBusiness();
    const { sale, intent } = await seedObligation(businessId);
    // The webhook claims the full ₦150,000; the provider's truth is ₦90,000.
    provider.willVerify(intent.reference, { amountK: 9_000_000 });
    await storeChargeSuccess(intent.reference, { amountK: 15_000_000 });

    await pump();
    await drainJobs();

    const invoice = await invoiceState(businessId, sale.invoiceId);
    // §21's exact sentence: ₦90,000 does NOT mark a ₦150,000 invoice paid.
    expect(invoice?.status).toBe('partially_paid');
    expect(invoice?.balanceDueK).toBe(6_000_000);
    const [payment] = (await withBusiness(appDb, businessId, (tx) => settleRepo.paymentsFor(tx)))
      .rows;
    expect(payment?.grossAmountK).toBe(9_000_000);
  });
});

describe('failures and non-events (§37: "failure", "wrong amount currency")', () => {
  it('a failed charge fails the intent and books NOTHING', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { succeeded: false, providerStatus: 'failed' });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    await drainJobs();

    expect(await paymentCount(businessId)).toBe(0);
    expect((await intentAfter(businessId, intent.reference))?.status).toBe('failed');
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('provider_failed');
  });

  it('a pending charge is left alone — the success, when it comes, is a new event', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { succeeded: false, providerStatus: 'pending' });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    await drainJobs();

    // Still live, still payable — a pending transfer is not a failure.
    expect((await intentAfter(businessId, intent.reference))?.status).toBe('created');
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('provider_pending');
  });

  it('a confirmed WRONG-currency payment becomes an exception, never a booking', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { amountK: 15_000_000, currency: 'USD' });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    await drainJobs();

    expect(await paymentCount(businessId)).toBe(0);
    const [recon] = await reconciliationsOf(businessId);
    expect(recon?.status).toBe('EXCEPTION');
    expect(recon?.reason).toBe('currency_mismatch');
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('currency_mismatch');
  });

  it('a provider outage mid-verify leaves the job retryable, nothing half-written', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.failNextVerifyWith(new Error('Paystack is down'));
    provider.willVerify(intent.reference, { amountK: 15_000_000 });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce(); // fails on the outage; the transaction rolls back

    expect((await events.eventStatus(workerDb, eventId))?.processed).toBe(false);
    expect(await paymentCount(businessId)).toBe(0);
    // The job survived to retry — the failure was recorded, not swallowed.
    const jobs = await withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.some((j) => j.state === 'pending')).toBe(true);
  });
});

describe('replay and duplicates (§37: "duplicate webhook", "replay")', () => {
  it('two DIFFERENT events confirming one reference book ONE payment, ONE receipt', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { amountK: 15_000_000 });
    await storeChargeSuccess(intent.reference, { transactionId: 111 });
    const second = await storeChargeSuccess(intent.reference, { transactionId: 222 });

    await pump();
    await drainJobs();

    expect(await paymentCount(businessId)).toBe(1);
    expect(await receiptCount(businessId)).toBe(1);
    // Sale posting (2 lines) + ONE payment posting (2 lines). A double
    // booking would show up here as 6.
    expect((await ledgerTotals(businessId)).lines).toBe(4);
    expect((await events.eventStatus(workerDb, second))?.error).toBe('already_booked');
  });
});

describe('a crash between attribution and enqueue', () => {
  /**
   * Attribution commits on the worker connection and the enqueue on the app
   * connection, so a crash in the gap used to strand a CONFIRMED customer
   * payment forever: attributed, so the pump skipped it; jobless, so nothing
   * booked it. The stranded lane is the way back in.
   */
  it('revives the attributed, jobless event and books it once', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    provider.willVerify(intent.reference, { amountK: 15_000_000 });
    const eventId = await storeChargeSuccess(intent.reference, {});

    /* The crash, simulated: attribution lands, the enqueue never does. */
    expect(await events.attributeEvent(workerDb, eventId, businessId)).toBe(true);

    await pump();
    expect(await drainJobs()).toBeGreaterThan(0);
    expect(await paymentCount(businessId)).toBe(1);
    expect(await receiptCount(businessId)).toBe(1);

    /* And a second pass finds nothing to revive: the job exists now. */
    expect(await pump()).toBe(0);
    expect(await paymentCount(businessId)).toBe(1);
  });
});

describe('unmatched and late (§37: "unknown reference", "expired intent")', () => {
  it('an unknown-but-ours-shaped reference is marked for a human, and no job is queued', async () => {
    await seedBusiness();
    const eventId = await storeChargeSuccess('RKD-PAY-20260819-ZZZZZ2');

    expect(await pump()).toBe(0);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('unknown_reference');
  });

  it('a foreign reference (not RKD-PAY) is filed as not ours', async () => {
    await seedBusiness();
    const eventId = await storeChargeSuccess('someone-elses-ref-123');
    expect(await pump()).toBe(0);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('foreign_reference');
  });

  it('expires an OVERDUE intent lazily at processing time — no sweep job required', async () => {
    const businessId = await seedBusiness();
    // Past its TTL but never swept: the row still says `created`.
    const { intent } = await seedObligation(businessId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    provider.willVerify(intent.reference, { amountK: 15_000_000 });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    await drainJobs();

    // The handler swept before judging, so the money landed as late — the
    // documented rule holds by construction, not by scheduler luck.
    expect((await intentAfter(businessId, intent.reference))?.status).toBe('expired');
    expect(await paymentCount(businessId)).toBe(0);
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('late_confirmation');
  });

  it('money confirmed AFTER expiry is an exception, never a resurrection', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.advanceIntent(tx, intent.id, 'expired'),
    );
    provider.willVerify(intent.reference, { amountK: 15_000_000 });
    const eventId = await storeChargeSuccess(intent.reference);

    await pump();
    await drainJobs();

    expect((await intentAfter(businessId, intent.reference))?.status).toBe('expired');
    expect(await paymentCount(businessId)).toBe(0);
    const [recon] = await reconciliationsOf(businessId);
    expect(recon?.reason).toBe('late_confirmation');
    expect((await events.eventStatus(workerDb, eventId))?.error).toBe('late_confirmation');
  });
});

describe('minting intents (§8–13, §37: "inactive connection")', () => {
  async function activeConnection(businessId: string): Promise<void> {
    await withBusiness(appDb, businessId, async (tx) => {
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

  async function invoiceWithCustomer(
    businessId: string,
    facets: 'with_email' | 'without_email',
  ): Promise<string> {
    const identities: customersRepo.IdentityInput[] = [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
    ];
    if (facets === 'with_email') {
      identities.push({
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey, `${businessId}:email`),
        matchKey: null,
      });
    }
    const customer = await customersRepo.createCustomerWithIdentities(
      appDb,
      businessId,
      'X81',
      identities,
    );
    const sale = await withBusiness(appDb, businessId, (tx) =>
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
        sourceId: 'draft-9',
        actor: 'system',
      }),
    );
    return sale.invoiceId;
  }

  const service = () => new PaymentIntentsService(config, appDb, provider);

  it('mints, initialises transfer-first, and hands back a checkout — from records only', async () => {
    const businessId = await seedBusiness();
    await activeConnection(businessId);
    const invoiceId = await invoiceWithCustomer(businessId, 'with_email');

    const result = await service().createForInvoice(businessId, invoiceId);

    if (result.state !== 'ready') throw new Error(`expected ready, got ${result.state}`);
    expect(result.reference).toMatch(/^RKD-PAY-/);
    expect(result.amountK).toBe(8_000_000);
    // The adapter received the REAL email from the vault and the subaccount
    // from the connection — deterministically, no model in the path.
    expect(provider.initialized[0]?.customerEmail).toBe('adaeze@example.com');
    expect(provider.initialized[0]?.subaccountCode).toBe('ACCT_live1');
  });

  it('asks for customer information when no email exists — never invents one', async () => {
    const businessId = await seedBusiness();
    await activeConnection(businessId);
    const invoiceId = await invoiceWithCustomer(businessId, 'without_email');

    const result = await service().createForInvoice(businessId, invoiceId);

    expect(result.state).toBe('requires_customer_information');
    // The forbidden fix (customer123@rekoda.app) would surface here as a
    // provider call this assertion says never happened.
    expect(provider.initialized).toHaveLength(0);
  });

  it('refuses to mint against a connection that is not active (§47 posture)', async () => {
    const businessId = await seedBusiness();
    const invoiceId = await invoiceWithCustomer(businessId, 'with_email');

    const result = await service().createForInvoice(businessId, invoiceId);

    expect(result).toEqual({ state: 'connection_not_active', connectionStatus: 'not_configured' });
  });

  it('re-offering payment for one invoice reuses the live intent — one obligation, one reference', async () => {
    const businessId = await seedBusiness();
    await activeConnection(businessId);
    const invoiceId = await invoiceWithCustomer(businessId, 'with_email');

    const first = await service().createForInvoice(businessId, invoiceId);
    const second = await service().createForInvoice(businessId, invoiceId);

    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('expected ready');
    expect(second.reference).toBe(first.reference);
    expect(provider.initialized).toHaveLength(1); // no second provider call
  });

  it('never reuses a STALE intent — an expired reference gets a fresh mint', async () => {
    const businessId = await seedBusiness();
    await activeConnection(businessId);
    const invoiceId = await invoiceWithCustomer(businessId, 'with_email');
    // An old intent, past its TTL, never swept — exactly what a customer who
    // went quiet for a day leaves behind.
    const stale = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 8_000_000,
        providerType: 'paystack',
        invoiceId,
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );

    const result = await service().createForInvoice(businessId, invoiceId);

    if (result.state !== 'ready') throw new Error(`expected ready, got ${result.state}`);
    // The stale reference was expired, not handed back to the customer.
    expect(result.reference).not.toBe(stale.reference);
    expect((await intentAfter(businessId, stale.reference))?.status).toBe('expired');
  });
});
