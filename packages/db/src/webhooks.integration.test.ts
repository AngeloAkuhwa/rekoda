/**
 * What the database guarantees about webhooks (PR-112, migration 0111).
 *
 * The behaviour is proven in `apps/api`; these are the properties that hold
 * whichever code path arrives, and each one is a way the feature could
 * otherwise become a hole:
 *
 *   - a plaintext callback cannot be stored at all;
 *   - the merchant cannot write their own delivery log;
 *   - the SENDER cannot edit the endpoint it delivers to — it may record
 *     how the attempt went and nothing else;
 *   - one tenant's endpoints are invisible to another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, webhooksRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let worker: Db;
let close: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
  ({ db: worker, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone: string, name: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedEndpoint(businessId: string, url: string): Promise<string> {
  const endpoint = await withBusiness(db, businessId, (tx) =>
    webhooksRepo.createEndpoint(tx, {
      businessId,
      url,
      description: null,
      eventTypes: [],
      encryptedSecret: 'v2.iv.tag.cipher',
    }),
  );
  return endpoint.id;
}

/** Drizzle wraps the driver's error; the refusal is in the cause. */
async function refusal(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
  );
}

describe('what may be registered', () => {
  it('refuses a plaintext callback in the column itself', async () => {
    const businessId = await seedBusiness('+2348194000001', 'Plain Co');
    const message = await refusal(seedEndpoint(businessId, 'http://plain.test/hook'));
    expect(message).toMatch(/check constraint/i);
  });

  it('takes one endpoint per URL per business, and no second copy', async () => {
    const businessId = await seedBusiness('+2348194000002', 'Once Co');
    await seedEndpoint(businessId, 'https://once.test/hook');
    const message = await refusal(seedEndpoint(businessId, 'https://once.test/hook'));
    expect(message).toMatch(/duplicate key/i);
  });

  it("hides one tenant's endpoints from another", async () => {
    const mine = await seedBusiness('+2348194000003', 'Mine Co');
    const theirs = await seedBusiness('+2348194000004', 'Theirs Co');
    await seedEndpoint(mine, 'https://mine.test/hook');

    const seen = await withBusiness(db, theirs, (tx) => webhooksRepo.endpointsFor(tx, theirs));
    expect(seen).toEqual([]);

    const unpinned = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM webhook_endpoints`,
    );
    expect([...unpinned][0]!.n).toBe(0);
  });
});

describe('who may write what', () => {
  it('refuses the application its own delivery log', async () => {
    const businessId = await seedBusiness('+2348194000010', 'Log Co');
    const endpointId = await seedEndpoint(businessId, 'https://log.test/hook');

    const message = await refusal(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO webhook_deliveries (business_id, endpoint_id, outbox_event_id, event_type)
          VALUES (${businessId}, ${endpointId}, gen_random_uuid(), 'sale.recorded')
        `),
      ),
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('lets the sender record how an attempt went', async () => {
    const businessId = await seedBusiness('+2348194000011', 'Health Co');
    const endpointId = await seedEndpoint(businessId, 'https://health.test/hook');

    await worker.execute(sql`
      UPDATE webhook_endpoints
         SET consecutive_failures = 3, last_success_at = now(), updated_at = now()
       WHERE id = ${endpointId}
    `);

    const rows = await withBusiness(db, businessId, (tx) =>
      webhooksRepo.endpointsFor(tx, businessId),
    );
    expect(rows[0]!.consecutiveFailures).toBe(3);
  });

  it('refuses the sender the URL it delivers to and the secret it signs with', async () => {
    const businessId = await seedBusiness('+2348194000012', 'Sealed Co');
    const endpointId = await seedEndpoint(businessId, 'https://sealed.test/hook');

    for (const statement of [
      sql`UPDATE webhook_endpoints SET url = 'https://attacker.test/hook' WHERE id = ${endpointId}`,
      sql`UPDATE webhook_endpoints SET encrypted_secret = 'v2.a.b.c' WHERE id = ${endpointId}`,
      sql`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ${endpointId}`,
      sql`DELETE FROM webhook_endpoints WHERE id = ${endpointId}`,
    ]) {
      expect(await refusal(worker.execute(statement))).toMatch(/permission denied/i);
    }
  });

  it('refuses everybody the deletion of a delivery record', async () => {
    const businessId = await seedBusiness('+2348194000013', 'Kept Co');
    const endpointId = await seedEndpoint(businessId, 'https://kept.test/hook');
    const event = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO outbox_events (business_id, type) VALUES (${businessId}, 'sale.recorded')
        RETURNING id
      `),
    );
    await withBusiness(worker, businessId, (tx) =>
      webhooksRepo.queueDelivery(tx, {
        businessId,
        endpointId,
        outboxEventId: [...event][0]!.id,
        eventType: 'sale.recorded',
        payload: {},
      }),
    );

    expect(
      await refusal(
        worker.execute(sql`DELETE FROM webhook_deliveries WHERE business_id = ${businessId}`),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await refusal(
        withBusiness(db, businessId, (tx) =>
          tx.execute(sql`DELETE FROM webhook_deliveries WHERE business_id = ${businessId}`),
        ),
      ),
    ).toMatch(/permission denied/i);
  });
});
