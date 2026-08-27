/**
 * The §20 settlement model (P2, PR-063): what the provider paid out, which
 * payments it covered, and the SIGNED components that explain the
 * gross→net gap. Actual provider data drives the books, so the claims
 * worth a database are about what this table refuses: an unexplained
 * report, a silently-changed payout, a component the vocabulary cannot
 * name, a deletion of a fact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { paymentReference } from '@rekoda/core';
import {
  chargebacksRepo,
  createDb,
  identity,
  issueRepo,
  paymentsHub,
  settleRepo,
  settlementsRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedMerchant() {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481860${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const connection = await withBusiness(db, business.id, (tx) =>
    paymentsHub.upsertConnection(tx, { businessId: business.id, providerType: 'paystack' }),
  );
  return { businessId: business.id, connectionId: connection.id };
}

async function seedPayment(businessId: string, amountK: number): Promise<string> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO payments (business_id, amount_k, method, source_type)
      VALUES (${businessId}::uuid, ${amountK}, 'transfer', 'provider_webhook')
      RETURNING id
    `),
  );
  const id = [...rows][0]?.id;
  if (!id) throw new Error('no payment');
  return id;
}

/** Paystack's worked shape: two payments settle, fees and VAT come off. */
function reportFor(
  businessId: string,
  connectionId: string,
  paymentIds: string[],
): settlementsRepo.SettlementReport {
  return {
    businessId,
    paymentConnectionId: connectionId,
    providerSettlementId: 'STL_20260827_001',
    status: 'SETTLED',
    grossK: 65_000_00,
    netK: 63_927_50,
    settledAt: new Date('2026-08-27T06:00:00Z'),
    items: [
      { paymentId: paymentIds[0]!, amountK: 45_000_00 },
      { paymentId: paymentIds[1]!, amountK: 20_000_00 },
    ],
    components: [
      { kind: 'PROCESSING_FEE', direction: 'DEDUCTION', amountK: 997_50 },
      { kind: 'VAT_ON_FEE', direction: 'DEDUCTION', amountK: 75_00 },
    ],
  };
}

