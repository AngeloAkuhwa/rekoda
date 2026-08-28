/**
 * Load and performance (S1, PR-105), against real PostgreSQL.
 *
 * Not a benchmark: a canary. One merchant is seeded with a few hundred
 * documents - a busy quarter, not an edge case - and the reads a merchant
 * or operator actually waits on are asserted to stay correct and to finish
 * inside ceilings generous enough never to flake and tight enough that an
 * accidental O(n²) - a per-row subquery that lost its index, a page that
 * quietly became a table scan - fails loudly here instead of in a
 * merchant's thread. Migration 0108's indexes exist because these paths
 * were EXPLAINed at volume first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  observabilityRepo,
  partyStatementsRepo,
  reportsRepo,
  settleRepo,
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
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/** Loose enough for a loaded CI runner, tight enough to catch O(n²). */
const CEILING_MS = 5_000;

const PAID_SALES = 150;
const OPEN_SALES = 50;

async function seedBusyMerchant(): Promise<{ businessId: string; customerId: string }> {
  const user = await identity.upsertUserByPhone(db, '+2348194000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const customer = await customersRepo.createCustomerWithIdentities(db, business.id, 'CHI', []);

  for (let i = 0; i < PAID_SALES + OPEN_SALES; i += 1) {
    const paid = i < PAID_SALES;
    const totalK = 10_000 + i * 100;
    const sale = await withBusiness(db, business.id, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: business.id,
        customerId: customer.id,
        customerToken: 'CHI',
        items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK: 0,
        balanceDueK: totalK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: `load-${i}`,
        actor: 'owner',
      }),
    );
    /* Settled through the real payment path, so every paid invoice carries
     * its payment, its allocation AND its numbered receipt - the same trail
     * the invariant probes and the registers read. */
    if (paid) {
      await withBusiness(db, business.id, (tx) =>
        settleRepo.recordMerchantPayment(tx, {
          businessId: business.id,
          invoiceId: sale.invoiceId,
          amountK: totalK,
          method: 'cash',
          sourceType: 'chat',
          sourceId: `pay-${i}`,
          actor: 'owner',
        }),
      );
    }
  }
  return { businessId: business.id, customerId: customer.id };
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await work();
  return { result, ms: Date.now() - started };
}

describe('a busy quarter stays fast (S1, PR-105)', () => {
  it('the pages a merchant waits on answer whole and inside the ceiling', async () => {
    const { businessId, customerId } = await seedBusyMerchant();

    /* The customer statement: every invoice and every payment, running
     * balance intact, over the busy customer's whole history. */
    const statement = await timed(() =>
      withBusiness(db, businessId, (tx) =>
        partyStatementsRepo.customerStatementFor(tx, businessId, customerId),
      ),
    );
    expect(statement.result.entries.length).toBe(PAID_SALES * 2 + OPEN_SALES);
    expect(statement.result.closingK).toBe(
      Array.from({ length: OPEN_SALES }, (_, i) => 10_000 + (PAID_SALES + i) * 100).reduce(
        (sum, k) => sum + k,
        0,
      ),
    );
    expect(statement.ms).toBeLessThan(CEILING_MS);

    /* The receipt register: one PAGE, newest first, with the true count -
     * never the whole history (0108's index carries the sort). */
    const receipts = await timed(() =>
      withBusiness(db, businessId, (tx) => reportsRepo.receiptsFor(tx, businessId, 50)),
    );
    expect(receipts.result.rows.length).toBe(50);
    expect(receipts.result.count).toBe(PAID_SALES);
    expect(receipts.ms).toBeLessThan(CEILING_MS);

    /* The invoice register: bounded by its page whatever the volume. */
    const invoices = await timed(() =>
      withBusiness(db, businessId, (tx) => reportsRepo.invoicesFor(tx, businessId, 50)),
    );
    expect(invoices.result.rows.length).toBe(50);
    expect(invoices.result.count).toBe(PAID_SALES + OPEN_SALES);
    expect(invoices.ms).toBeLessThan(CEILING_MS);

    /* The §31 probes: per-tenant aggregates over the same volume, clean
     * and quick - the operator polls this. */
    const probes = await timed(() =>
      withBusiness(db, businessId, (tx) => observabilityRepo.financialProbesFor(tx)),
    );
    expect(probes.result.unbalancedJournals).toBe(0);
    expect(probes.result.paidWithoutSettlement).toBe(0);
    expect(probes.ms).toBeLessThan(CEILING_MS);
  }, 120_000);
});
