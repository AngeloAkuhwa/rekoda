/**
 * Shared helpers for the meta-catalogue-order suites, split from meta.integration.test.ts.
 * The helpers that hold state or write the plan stay in each suite.
 */
import { createDb, identity, catalogueRepo, wabaRepo, withBusiness, sql } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { db, deps, urls, workerDb } from './meta-webhook.fixtures.js';

export async function seedCommerceMerchant(phone: string, phoneNumberId: string) {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await withBusiness(db, business.id, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId: business.id,
      wabaId: `waba-${phoneNumberId}`,
      phoneNumberId,
      accessTokenCipher: 'cipher-for-tests',
      tokenTail: '4821',
    }),
  );
  const wig = await withBusiness(db, business.id, (tx) =>
    catalogueRepo.createProduct(tx, business.id, { name: 'wig', unitPriceK: 150_000 }),
  );
  return { businessId: business.id, wigId: wig.id };
}

export const ordersOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{
      order_number: string;
      status: string;
      total_k: string;
      external_ref: string | null;
      customer_id: string | null;
      invoice_id: string | null;
    }>(sql`
        SELECT order_number, status, total_k::bigint AS total_k, external_ref,
               customer_id, invoice_id
        FROM orders WHERE business_id = ${businessId}::uuid
      `),
  );

/** Run the queue until a job has failed with `reason`, so the test is never vacuous. */
export async function runUntilFailed(businessId: string, reason: string): Promise<number> {
  const runner = buildRunner(workerDb, db, deps);
  const { db: jobsDb, close: closeJobs } = createDb(urls.owner, { max: 1 });
  try {
    for (let pass = 0; pass < 20; pass++) {
      const [row] = [
        ...(await jobsDb.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM jobs WHERE business_id = ${businessId}::uuid
               AND last_error LIKE ${`%${reason}%`}`)),
      ];
      if (Number(row?.n) > 0) return Number(row?.n);
      await runner.runOnce();
    }
    return 0;
  } finally {
    await closeJobs();
  }
}
