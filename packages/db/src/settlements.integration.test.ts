/**
 * The §20 settlement model (P2, PR-063): what the provider paid out, which
 * payments it covered, and the SIGNED components that explain the
 * gross→net gap. Actual provider data drives the books, so the claims
 * worth a database are about what this table refuses: an unexplained
 * report, a silently-changed payout, a component the vocabulary cannot
 * name, a deletion of a fact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  paymentsHub,
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
