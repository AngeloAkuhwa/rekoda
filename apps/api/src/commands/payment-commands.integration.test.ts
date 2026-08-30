/**
 * The payment commands (spec §25, §6; PR-022), proved on what the slice and
 * the provenance model promise:
 *
 *   - a replayed RecordPayment returns the first receipt and books nothing;
 *   - a REFUSAL is an outcome, so the idempotency claim completes beside it
 *     and a retried refusal replays as the same refusal — never a claim
 *     stuck "running";
 *   - the outbox announcement, the receipt job and the booking are one
 *     transaction;
 *   - the evidence row records that an image was shown, the payment cites
 *     it, and neither wears a badge the other earned (§6.1);
 *   - ConfirmPayment books provider money with the PROVIDER_VERIFIED
 *     provenance and its own announcement.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  evidenceRepo,
  identity,
  issueRepo,
  paymentsHub,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { paymentReference } from '@rekoda/core';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import {
  confirmPaymentWork,
  recordPaymentEvidenceWork,
  recordPaymentWork,
  type ConfirmPaymentInput,
  type RecordPaymentInput,
} from './payment-commands.js';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
const bus = new CommandBus(new RiskPolicyService());

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** An open invoice owing ₦10,000, the way a chat sale on credit makes one. */
async function seedOpenInvoice(businessId: string, draftId = 'draft-1') {
  return withBusiness(appDb, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: null,
      items: [{ name: 'wig', quantity: 2, unitPriceK: 500_000 }],
      subtotalK: 1_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 1_000_000,
      paidK: 0,
      balanceDueK: 1_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: draftId,
      saleSource: null,
      dueDate: null,
      actor: 'system',
    }),
  );
}

