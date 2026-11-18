/**
 * A catalogue order's refusal gives its units back one at a time (closeout round G of PR #432,
 * owner instruction of 18 Nov 2026, §4.5: the connection budget).
 *
 * A worker's application pool is max(10, lanes + 2) (`appPoolSize`), which is free of a circular
 * wait only while each lane holds at most two connections: its runner transaction and one more.
 * The customer-message handler's `settle()` gave back the order unit and the document unit with
 * `Promise.allSettled`, two transactions open at once under the runner's: three connections per
 * lane, enough for ten lanes to hold every connection of a pool of twelve while each waits for
 * another. The give-backs now run one after the other, each still attempted whatever the other
 * did. The path below is the one in meta-catalogue-order-1 ("gives back both units when the vault
 * fails resolving the buyer"): both units reserved, then a terminal failure settles them.
 */
import { describe, expect, it } from 'vitest';
import { createDb, usageRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  orderPayload,
  post,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { seedCommerceMerchant, ordersOf } from './meta-catalogue-order.fixtures.js';
import { probePool } from '../db/pool-probe.fixtures.js';

useMetaWebhookHarness();

describe('a catalogue order refused after both units were reserved (pool budget)', () => {
  it('holds at most two application connections at once, and still gives both units back', async () => {
    const { businessId, wigId } = await seedCommerceMerchant('+2348030002291', 'PN-POOL-1');
    const period = usagePeriod(new Date());
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    const probe = probePool(db);
    try {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION pool_buyer_fails() RETURNS trigger AS $$
        BEGIN
          IF NEW.facet = 'phone' THEN RAISE EXCEPTION 'pool: the vault is unavailable'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER pool_buyer_fails BEFORE INSERT ON customer_identities
          FOR EACH ROW EXECUTE FUNCTION pool_buyer_fails()`);
      await post(
        orderPayload('2349097776291', 'wamid.POOL.1', 'PN-POOL-1', [
          { retailerId: wigId, quantity: 1 },
        ]),
      );
      /* The runner and the handler on the probed pool, as `buildRunner` wires them in the worker. */
      const runner = buildRunner(workerDb, probe.db, { ...deps });
      let failed = 0;
      for (let pass = 0; pass < 20 && failed === 0; pass++) {
        await runner.runOnce();
        const [row] = [
          ...(await ownerDb.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM jobs WHERE business_id = ${businessId}::uuid
               AND last_error LIKE '%the vault is unavailable%'`)),
        ];
        failed = Number(row?.n);
      }
      expect(failed).toBe(1); // the refusal path ran, so the measurement is not vacuous
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS pool_buyer_fails ON customer_identities`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS pool_buyer_fails()`);
      await close();
    }
    /* The runner's transaction plus one: never two give-backs open at once. */
    expect(probe.highWater()).toBe(2);
    expect([...(await ordersOf(businessId))]).toHaveLength(0);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });
});