describe('what the provider paid out (§20)', () => {
  it('records a payout with the payments it covered and its signed explanation', async () => {
    const { businessId, connectionId } = await seedMerchant();
    const payments = [
      await seedPayment(businessId, 45_000_00),
      await seedPayment(businessId, 20_000_00),
    ];

    const outcome = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, reportFor(businessId, connectionId, payments)),
    );
    if (outcome.outcome !== 'recorded') throw new Error(`unexpected: ${outcome.outcome}`);
    expect(outcome.isNew).toBe(true);

    const readback = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.settlementById(tx, businessId, outcome.id),
    );
    expect(readback).toMatchObject({
      providerSettlementId: 'STL_20260827_001',
      status: 'SETTLED',
      grossK: 65_000_00,
      netK: 63_927_50,
    });
    expect(readback!.items).toHaveLength(2);
    expect(readback!.components).toHaveLength(2);
    /* gross − components = net, readable straight off the readback. */
    const explained = readback!.components.reduce(
      (sum, c) => sum + (c.direction === 'DEDUCTION' ? -c.amountK : c.amountK),
      readback!.grossK,
    );
    expect(explained).toBe(readback!.netK);
  });

  it('REFUSES a report whose components do not explain its own gap', async () => {
    const { businessId, connectionId } = await seedMerchant();
    const payments = [
      await seedPayment(businessId, 45_000_00),
      await seedPayment(businessId, 20_000_00),
    ];
    const report = reportFor(businessId, connectionId, payments);
    report.netK = 63_000_00; // the provider's arithmetic does not add up

    const outcome = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, report),
    );
    expect(outcome).toEqual({ outcome: 'incoherent_report', expectedNetK: 63_927_50 });
    const rows = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.settlementsFor(tx, businessId),
    );
    expect(rows).toHaveLength(0);
  });

  it('a re-report with the SAME numbers progresses status; DIFFERENT numbers conflict', async () => {
    const { businessId, connectionId } = await seedMerchant();
    const payments = [
      await seedPayment(businessId, 45_000_00),
      await seedPayment(businessId, 20_000_00),
    ];
    const pending = reportFor(businessId, connectionId, payments);
    pending.status = 'PENDING';
    pending.settledAt = null;

    const first = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, pending),
    );
    if (first.outcome !== 'recorded') throw new Error('fixture');

    /* The payout lands: same numbers, settled now. Ordinary path. */
    const settled = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, reportFor(businessId, connectionId, payments)),
    );
    expect(settled).toEqual({ outcome: 'recorded', id: first.id, isNew: false });
    const readback = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.settlementById(tx, businessId, first.id),
    );
    expect(readback!.status).toBe('SETTLED');
    /* The detail rows were written once, not doubled by the refresh. */
    expect(readback!.items).toHaveLength(2);
    expect(readback!.components).toHaveLength(2);

    /* The provider re-reporting DIFFERENT numbers is a conflict for a
     * human — the stored report may already be posted. */
    const changed = reportFor(businessId, connectionId, payments);
    changed.grossK = 60_000_00;
    changed.netK = 58_927_50;
    const conflict = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, changed),
    );
    expect(conflict).toEqual({ outcome: 'conflicting_report', id: first.id });
    const after = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.settlementById(tx, businessId, first.id),
    );
    expect(after!.grossK).toBe(65_000_00);
  });

  it('a component the vocabulary cannot name, or signed by a negative, is unrepresentable', async () => {
    const { businessId, connectionId } = await seedMerchant();
    const payments = [
      await seedPayment(businessId, 45_000_00),
      await seedPayment(businessId, 20_000_00),
    ];
    const outcome = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, reportFor(businessId, connectionId, payments)),
    );
    if (outcome.outcome !== 'recorded') throw new Error('fixture');

    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO settlement_components (business_id, settlement_id, kind, direction, amount_k)
          VALUES (${businessId}::uuid, ${outcome.id}::uuid, 'SURPRISE', 'DEDUCTION', 100)
        `),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO settlement_components (business_id, settlement_id, kind, direction, amount_k)
          VALUES (${businessId}::uuid, ${outcome.id}::uuid, 'REBATE', 'ADDITION', -100)
        `),
      ),
    ).rejects.toThrow();
  });

  it('a payout is a fact: nothing deletes it, and its detail never changes', async () => {
    const { businessId, connectionId } = await seedMerchant();
    const payments = [
      await seedPayment(businessId, 45_000_00),
      await seedPayment(businessId, 20_000_00),
    ];
    const outcome = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, reportFor(businessId, connectionId, payments)),
    );
    if (outcome.outcome !== 'recorded') throw new Error('fixture');

    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM settlements WHERE id = ${outcome.id}::uuid`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE settlement_items SET amount_k = 1 WHERE settlement_id = ${outcome.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`DELETE FROM settlement_components WHERE settlement_id = ${outcome.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("a settlement citing another tenant's payment or connection is unrepresentable", async () => {
    const ada = await seedMerchant();
    const bola = await seedMerchant();
    const bolaPayment = await seedPayment(bola.businessId, 10_000_00);

    /* Ada's settlement naming Bola's payment: the composite FK refuses
     * before RLS even matters. */
    await expect(
      withBusiness(db, ada.businessId, (tx) =>
        settlementsRepo.recordSettlement(tx, {
          businessId: ada.businessId,
          paymentConnectionId: ada.connectionId,
          providerSettlementId: 'STL_X',
          status: 'SETTLED',
          grossK: 10_000_00,
          netK: 10_000_00,
          items: [{ paymentId: bolaPayment, amountK: 10_000_00 }],
          components: [],
        }),
      ),
    ).rejects.toThrow(/settlement_items/);
  });
});