async function count(businessId: string, table: string, where = ''): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
          WHERE business_id = ${businessId}::uuid ${sql.raw(where)}`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

describe('RecordPayment through the bus', () => {
  it('books once, and the replay returns the first receipt booking nothing', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);
    const input: RecordPaymentInput = {
      businessId,
      invoice: { id: sale.invoiceId },
      amountK: 400_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: 'draft-pay-1',
      actor: 'system',
      evidenceBasis: 'TYPED',
    };
    const envelope = {
      businessId,
      command: 'RecordPayment' as const,
      payload: input,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-pay-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPaymentWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.outcome).toBe('recorded');
    if (first.result.outcome !== 'recorded') return;
    expect(first.result.balanceDueK).toBe(600_000);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPaymentWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'payments')).toBe(1);
    expect(await count(businessId, 'receipts')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'payment.recorded'")).toBe(1);
  });

  it('a refusal is an outcome the claim completes beside, and it replays', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);

    /* Settle the invoice whole first. */
    await withBusiness(appDb, businessId, (tx) =>
      recordPaymentWork(tx, {
        businessId,
        invoice: { id: sale.invoiceId },
        amountK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-pay-full',
        actor: 'system',
      }),
    );

    const late: RecordPaymentInput = {
      businessId,
      invoice: { id: sale.invoiceId },
      amountK: 200_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-pay-late',
      actor: 'system',
    };
    const envelope = {
      businessId,
      command: 'RecordPayment' as const,
      payload: late,
      actor: 'system',
      ingress: 'CHAT' as const,
      idempotencyKey: 'draft:draft-pay-late',
    };

    const refused = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPaymentWork(tx, late)),
    );
    expect(refused.outcome).toBe('done');
    if (refused.outcome !== 'done') return;
    expect(refused.result.outcome).toBe('already_settled');

    /* The claim COMPLETED with the refusal: the retry replays it rather
     * than finding a claim stuck "running" or booking money this time. */
    const retried = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => recordPaymentWork(tx, late)),
    );
    expect(retried.outcome).toBe('done');
    if (retried.outcome !== 'done') return;
    expect(retried.replayed).toBe(true);
    expect(retried.result.outcome).toBe('already_settled');

    expect(await count(businessId, 'payments')).toBe(1);
  });

  it('the booking, the receipt job and the announcement roll back together', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);

    await expect(
      withBusiness(appDb, businessId, async (tx) => {
        await recordPaymentWork(tx, {
          businessId,
          invoice: { id: sale.invoiceId },
          amountK: 400_000,
          method: 'transfer',
          sourceType: 'chat',
          sourceId: 'draft-pay-boom',
          actor: 'system',
        });
        throw new Error('after the work, before the commit');
      }),
    ).rejects.toThrow('after the work');

    expect(await count(businessId, 'payments')).toBe(0);
    expect(await count(businessId, 'receipts')).toBe(0);
    expect(await count(businessId, 'outbox_events', "AND type = 'payment.recorded'")).toBe(0);
  });

  it('resolves an invoice NUMBER inside the tenant transaction, dashboard-style', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);

    const done = await withBusiness(appDb, businessId, (tx) =>
      recordPaymentWork(tx, {
        businessId,
        invoice: { number: sale.invoiceNumber.toLowerCase() },
        amountK: 1_000_000,
        method: 'cash',
        sourceType: 'dashboard',
        sourceId: sale.invoiceNumber,
        actor: 'user:test',
        clientRef: 'form-1',
        evidenceBasis: 'NOT_A_MESSAGE',
      }),
    );
    expect(done.outcome).toBe('recorded');
    if (done.outcome !== 'recorded') return;
    expect(done.balanceDueK).toBe(0);

    const wrong = await withBusiness(appDb, businessId, (tx) =>
      recordPaymentWork(tx, {
        businessId,
        invoice: { number: 'INV-2099-999999' },
        amountK: 1_000,
        method: 'cash',
        sourceType: 'dashboard',
        sourceId: 'INV-2099-999999',
        actor: 'user:test',
      }),
    );
    expect(wrong.outcome).toBe('not_found');
  });
});

describe('RecordPaymentEvidence (§6.1: proves nothing)', () => {
  it('records the claim, the payment cites it, and the basis says an image was seen', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);

    const recorded = await withBusiness(appDb, businessId, async (tx) => {
      const { evidenceId } = await recordPaymentEvidenceWork(tx, {
        businessId,
        source: 'chat_image',
        claimedAmountK: 400_000,
        resolution: { state: 'RESOLVED', at: new Date() },
      });
      const done = await recordPaymentWork(tx, {
        businessId,
        invoice: { id: sale.invoiceId },
        amountK: 400_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-pay-img',
        actor: 'system',
        evidenceBasis: 'SAW_AN_IMAGE',
        paymentEvidenceId: evidenceId,
      });
      return { evidenceId, done };
    });
    expect(recorded.done.outcome).toBe('recorded');

    const evidence = await withBusiness(appDb, businessId, (tx) =>
      evidenceRepo.evidenceById(tx, businessId, recorded.evidenceId),
    );
    expect(evidence).toMatchObject({
      source: 'chat_image',
      claimedAmountK: 400_000,
      resolutionState: 'RESOLVED',
    });

    /* The payment cites the evidence and names the basis — and stays
     * MERCHANT_ATTESTED: an image was SHOWN, nothing was PROVED. */
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{
        evidence_basis: string;
        payment_evidence_id: string;
        initial_confirmation_source: string;
        verified: number;
      }>(sql`
        SELECT evidence_basis, payment_evidence_id, initial_confirmation_source, verified
        FROM payments WHERE business_id = ${businessId}::uuid
      `),
    );
    const payment = [...rows][0];
    expect(payment?.evidence_basis).toBe('SAW_AN_IMAGE');
    expect(payment?.payment_evidence_id).toBe(recorded.evidenceId);
    expect(payment?.initial_confirmation_source).toBe('MERCHANT_ATTESTED');
    expect(Number(payment?.verified)).toBe(0);
  });
});

describe('ConfirmPayment through the bus', () => {
  it('books provider money as PROVIDER_VERIFIED, announces it, and replays whole', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);

    const { intent } = await withBusiness(appDb, businessId, async (tx) => ({
      intent: await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 1_000_000,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
        expiresAt: null,
      }),
    }));

    const input: ConfirmPaymentInput = {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: sale.invoiceId,
        customerId: null,
      },
      confirmedAmountK: 1_000_000,
      currency: 'NGN',
      providerType: 'paystack',
      providerRef: 'TRX-22001',
      providerStatus: 'success',
      providerFeeK: 15_000,
      feePolicy: 'merchant_bearing',
      method: 'transfer',
      paymentConnectionId: null,
      actor: 'system:payments',
      eventId: 'evt-22001',
    };
    const envelope = {
      businessId,
      command: 'ConfirmPayment' as const,
      payload: input,
      actor: 'system:payments',
      ingress: 'AUTOMATION' as const,
      idempotencyKey: `confirm:${intent.id}:TRX-22001`,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => confirmPaymentWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.reconciliation).toBe('matched');
    expect(first.result.receiptNumber).toMatch(/^RCT-/);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => confirmPaymentWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);

    expect(await count(businessId, 'payments')).toBe(1);
    const rows = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ initial_confirmation_source: string; verified: number }>(
        sql`SELECT initial_confirmation_source, verified FROM payments
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]?.initial_confirmation_source).toBe('PROVIDER_VERIFIED');
    expect(Number([...rows][0]?.verified)).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'payment.confirmed'")).toBe(1);
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('payment events are types the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    const sale = await seedOpenInvoice(businessId);
    await withBusiness(appDb, businessId, (tx) =>
      recordPaymentWork(tx, {
        businessId,
        invoice: { id: sale.invoiceId },
        amountK: 250_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-pay-evt',
        actor: 'system',
      }),
    );

    const pass = await buildOutboxDispatcher().runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(1);
  });
});

