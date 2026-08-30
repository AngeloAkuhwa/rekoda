/**
 * The retention sweep's storage and its one privileged function (ADR 0024).
 *
 * Deleting a tenant is the most dangerous thing this system can do, so what
 * these tests pin is mostly what it REFUSES:
 *
 *   - a business that ever paid us, however long its trial has been over;
 *   - a business nobody warned;
 *   - a business whose trial has not been over long enough;
 *   - the same business twice.
 *
 * And when it does go ahead, that it goes ahead COMPLETELY. The last test
 * seeds a fully traded month, deletes it, then scans every table in the
 * database carrying a business_id for anything left behind. A hand-written
 * list of tables goes stale the first time somebody adds one; a scan does
 * not.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { paymentReference } from '@rekoda/core';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import {
  identity,
  issueRepo,
  paymentsHub,
  retentionRepo,
  settleRepo,
  spendRepo,
  subscriptionsRepo,
  usageRepo,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;

const inTenant = <T>(businessId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(appDb, businessId, fn);

/** A business whose trial ended `daysAgo`, with nobody warned yet. */
async function abandonedTrial(daysAgo: number): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481600000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await inTenant(business.id, (tx) =>
    tx.execute(sql`
      UPDATE businesses
      SET plan_expires_at = now() - ${`${daysAgo} days`}::interval
      WHERE id = ${business.id}::uuid
    `),
  );
  return business.id;
}

const warn = (businessId: string, when = new Date()) =>
  inTenant(businessId, (tx) => retentionRepo.claimRetentionNotice(tx, businessId, when));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('who is due', () => {
  it('finds a trial that ended long enough ago and nobody has warned', async () => {
    const old = await abandonedTrial(70);
    await abandonedTrial(10); // ended last week: far too soon

    const due = await retentionRepo.dueForNotice(workerDb, daysAgo(60));
    expect(due.map((row) => row.businessId)).toEqual([old]);
    expect(due[0]?.ownerPhone).toMatch(/^\+234/);
  });

  it('NEVER touches a business that has ever paid us', async () => {
    const businessId = await abandonedTrial(400);
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'first_purchase',
        plan: 'chat',
        amountK: 990_000,
        reference: 'RKD-SUB-20260101-AAAAAA',
        periodStart: daysAgo(400),
        periodEnd: daysAgo(370),
      }),
    );
    await inTenant(businessId, (tx) =>
      subscriptionsRepo.settleCharge(tx, {
        reference: 'RKD-SUB-20260101-AAAAAA',
        status: 'paid',
        when: daysAgo(400),
      }),
    );

    // Their books belong to the financial retention period instead, and no
    // abandoned-trial rule may reach them.
    expect(await retentionRepo.dueForNotice(workerDb, daysAgo(60))).toEqual([]);
    await warn(businessId);
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
  });

  it('warns once, so the notice period runs from the FIRST warning', async () => {
    const businessId = await abandonedTrial(120);
    const first = daysAgo(5);
    expect(await warn(businessId, first)).toBe(true);
    expect(await warn(businessId, new Date())).toBe(false);

    const [row] = await retentionRepo.dueForDeletion(workerDb, daysAgo(90), new Date());
    expect(row?.notifiedAt?.toISOString().slice(0, 16)).toBe(first.toISOString().slice(0, 16));
  });

  it('leaves a warned business alone until the notice period has run', async () => {
    const businessId = await abandonedTrial(95);
    await warn(businessId, daysAgo(3));
    // Warned three days ago, and the schedule promises thirty.
    expect(await retentionRepo.dueForDeletion(workerDb, daysAgo(90), daysAgo(30))).toEqual([]);
  });
});