describe('the settlement posting: clearing → bank + actual fees (§20, §21.1; PR-065)', () => {
  async function balanceK(businessId: string, code: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT coalesce(sum(e.debit_k - e.credit_k), 0)::int AS n
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code = ${code}
      `),
    );
    return [...rows][0]!.n;
  }

  /** A verified provider payment, booked THROUGH the connection so the
   * debit lands in that connection's clearing account. */
  async function seedVerifiedThroughConnection() {
    const { businessId, connectionId } = await seedMerchant();
    const reference = paymentReference(new Date(), (n) => randomBytes(n));
    const paymentId = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_9Z1',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 45_000_00 }],
        subtotalK: 45_000_00,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 45_000_00,
        paidK: 0,
        balanceDueK: 45_000_00,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-1',
        actor: 'system',
      });
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference,
        expectedAmountK: 45_000_00,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
      });
      const booked = await settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: intent.customerId,
        },
        confirmedAmountK: 45_000_00,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: `pst-${randomBytes(4).toString('hex')}`,
        providerStatus: 'success',
        providerFeeK: 675_00,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'test',
        eventId: `event-${randomBytes(4).toString('hex')}`,
        paymentConnectionId: connectionId,
      });
      return booked.paymentId;
    });
    return { businessId, connectionId, reference, paymentId };
  }

  it('verification debits the CONNECTION CLEARING gross — the bank waits for the payout', async () => {
    const { businessId } = await seedVerifiedThroughConnection();

    /* Clearing 1015 holds the gross; the bank saw nothing; NO fee was
     * expensed — the settlement's actual components own that (§20). */
    expect(await balanceK(businessId, '1015')).toBe(45_000_00);
    expect(await balanceK(businessId, '1010')).toBe(0);
    expect(await balanceK(businessId, '6050')).toBe(0);
  });

  it('a SETTLED payout posts bank + actual fees against clearing, ONCE — invariant 5 closes', async () => {
    const { businessId, connectionId, paymentId } = await seedVerifiedThroughConnection();
    const recorded = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId,
        paymentConnectionId: connectionId,
        providerSettlementId: 'STL_POST_1',
        status: 'SETTLED',
        grossK: 45_000_00,
        netK: 44_257_50,
        settledAt: new Date('2026-08-27T06:00:00Z'),
        items: [{ paymentId, amountK: 45_000_00 }],
        components: [
          { kind: 'PROCESSING_FEE', direction: 'DEDUCTION', amountK: 675_00 },
          { kind: 'VAT_ON_FEE', direction: 'DEDUCTION', amountK: 67_50 },
        ],
      }),
    );
    if (recorded.outcome !== 'recorded') throw new Error('fixture');

    const posted = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, recorded.id),
    );
    expect(posted).toMatchObject({ posted: true });

    /* The provider's money became the merchant's, and the clearing
     * account is EXPLAINABLE at zero (§31 invariants 5 and 10). */
    expect(await balanceK(businessId, '1015')).toBe(0);
    expect(await balanceK(businessId, '1010')).toBe(44_257_50);
    expect(await balanceK(businessId, '6050')).toBe(742_50);

    /* Once. A re-poll re-posts nothing (§9.4). */
    const again = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, recorded.id),
    );
    expect(again).toEqual({ posted: false, reason: 'already_posted' });
    expect(await balanceK(businessId, '1010')).toBe(44_257_50);
  });

  it('a payout whose items do not reconcile to its gross refuses to post (invariant 5)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerifiedThroughConnection();
    const recorded = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId,
        paymentConnectionId: connectionId,
        providerSettlementId: 'STL_SHORT',
        status: 'SETTLED',
        grossK: 50_000_00,
        netK: 50_000_00,
        items: [{ paymentId, amountK: 45_000_00 }],
        components: [],
      }),
    );
    if (recorded.outcome !== 'recorded') throw new Error('fixture');

    const posted = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, recorded.id),
    );
    expect(posted).toEqual({
      posted: false,
      reason: 'items_do_not_reconcile',
      itemsSumK: 45_000_00,
    });
    expect(await balanceK(businessId, '1010')).toBe(0);
  });

  it('reserves refuse to post until the PR that models them (§20)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerifiedThroughConnection();
    const recorded = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId,
        paymentConnectionId: connectionId,
        providerSettlementId: 'STL_RESERVE',
        status: 'SETTLED',
        grossK: 45_000_00,
        netK: 40_000_00,
        items: [{ paymentId, amountK: 45_000_00 }],
        components: [{ kind: 'RESERVE_HELD', direction: 'DEDUCTION', amountK: 5_000_00 }],
      }),
    );
    if (recorded.outcome !== 'recorded') throw new Error('fixture');

    const posted = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, recorded.id),
    );
    expect(posted).toEqual({
      posted: false,
      reason: 'unpostable_components',
      kinds: ['RESERVE_HELD'],
    });
  });
});

describe('chargeback accounting (§21; PR-066)', () => {
  async function balanceK(businessId: string, code: string): Promise<number> {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT coalesce(sum(e.debit_k - e.credit_k), 0)::int AS n
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code = ${code}
      `),
    );
    return [...rows][0]!.n;
  }

  /** Same rail as the PR-065 loop: a verified payment parked in clearing. */
  async function seedVerified() {
    const { businessId, connectionId } = await seedMerchant();
    const reference = paymentReference(new Date(), (n) => randomBytes(n));
    const paymentId = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_CB1',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 45_000_00 }],
        subtotalK: 45_000_00,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 45_000_00,
        paidK: 0,
        balanceDueK: 45_000_00,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-1',
        actor: 'system',
      });
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference,
        expectedAmountK: 45_000_00,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
      });
      const booked = await settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: intent.customerId,
        },
        confirmedAmountK: 45_000_00,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: `pst-${randomBytes(4).toString('hex')}`,
        providerStatus: 'success',
        providerFeeK: 0,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'test',
        eventId: `event-${randomBytes(4).toString('hex')}`,
        paymentConnectionId: connectionId,
      });
      return booked.paymentId;
    });
    return { businessId, connectionId, reference, paymentId };
  }

  async function settle(businessId: string, connectionId: string, paymentId: string) {
    const recorded = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId,
        paymentConnectionId: connectionId,
        providerSettlementId: `STL_CB_${paymentId.slice(0, 8)}`,
        status: 'SETTLED',
        grossK: 45_000_00,
        netK: 45_000_00,
        settledAt: new Date('2026-08-27T06:00:00Z'),
        items: [{ paymentId, amountK: 45_000_00 }],
        components: [],
      }),
    );
    if (recorded.outcome !== 'recorded') throw new Error('fixture');
    const posted = await withBusiness(db, businessId, (tx) =>
      settlementsRepo.postSettlement(tx, businessId, recorded.id),
    );
    if (!posted.posted) throw new Error('fixture: settlement did not post');
  }

  it('pre-settlement: the clearing account reverses, and the dispute is resolved by it (§21.1)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerified();
    const arBefore = await balanceK(businessId, '1100');

    const outcome = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connectionId,
        paymentId,
        providerChargebackId: 'DSP_1',
        amountK: 45_000_00,
        reason: 'customer dispute',
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'recorded', isNew: true, timing: 'PRE_SETTLEMENT' });

    expect(await balanceK(businessId, '1015')).toBe(0);
    expect(await balanceK(businessId, '1100')).toBe(arBefore + 45_000_00);
    expect(await balanceK(businessId, '2150')).toBe(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.chargebacksFor(tx, businessId),
    );
    expect(rows[0]).toMatchObject({ status: 'RECOVERED', recoveredVia: 'CLEARING_REVERSAL' });
  });

  it('post-settlement: the merchant owes the PROVIDER — a liability, never a second receivable (§21.2)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerified();
    await settle(businessId, connectionId, paymentId);
    const arBefore = await balanceK(businessId, '1100');

    const outcome = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connectionId,
        paymentId,
        providerChargebackId: 'DSP_2',
        amountK: 45_000_00,
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'recorded', timing: 'POST_SETTLEMENT' });

    /* The customer owes it again; the merchant owes the provider. The
     * bank did NOT move — the money already left at settlement. */
    expect(await balanceK(businessId, '1100')).toBe(arBefore + 45_000_00);
    expect(await balanceK(businessId, '2150')).toBe(-45_000_00);
    expect(await balanceK(businessId, '1010')).toBe(45_000_00);

    /* Re-notification: one row, one posting. */
    const again = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connectionId,
        paymentId,
        providerChargebackId: 'DSP_2',
        amountK: 45_000_00,
      }),
    );
    expect(again).toMatchObject({ outcome: 'recorded', isNew: false });
    expect(await balanceK(businessId, '2150')).toBe(-45_000_00);
  });

  it('recovery is a CHARGEBACK deduction on a later settlement, clearing the payable (§21.2)', async () => {
    const first = await seedVerified();
    await settle(first.businessId, first.connectionId, first.paymentId);
    await withBusiness(db, first.businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId: first.businessId,
        paymentConnectionId: first.connectionId,
        paymentId: first.paymentId,
        providerChargebackId: 'DSP_3',
        amountK: 45_000_00,
      }),
    );
    expect(await balanceK(first.businessId, '2150')).toBe(-45_000_00);

    /* A later payout covering a NEW payment carries the recovery — booked
     * through the same rail, so clearing stays explainable throughout. */
    const secondPaymentId = await withBusiness(db, first.businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId: first.businessId,
        customerId: null,
        customerToken: 'CUSTOMER_CB2',
        items: [{ name: 'wig', quantity: 2, unitPriceK: 30_000_00 }],
        subtotalK: 60_000_00,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 60_000_00,
        paidK: 0,
        balanceDueK: 60_000_00,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-2',
        actor: 'system',
      });
      const intent = await paymentsHub.createIntent(tx, {
        businessId: first.businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 60_000_00,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
      });
      const booked = await settleRepo.bookVerifiedPayment(tx, {
        businessId: first.businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: intent.invoiceId,
          customerId: intent.customerId,
        },
        confirmedAmountK: 60_000_00,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: `pst-${randomBytes(4).toString('hex')}`,
        providerStatus: 'success',
        providerFeeK: 0,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'test',
        eventId: `event-${randomBytes(4).toString('hex')}`,
        paymentConnectionId: first.connectionId,
      });
      return booked.paymentId;
    });
    const recorded = await withBusiness(db, first.businessId, (tx) =>
      settlementsRepo.recordSettlement(tx, {
        businessId: first.businessId,
        paymentConnectionId: first.connectionId,
        providerSettlementId: 'STL_RECOVERY',
        status: 'SETTLED',
        grossK: 60_000_00,
        netK: 14_100_00,
        settledAt: new Date('2026-08-28T06:00:00Z'),
        items: [{ paymentId: secondPaymentId, amountK: 60_000_00 }],
        components: [
          { kind: 'PROCESSING_FEE', direction: 'DEDUCTION', amountK: 900_00 },
          { kind: 'CHARGEBACK', direction: 'DEDUCTION', amountK: 45_000_00 },
        ],
      }),
    );
    if (recorded.outcome !== 'recorded') throw new Error('fixture');
    const posted = await withBusiness(db, first.businessId, (tx) =>
      settlementsRepo.postSettlement(tx, first.businessId, recorded.id),
    );
    expect(posted).toMatchObject({ posted: true });

    /* The payable cleared; the fee expensed; the bank took what was left;
     * clearing stays EXPLAINABLE at zero. NOTHING hit the fee expense for
     * the chargeback itself. */
    expect(await balanceK(first.businessId, '2150')).toBe(0);
    expect(await balanceK(first.businessId, '6050')).toBe(900_00);
    expect(await balanceK(first.businessId, '1015')).toBe(0);

    const marked = await withBusiness(db, first.businessId, (tx) =>
      chargebacksRepo
        .chargebacksFor(tx, first.businessId)
        .then((rows) => rows.find((r) => r.providerChargebackId === 'DSP_3')!),
    );
    await withBusiness(db, first.businessId, (tx) =>
      chargebacksRepo.markRecoveredBySettlement(tx, {
        businessId: first.businessId,
        chargebackId: marked.id,
      }),
    );
    const after = await withBusiness(db, first.businessId, (tx) =>
      chargebacksRepo.chargebacksFor(tx, first.businessId),
    );
    expect(after.find((r) => r.providerChargebackId === 'DSP_3')).toMatchObject({
      status: 'RECOVERED',
      recoveredVia: 'SETTLEMENT_DEDUCTION',
    });
  });

  it('the provider debiting the bank directly needs no payable (§21.2)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerified();
    await settle(businessId, connectionId, paymentId);
    const bankBefore = await balanceK(businessId, '1010');

    await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connectionId,
        paymentId,
        providerChargebackId: 'DSP_4',
        amountK: 45_000_00,
        recoveredByBankDebit: true,
      }),
    );

    expect(await balanceK(businessId, '1010')).toBe(bankBefore - 45_000_00);
    expect(await balanceK(businessId, '2150')).toBe(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.chargebacksFor(tx, businessId),
    );
    expect(rows.find((r) => r.providerChargebackId === 'DSP_4')).toMatchObject({
      status: 'RECOVERED',
      recoveredVia: 'BANK_DEBIT',
    });
  });

  it('a chargeback is history: nothing deletes it (§31 invariant 9)', async () => {
    const { businessId, connectionId, paymentId } = await seedVerified();
    await withBusiness(db, businessId, (tx) =>
      chargebacksRepo.recordChargeback(tx, {
        businessId,
        paymentConnectionId: connectionId,
        paymentId,
        providerChargebackId: 'DSP_5',
        amountK: 45_000_00,
      }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM chargebacks WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});