describe('sandbox money never lands on real books (remediation R4)', () => {
  async function readyToConfirm(businessId: string) {
    const sale = await seedOpenInvoice(businessId);
    const { intent } = await withBusiness(appDb, businessId, async (tx) => ({
      intent: await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 1_000_000,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
        expiresAt: null,
      }),
    }));
    const input: ConfirmPaymentInput = {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: sale.invoiceId,
        customerId: null,
      },
      confirmedAmountK: 1_000_000,
      currency: 'NGN',
      providerType: 'paystack',
      providerRef: `TRX-${intent.reference}`,
      providerStatus: 'success',
      providerFeeK: 15_000,
      feePolicy: 'merchant_bearing',
      method: 'transfer',
      paymentConnectionId: null,
      actor: 'system:payments',
      eventId: `evt-${intent.reference}`,
    };
    return { input, sale };
  }

  const connectKey = (businessId: string, providerEnvironment: 'LIVE' | 'TEST') =>
    withBusiness(appDb, businessId, (tx) =>
      paymentsHub.storeMerchantKey(tx, {
        businessId,
        providerType: 'paystack',
        merchantKeyCipher: 'vault:blob',
        merchantKeyTail: '4242',
        providerEnvironment,
      }),
    );

  it('refuses to book a TEST connection when the deployment is production', async () => {
    const businessId = await seedBusiness();
    await connectKey(businessId, 'TEST');
    const { input } = await readyToConfirm(businessId);

    /* The provider said `success`. It is telling the truth about its own
     * sandbox, and that is exactly why the prefix check at submission is not
     * enough on its own: this connection could have been stored before that
     * check existed. */
    await expect(
      withBusiness(appDb, businessId, (tx) =>
        confirmPaymentWork(tx, input, { requireLiveProvider: true }),
      ),
    ).rejects.toThrow(/TEST/);

    expect(await count(businessId, 'payments')).toBe(0);
    expect(await count(businessId, 'receipts')).toBe(0);
  });

  it('books a LIVE connection in production exactly as before', async () => {
    const businessId = await seedBusiness();
    await connectKey(businessId, 'LIVE');
    const { input } = await readyToConfirm(businessId);

    const booked = await withBusiness(appDb, businessId, (tx) =>
      confirmPaymentWork(tx, input, { requireLiveProvider: true }),
    );

    expect(booked.receiptNumber).toMatch(/^RCT-/);
    expect(await count(businessId, 'payments')).toBe(1);
  });

  it('leaves the platform subaccount path alone, which has its own live rule', async () => {
    /* A NULL environment is not a merchant key at all. §47 already refuses a
     * live platform key without written confirmation, and refusing here too
     * would be answering a question nobody asked of this connection. */
    const businessId = await seedBusiness();
    const { input } = await readyToConfirm(businessId);

    const booked = await withBusiness(appDb, businessId, (tx) =>
      confirmPaymentWork(tx, input, { requireLiveProvider: true }),
    );

    expect(await count(businessId, 'payments')).toBe(1);
    expect(booked.paymentId).toBeTruthy();
  });

  it('books a TEST connection outside production, because sandbox is where it belongs', async () => {
    const businessId = await seedBusiness();
    await connectKey(businessId, 'TEST');
    const { input } = await readyToConfirm(businessId);

    const booked = await withBusiness(appDb, businessId, (tx) =>
      confirmPaymentWork(tx, input, { requireLiveProvider: false }),
    );

    expect(booked.paymentId).toBeTruthy();
    expect(await count(businessId, 'payments')).toBe(1);
  });
});
