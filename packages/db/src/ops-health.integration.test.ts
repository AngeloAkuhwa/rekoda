/**
 * The operational read layer, against a real PostgreSQL.
 *
 * Three claims, none of which survives an in-memory imitation: the stranger
 * claim is a conditional UPSERT whose whole value is what happens when two
 * callers race, `queueHealth` counts across tenants and so depends on which
 * ROLE asks, and `eventHealth` reads a table deliberately outside row-level
 * security.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { events, identity, jobsRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 8 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('claiming the right to answer a stranger', () => {
  it('answers once, then stays quiet for the rest of the window', async () => {
    const key = 'contact-key-one';

    expect(await events.claimStrangerReply(workerDb, key)).toBe(true);
    expect(await events.claimStrangerReply(workerDb, key)).toBe(false);
  });

  it('answers again once the window has passed', async () => {
    const key = 'contact-key-two';
    const monday = new Date('2026-03-02T09:00:00Z');
    const tuesday = new Date('2026-03-03T09:30:00Z');

    expect(await events.claimStrangerReply(workerDb, key, 24 * 3_600_000, monday)).toBe(true);
    expect(await events.claimStrangerReply(workerDb, key, 24 * 3_600_000, tuesday)).toBe(true);
  });

  it('gives the claim to exactly one of eight callers racing', async () => {
    const key = 'contact-key-three';
    const results = await Promise.all(
      Array.from({ length: 8 }, () => events.claimStrangerReply(workerDb, key)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps two strangers independent of each other', async () => {
    expect(await events.claimStrangerReply(workerDb, 'ada')).toBe(true);
    expect(await events.claimStrangerReply(workerDb, 'chidi')).toBe(true);
  });
});

describe('queue health', () => {
  it('counts across every tenant, on the worker credential', async () => {
    const ada = await seedBusiness('+2348030000001');
    const chidi = await seedBusiness('+2348030000002');

    await withBusiness(appDb, ada, (tx) =>
      jobsRepo.enqueue(tx, { businessId: ada, kind: 'inbound.message' }),
    );
    await withBusiness(appDb, chidi, (tx) =>
      jobsRepo.enqueue(tx, { businessId: chidi, kind: 'inbound.message' }),
    );

    const health = await jobsRepo.queueHealth(workerDb);

    expect(health.pending).toBe(2);
    expect(health.dead).toBe(0);
    expect(health.running).toBe(0);
  });

  it('reports how long the oldest waiting job has waited', async () => {
    const ada = await seedBusiness('+2348030000003');
    await withBusiness(appDb, ada, (tx) =>
      jobsRepo.enqueue(tx, { businessId: ada, kind: 'inbound.message' }),
    );
    await workerDb.execute(sql`UPDATE jobs SET run_at = now() - interval '10 minutes'`);

    const health = await jobsRepo.queueHealth(workerDb);

    expect(health.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
  });

  it('never reports a negative wait for a job scheduled into the future', async () => {
    const ada = await seedBusiness('+2348030000004');
    await withBusiness(appDb, ada, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: ada,
        kind: 'inbound.message',
        delayMs: 3_600_000,
      }),
    );

    const health = await jobsRepo.queueHealth(workerDb);

    expect(health.oldestPendingSeconds).toBe(0);
  });

  it('is all zeros on an empty queue rather than throwing', async () => {
    expect(await jobsRepo.queueHealth(workerDb)).toEqual({
      dead: 0,
      pending: 0,
      running: 0,
      oldestPendingSeconds: 0,
    });
  });
});

describe('event health', () => {
  it('separates unprocessed from flagged, per provider', async () => {
    const waiting = await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.waiting',
      payload: { sealed: true },
      businessId: null,
    });
    const flagged = await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.flagged',
      payload: { sealed: true },
      businessId: null,
    });
    await events.recordEvent(workerDb, {
      provider: 'paystack',
      eventType: 'charge.success',
      externalId: 'evt.other',
      payload: { sealed: true },
      businessId: null,
    });

    await events.markProcessed(workerDb, flagged.id, 'unknown_reference');

    const meta = await events.eventHealth(workerDb, 'meta');
    expect(meta.unprocessed).toBe(1);
    expect(meta.flagged).toBe(1);
    expect(meta.badSignatures).toBe(0);
    expect(waiting.isNew).toBe(true);

    const paystack = await events.eventHealth(workerDb, 'paystack');
    expect(paystack.unprocessed).toBe(1);
    expect(paystack.flagged).toBe(0);
  });

  it('does not count a clean processed event as flagged', async () => {
    const clean = await events.recordEvent(workerDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.clean',
      payload: { sealed: true },
      businessId: null,
    });
    await events.markProcessed(workerDb, clean.id);

    const health = await events.eventHealth(workerDb, 'meta');

    expect(health).toEqual({ unprocessed: 0, flagged: 0, badSignatures: 0 });
  });
});
