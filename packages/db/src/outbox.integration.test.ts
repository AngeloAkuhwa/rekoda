/**
 * The transactional outbox against real PostgreSQL (spec §26; PR-020).
 *
 * One property carries the whole pattern: an outbox event and its state
 * change commit or roll back together. The rest is dispatcher bookkeeping —
 * once each, in order, retried on failure, visibly dead at the ceiling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, outboxRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let app: Db;
let worker: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: app, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: worker, close: closeWorker } = createDb(urls.worker, { max: 6 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23482300${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('one commit, both or neither', () => {
  it('keeps the event when the state change commits', async () => {
    const businessId = await seedBusiness();
    await withBusiness(app, businessId, async (tx) => {
      await tx.execute(
        sql`UPDATE businesses SET name = 'Ada Fashion & Sons' WHERE id = ${businessId}::uuid`,
      );
      await outboxRepo.append(tx, {
        businessId,
        type: 'BusinessRenamed',
        payload: { to: 'Ada Fashion & Sons' },
      });
    });
    expect(await outboxRepo.claimBatch(worker)).toHaveLength(1);
  });

  /**
   * The sentence the pattern exists for. A state change that fails after
   * announcing itself leaves NO event, so nothing downstream ever hears
   * about a sale that did not happen.
   */
  it('loses the event when the state change rolls back', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(app, businessId, async (tx) => {
        await outboxRepo.append(tx, { businessId, type: 'SaleRecorded', payload: {} });
        throw new Error('the sale failed after announcing itself');
      }),
    ).rejects.toThrow();
    expect(await outboxRepo.claimBatch(worker)).toHaveLength(0);
  });
});

describe('dispatching', () => {
  it('delivers in arrival order and never re-claims the dispatched', async () => {
    const businessId = await seedBusiness();
    for (const type of ['First', 'Second', 'Third']) {
      await withBusiness(app, businessId, (tx) => outboxRepo.append(tx, { businessId, type }));
    }

    const batch = await outboxRepo.claimBatch(worker);
    expect(batch.map((event) => event.type)).toEqual(['First', 'Second', 'Third']);

    await outboxRepo.markDispatched(worker, batch[0]!.id);
    await outboxRepo.markFailed(worker, batch[1]!.id, 'downstream refused');
    /* Third stays leased; a fresh claim sees only the released failure. */
    const again = await outboxRepo.claimBatch(worker);
    expect(again.map((event) => event.type)).toEqual(['Second']);
    expect(again[0]?.attempts).toBe(1);
  });

  /**
   * Two dispatchers, one table, zero double deliveries. SKIP LOCKED makes
   * one worker's batch invisible to the other, which is the same guarantee
   * the job queue gives and for the same reason.
   */
  it('never hands one event to two dispatchers', async () => {
    const businessId = await seedBusiness();
    for (let i = 0; i < 10; i += 1) {
      await withBusiness(app, businessId, (tx) =>
        outboxRepo.append(tx, { businessId, type: `E${i}` }),
      );
    }
    const [a, b] = await Promise.all([
      outboxRepo.claimBatch(worker, 10),
      outboxRepo.claimBatch(worker, 10),
    ]);
    const ids = [...a, ...b].map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });

  it('stops claiming an event that ran out of attempts, and shows it dead', async () => {
    const businessId = await seedBusiness();
    await withBusiness(app, businessId, (tx) =>
      outboxRepo.append(tx, { businessId, type: 'Poisoned' }),
    );
    for (let i = 0; i < 8; i += 1) {
      const [event] = await outboxRepo.claimBatch(worker);
      expect(event).toBeDefined();
      await outboxRepo.markFailed(worker, event!.id, `attempt ${i + 1} refused`);
    }
    expect(await outboxRepo.claimBatch(worker)).toHaveLength(0);

    const dead = await outboxRepo.deadEvents(worker);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.type).toBe('Poisoned');
    expect(dead[0]?.attempts).toBe(8);
  });

  it("returns a crashed dispatcher's leases to the table", async () => {
    const businessId = await seedBusiness();
    await withBusiness(app, businessId, (tx) =>
      outboxRepo.append(tx, { businessId, type: 'Orphaned' }),
    );
    const [event] = await outboxRepo.claimBatch(worker);
    expect(event).toBeDefined();
    /* The dispatcher dies here. Nothing marks the event either way. */
    expect(await outboxRepo.claimBatch(worker)).toHaveLength(0);

    /* Age the lease past the stall window, as time would. */
    await worker.execute(sql`UPDATE outbox_events SET locked_at = now() - interval '10 minutes'`);
    expect(await outboxRepo.reclaimStalled(worker)).toBe(1);
    expect(await outboxRepo.claimBatch(worker)).toHaveLength(1);
  });
});

describe('who may touch it', () => {
  it("keeps one tenant's events invisible to another", async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    await withBusiness(app, mine, (tx) =>
      outboxRepo.append(tx, { businessId: mine, type: 'Private' }),
    );
    const seen = await withBusiness(app, theirs, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events`),
    );
    expect([...seen][0]?.n).toBe(0);
  });

  /* The application appends; it never rewrites or erases what happened. */
  it('refuses the application UPDATE and DELETE', async () => {
    const businessId = await seedBusiness();
    await withBusiness(app, businessId, (tx) =>
      outboxRepo.append(tx, { businessId, type: 'Immutable' }),
    );
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`UPDATE outbox_events SET type = 'Rewritten'`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(app, businessId, (tx) => tx.execute(sql`DELETE FROM outbox_events`)),
    ).rejects.toThrow();
  });
});