describe('the deletion function', () => {
  it('refuses a business nobody warned, however old', async () => {
    const businessId = await abandonedTrial(400);
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);

    const still = await inTenant(businessId, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM businesses WHERE id = ${businessId}::uuid`),
    );
    expect([...still]).toHaveLength(1);
  });

  it('refuses a trial that has not been over long enough', async () => {
    const businessId = await abandonedTrial(40);
    await warn(businessId, daysAgo(35));
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
  });

  it('refuses an id that is not a business at all', async () => {
    expect(
      await retentionRepo.deleteForRetention(
        workerDb,
        '00000000-0000-4000-8000-000000000000',
        daysAgo(90),
      ),
    ).toBe(-1);
  });

  it('deletes a traded business COMPLETELY, leaving nothing anywhere', async () => {
    const businessId = await abandonedTrial(120);
    await seedTradingHistory(businessId);
    await warn(businessId, daysAgo(40));

    const removed = await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90));
    expect(removed).toBeGreaterThan(10);

    // Every table in the database carrying a business_id, scanned. A missed
    // table would leave a deleted merchant's records behind, which is the one
    // outcome this whole schedule exists to prevent.
    const tables = await workerDb.execute<{ table_name: string }>(sql`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name = 'business_id'
        /* Two tables outlive their tenant on purpose: the receipt proving
         * the deletion happened, and the queue of objects the deletion
         * promised to remove from R2 (PR-136). Both are asserted on
         * positively below rather than merely skipped here. */
        AND c.table_name NOT IN ('retention_deletions', 'pending_object_deletions')
      ORDER BY 1
    `);

    const leftovers: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await workerDb.execute<{ n: number }>(
        sql.raw(
          `SELECT count(*)::int AS n FROM "${table}" WHERE business_id = '${businessId}'::uuid`,
        ),
      );
      if (Number([...rows][0]?.n ?? 0) > 0) leftovers.push(table);
    }
    expect(leftovers).toEqual([]);

    // And the proof survives the tenant.
    const record = (await retentionRepo.deletions(workerDb)).find(
      (row) => row.businessId === businessId,
    );
    expect(record?.reason).toBe('abandoned_trial');
    expect(record?.rowsDeleted).toBe(removed);
  });

  it('takes the objects with it: every storage key is queued for deletion', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));

    /* One of each kind of thing Rekoda puts in the object store: a rendered
     * document, a product photo, and the picture somebody sent of a bank
     * transfer. All three are a KEY in a row and BYTES in R2 (ADR 0006), so
     * all three would survive the deletion of the row without this. */
    await withBusiness(appDb, businessId, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId,
        kind: 'receipt_pdf',
        storageKey: `documents/${businessId}/receipt_pdf/deadbeef.pdf`,
        refNumber: 'RCT-2026-000001',
        bytes: 9,
      }),
    );

    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO products (business_id, name, unit_price_k, image_key)
        VALUES (${businessId}::uuid, 'wig', 150000, ${`products/${businessId}/photo.jpg`})
      `),
    );
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO payment_evidence
          (business_id, source, media_ref, media_mime_type)
        VALUES (${businessId}::uuid, 'chat',
                ${`evidence/${businessId}/shot.png`}, 'image/png')
      `),
    );

    expect(
      await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)),
    ).toBeGreaterThan(0);

    /* The rows are gone - the scan above proves that for every table. What
     * has to remain is the QUEUE: it is now the only thing in the estate
     * that knows these keys, and the drain reads it after the fact. */
    const queued = await workerDb.execute<{ storage_key: string; reason: string }>(sql`
      SELECT storage_key, reason FROM pending_object_deletions
       WHERE business_id = ${businessId}::uuid ORDER BY storage_key
    `);
    expect([...queued].map((row) => row.storage_key)).toEqual([
      `documents/${businessId}/receipt_pdf/deadbeef.pdf`,
      `evidence/${businessId}/shot.png`,
      `products/${businessId}/photo.jpg`,
    ]);
    expect([...queued].every((row) => row.reason === 'business_deleted')).toBe(true);
  });

  it('running the deletion twice does not queue an object twice', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));
    await withBusiness(appDb, businessId, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId,
        kind: 'receipt_pdf',
        storageKey: `documents/${businessId}/receipt_pdf/cafe.pdf`,
        refNumber: 'RCT-2026-000002',
        bytes: 9,
      }),
    );

    await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90));
    /* The second call refuses - the business is gone - and must not disturb
     * what the first one promised. */
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);

    const rows = await workerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pending_object_deletions WHERE business_id = ${businessId}::uuid`,
    );
    expect(Number([...rows][0]?.n)).toBe(1);
  });

  it('takes the owner with it, but not an owner who runs something else', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));

    const owner = await workerDb.execute<{ owner_user_id: string }>(sql`
      SELECT owner_user_id FROM businesses WHERE id = ${businessId}::uuid
    `);
    const ownerId = [...owner][0]?.owner_user_id;

    // A second business for a DIFFERENT owner, which must survive untouched.
    const survivor = await abandonedTrial(2);

    await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90));

    const users = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE id = ${ownerId}::uuid
    `);
    expect(Number([...users][0]?.n)).toBe(0);

    const others = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM businesses WHERE id = ${survivor}::uuid
    `);
    expect(Number([...others][0]?.n)).toBe(1);
  });

  it('is idempotent: the same business twice deletes once', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));

    expect(
      await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)),
    ).toBeGreaterThan(0);
    // The row is gone, so the predicate cannot match and nothing happens.
    expect(await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90))).toBe(-1);
    expect(await retentionRepo.deletions(workerDb)).toHaveLength(1);
  });

  it('is not something the APPLICATION role may execute', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));

    // The worker may call it; the API's credential may not call it at all.
    // That is the difference between "the sweep can delete" and "a request
    // handler can delete".
    await expect(
      appDb.execute(
        sql`SELECT retention_delete_business(${businessId}::uuid, now() - interval '90 days')`,
      ),
    ).rejects.toThrow();
  });

  /**
   * The tenant boundary on USERS (launch remediation R9, migration 0118).
   *
   * The original function ended with a global "delete users with no
   * memberships" sweep — tidy-looking, and a tenant-boundary violation: a
   * retention run for one business could delete a completely unrelated
   * person who happened to be between phone verification and creating
   * their first business. The corrected function may only ever evaluate
   * the users the TARGET business brought to the run.
   */
  it('NEVER deletes an unrelated user who merely has no membership yet (R9)', async () => {
    const businessId = await abandonedTrial(120);
    await warn(businessId, daysAgo(40));

    /* Somebody mid-onboarding: phone verified, user row created, no
     * business yet. The exact person the global sweep used to delete. */
    const onboarding = await identity.upsertUserByPhone(appDb, '+2348169999901');

    expect(
      await retentionRepo.deleteForRetention(workerDb, businessId, daysAgo(90)),
    ).toBeGreaterThan(0);

    const rows = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE id = ${onboarding.id}::uuid
    `);
    expect(Number([...rows][0]?.n)).toBe(1);
  });

  it('keeps an owner whose OTHER business still trades (R9)', async () => {
    const doomed = await abandonedTrial(120);
    await warn(doomed, daysAgo(40));
    const owner = await workerDb.execute<{ owner_user_id: string }>(sql`
      SELECT owner_user_id FROM businesses WHERE id = ${doomed}::uuid
    `);
    const ownerId = [...owner][0]!.owner_user_id;

    // The same person runs a second, living business.
    const second = await identity.createBusinessWithOwner(appDb, {
      name: 'Second Shop',
      businessType: null,
      ownerUserId: ownerId,
    });

    await retentionRepo.deleteForRetention(workerDb, doomed, daysAgo(90));

    const user = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE id = ${ownerId}::uuid
    `);
    expect(Number([...user][0]?.n)).toBe(1);
    const shop = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM businesses WHERE id = ${second.id}::uuid
    `);
    expect(Number([...shop][0]?.n)).toBe(1);
  });

  it('cannot touch another business, its owner, or its people (R9)', async () => {
    const doomed = await abandonedTrial(120);
    await warn(doomed, daysAgo(40));
    // A different merchant, mid-trial, completely unrelated.
    const bystander = await abandonedTrial(2);
    const bystanderOwner = await workerDb.execute<{ owner_user_id: string }>(sql`
      SELECT owner_user_id FROM businesses WHERE id = ${bystander}::uuid
    `);
    const bystanderOwnerId = [...bystanderOwner][0]!.owner_user_id;

    await retentionRepo.deleteForRetention(workerDb, doomed, daysAgo(90));

    const shop = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM businesses WHERE id = ${bystander}::uuid
    `);
    expect(Number([...shop][0]?.n)).toBe(1);
    const user = await workerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users WHERE id = ${bystanderOwnerId}::uuid
    `);
    expect(Number([...user][0]?.n)).toBe(1);
  });
});

/** A month of real trading, so the deletion has something to miss. */
async function seedTradingHistory(businessId: string): Promise<void> {
  await withBusiness(appDb, businessId, async (tx) => {
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
      paidK: 4_000_000,
      balanceDueK: 11_000_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-1',
      actor: 'system',
    });

    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK: 5_000_000,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    await settleRepo.bookVerifiedPayment(tx, {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: sale.invoiceId,
        customerId: null,
      },
      confirmedAmountK: 5_000_000,
      currency: 'NGN',
      providerType: 'paystack',
      providerRef: 'pst-r1',
      providerStatus: 'success',
      providerFeeK: 0,
      feePolicy: 'merchant_bearing',
      method: 'transfer',
      actor: 'test',
      eventId: 'evt-1',
    });

    await spendRepo.recordExpense(tx, {
      businessId,
      description: 'fuel for generator',
      category: 'utilities',
      amountK: 1_200_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-2',
    });
    await spendRepo.recordPurchase(tx, {
      businessId,
      description: 'ankara fabric',
      amountK: 5_000_000,
      paidK: 2_000_000,
      sourceType: 'chat',
      sourceId: 'draft-3',
    });

    await usageRepo.consumeUnit(tx, businessId, '2026-08', 'AI_ACTIONS', 50);
    await usageRepo.creditBonus(tx, businessId, '2026-08', 'AI_ACTIONS', 10);
  });
}
