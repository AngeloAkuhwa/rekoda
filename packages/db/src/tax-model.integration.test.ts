/**
 * The tax model over real rows (spec §13; F2, PR-078). The claims: a
 * business is born with its Nigeria-first configuration; the rate is an
 * effective-dated observation derived at a date, never a stored
 * constant; treatments and point policies are constrained vocabulary;
 * and an unconfigured code is an honest null, not an invented default.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, issueRepo, taxRepo } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481890${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('born configured (§13, Nigeria-first)', () => {
  it('a new business carries the three codes, each with treatment and point policy', async () => {
    const businessId = await seedBusiness();
    const codes = await withBusiness(db, businessId, (tx) => taxRepo.taxCodesFor(tx, businessId));
    expect(codes.map((c) => [c.code, c.treatment, c.pointPolicy])).toEqual([
      ['EXEMPT', 'EXEMPT', 'ON_INVOICE_ISSUE'],
      ['STANDARD_RATE', 'TAXABLE', 'ON_INVOICE_ISSUE'],
      ['ZERO_RATED', 'ZERO_RATED', 'ON_INVOICE_ISSUE'],
    ]);
  });
});

describe('the rate in force is derived, never stored (§13)', () => {
  it('reads 5% before the Finance Act and 7.5% after, from the same rows', async () => {
    const businessId = await seedBusiness();
    const before = await withBusiness(db, businessId, (tx) =>
      taxRepo.taxStandingFor(tx, businessId, 'STANDARD_RATE', '2019-06-01'),
    );
    expect(before).toMatchObject({ treatment: 'TAXABLE', rateBps: 500 });
    const after = await withBusiness(db, businessId, (tx) =>
      taxRepo.taxStandingFor(tx, businessId, 'STANDARD_RATE', '2026-08-27'),
    );
    expect(after).toMatchObject({ treatment: 'TAXABLE', rateBps: 750 });
  });

  it('a treatment that charges nothing answers zero whatever the rows say', async () => {
    const businessId = await seedBusiness();
    for (const code of ['ZERO_RATED', 'EXEMPT']) {
      const standing = await withBusiness(db, businessId, (tx) =>
        taxRepo.taxStandingFor(tx, businessId, code, '2026-08-27'),
      );
      expect(standing, code).toMatchObject({ rateBps: 0 });
    }
  });

  it('an unconfigured code is an honest null — nothing invents a default', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) =>
        taxRepo.taxStandingFor(tx, businessId, 'LUXURY_SURCHARGE', '2026-08-27'),
      ),
    ).toBeNull();
  });
});

describe('the vocabulary is constrained', () => {
  it('a treatment or point policy outside §13 is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO tax_codes (business_id, code, label, treatment)
          VALUES (${businessId}::uuid, 'VIBES', 'Vibes tax', 'VIBES_BASED')
        `),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO tax_codes (business_id, code, label, treatment, point_policy)
          VALUES (${businessId}::uuid, 'ODD', 'Odd', 'TAXABLE', 'ON_FULL_MOON')
        `),
      ),
    ).rejects.toThrow();
    /* A negative rate is not a rate. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO tax_rates (business_id, tax_code_id, rate_bps, effective_from)
          SELECT business_id, id, -100, '2026-01-01' FROM tax_codes
          WHERE business_id = ${businessId}::uuid AND code = 'STANDARD_RATE'
        `),
      ),
    ).rejects.toThrow();
  });
});

describe('TaxEvent: the tax point recorded once (§13, PR-079)', () => {
  const sell = (businessId: string, sourceId: string) =>
    withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 10_000_000 }],
        subtotalK: 10_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 750_000,
        totalK: 10_750_000,
        paidK: 0,
        balanceDueK: 10_750_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId,
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );

  it('an invoice with VAT records the event at ITS tax point, with the posting named', async () => {
    const businessId = await seedBusiness();
    const sale = await sell(businessId, 'draft-tax-1');
    const events = await withBusiness(db, businessId, (tx) => taxRepo.taxEventsFor(tx, businessId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      basisMinor: 10_000_000,
      taxMinor: 750_000,
      currency: 'NGN',
      sourceType: 'invoice',
      sourceId: sale.invoiceId,
      journalId: sale.ledgerTransactionId,
    });
  });

  it('a VAT-free sale records NO event — nothing occurred', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
        subtotalK: 100_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 100_000,
        paidK: 0,
        balanceDueK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-tax-free',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      }),
    );
    expect(
      await withBusiness(db, businessId, (tx) => taxRepo.taxEventsFor(tx, businessId)),
    ).toEqual([]);
  });

  it('the §13 unique absorbs a retry: recording the same point twice is a duplicate', async () => {
    const businessId = await seedBusiness();
    const sale = await sell(businessId, 'draft-tax-2');
    const standing = await withBusiness(db, businessId, (tx) =>
      taxRepo.taxStandingFor(tx, businessId, 'STANDARD_RATE', '2026-08-27'),
    );
    const again = await withBusiness(db, businessId, (tx) =>
      taxRepo.recordTaxEvent(tx, {
        businessId,
        taxCodeId: standing!.taxCodeId,
        basisMinor: 10_000_000,
        taxMinor: 750_000,
        sourceType: 'invoice',
        sourceId: sale.invoiceId,
        occurredAt: new Date(),
      }),
    );
    expect(again).toBe('duplicate');
    expect(
      await withBusiness(db, businessId, (tx) => taxRepo.taxEventsFor(tx, businessId)),
    ).toHaveLength(1);
  });

  it('an event is a fact: no application role can rewrite or delete one', async () => {
    const businessId = await seedBusiness();
    await sell(businessId, 'draft-tax-3');
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE tax_events SET tax_minor = 0 WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM tax_events WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});
