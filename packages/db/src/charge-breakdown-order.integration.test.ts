/**
 * A checkout breakdown that reads back in the order it was written
 * (migration 0148) - the 0146 fix, applied to the customer-facing table.
 *
 * One checkout records its breakdown lines inside ONE transaction, and every
 * line took `created_at DEFAULT now()` - TRANSACTION START time - so all of
 * them carried the same instant and `chargesForOrder` had nothing left to
 * order them by. The reshuffle arrives with `resolveChargeActual`: replacing
 * the estimated fee with the settled one writes a new row version at the end
 * of the heap, which is exactly when a tied breakdown reorders under the
 * customer's receipt.
 *
 * Latent rather than live when fixed: the one production writer records a
 * single PAYMENT_PROCESSING charge per order, so no real order carried a tie
 * yet. The table's design is "every line of a checkout breakdown as a
 * record", so the second line type would have made the order arbitrary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { chargesRepo, createDb, identity, withBusiness, type Db, type TenantDb } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let app: Db;
let closeOwner: () => Promise<void>;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
  const asApp = createDb(urls.app, { max: 4 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedOrder(): Promise<{ businessId: string; orderId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481500${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const rows = await owner.execute<{ id: string }>(sql`
    INSERT INTO orders (business_id, order_number, total_k, source_type, status)
    VALUES (${business.id}::uuid, ${`ORD-CBO-${seq}`}, 10000, 'chat', 'placed') RETURNING id`);
  const orderId = [...rows][0]?.id;
  if (!orderId) throw new Error('fixture insert returned no id');
  return { businessId: business.id, orderId };
}

/** One checkout: three lines, one transaction - the design's intended shape. */
async function recordBreakdown(businessId: string, orderId: string): Promise<string[]> {
  const ids: string[] = [];
  await withBusiness(app, businessId, async (tx: TenantDb) => {
    for (const line of [
      { type: 'DELIVERY', label: 'Delivery', amountMinor: 3000, beneficiary: 'MERCHANT' },
      {
        type: 'PAYMENT_PROCESSING',
        label: 'Payment charge',
        amountMinor: 150,
        beneficiary: 'PROVIDER',
      },
      { type: 'SERVICE', label: 'Service', amountMinor: 500, beneficiary: 'MERCHANT' },
    ] as const) {
      const written = await chargesRepo.recordCharge(tx, {
        businessId,
        orderId,
        type: line.type,
        label: line.label,
        amountMinor: line.amountMinor,
        beneficiary: line.beneficiary,
        economicBearer: 'CUSTOMER',
      });
      ids.push(written.id);
    }
  });
  return ids;
}

function defaultExpr(column: string): Promise<string | undefined> {
  return owner
    .execute<{ expr: string }>(
      sql`
      SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relname = 'payment_charges'
        JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE a.attname = ${column}
    `,
    )
    .then((rows) => [...rows][0]?.expr);
}

describe('the breakdown reads back in the order the checkout wrote it', () => {
  it('created_at advances within a transaction, and updated_at moves with it', async () => {
    expect(await defaultExpr('created_at')).toBe('clock_timestamp()');
    /* Or a fresh charge claims it was modified before it existed:
     * `created_at` from the wall clock, `updated_at` from transaction
     * start. */
    expect(await defaultExpr('updated_at')).toBe('clock_timestamp()');
  });

  it('three lines from one checkout read back in written order, on distinct instants', async () => {
    const { businessId, orderId } = await seedOrder();
    const written = await recordBreakdown(businessId, orderId);

    const read = await withBusiness(app, businessId, (tx) =>
      chargesRepo.chargesForOrder(tx, businessId, orderId),
    );
    expect(read.map((c) => c.id)).toEqual(written);
    expect(read.map((c) => c.label)).toEqual(['Delivery', 'Payment charge', 'Service']);

    /* Asserted on the column and not only on the order it produced: with the
     * old default all three rows tie and the `id` tiebreaker still resolves
     * them, correctly by luck some of the time. Distinct, strictly
     * increasing instants are false whenever the default regresses. */
    const stamps = await owner.execute<{ distinct: number; ordered: boolean }>(sql`
      SELECT count(DISTINCT created_at)::int AS distinct,
             (array_agg(id ORDER BY created_at) = array_agg(id ORDER BY created_at, id)
              AND count(DISTINCT created_at) = count(*)) AS ordered
        FROM payment_charges WHERE business_id = ${businessId}::uuid`);
    expect([...stamps][0]?.distinct, 'three lines, three instants').toBe(3);

    const fresh = await owner.execute<{ sane: boolean }>(sql`
      SELECT bool_and(updated_at >= created_at) AS sane
        FROM payment_charges WHERE business_id = ${businessId}::uuid`);
    expect([...fresh][0]?.sane, 'no charge predates itself').toBe(true);
  });

  it('a tied breakdown reads by the contract, before and after a line resolves', async () => {
    const { businessId, orderId } = await seedOrder();

    /* Rows written before 0148 carry their transaction's start time, so ties
     * survive the migration, and something has to resolve them the same way
     * on every read. Heap order is not that something: it merely HAPPENS to
     * hold while `resolveChargeActual`'s update stays heap-only, and moves
     * the moment the page is full or an indexed column changes. So this
     * asserts the CONTRACT - the reader returns exactly the explicit
     * `(created_at, id)` order - on six tied lines, where heap order agreeing
     * with id order by accident is a 1-in-720 coincidence rather than the
     * coin flip three rows would leave. */
    const written: string[] = [];
    await withBusiness(app, businessId, async (tx: TenantDb) => {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const line = await chargesRepo.recordCharge(tx, {
          businessId,
          orderId,
          type: 'SERVICE',
          label: `Line ${n}`,
          amountMinor: 100 * n,
          beneficiary: 'MERCHANT',
          economicBearer: 'CUSTOMER',
        });
        written.push(line.id);
      }
    });
    await owner.execute(
      sql`UPDATE payment_charges SET created_at = timestamptz '2026-01-01 00:00:00+00'
           WHERE business_id = ${businessId}::uuid`,
    );

    const contract = [...written].sort();
    const read = async (): Promise<string[]> =>
      (
        await withBusiness(app, businessId, (tx) =>
          chargesRepo.chargesForOrder(tx, businessId, orderId),
        )
      ).map((c) => c.id);

    expect(await read()).toEqual(contract);

    /* And across the real heap-mover: settlement resolving a line. */
    const middle = written[2];
    if (!middle) throw new Error('fixture recorded no third charge');
    const outcome = await withBusiness(app, businessId, (tx) =>
      chargesRepo.resolveChargeActual(tx, {
        businessId,
        chargeId: middle,
        actualAmountMinor: 175,
      }),
    );
    expect(outcome).toBe('resolved');
    expect(await read()).toEqual(contract);
  });

  it('resolving to actual is still exactly-once, unchanged by the new defaults', async () => {
    const { businessId, orderId } = await seedOrder();
    const written = await recordBreakdown(businessId, orderId);
    const target = written[1];
    if (!target) throw new Error('fixture recorded no second charge');

    const resolve = () =>
      withBusiness(app, businessId, (tx) =>
        chargesRepo.resolveChargeActual(tx, { businessId, chargeId: target }),
      );
    expect(await resolve()).toBe('resolved');
    expect(await resolve()).toBe('already_actual');
  });
});
