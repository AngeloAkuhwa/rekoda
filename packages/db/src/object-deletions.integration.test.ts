/**
 * The queue of objects promised to the bin (PR-136), against real Postgres.
 *
 * Two things are being pinned, and the second is the reason the table exists
 * at all. First the ordinary mechanics: enqueue once per key, hand out what
 * is due, drop the row when the object is gone, keep it when it is not.
 *
 * Then the property nothing else in the estate has: this row OUTLIVES the
 * business whose object it names. Every other table here is deleted with its
 * tenant; if this one were, the key would go with it and the file would stay
 * in R2 forever with nothing left pointing at it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, objectDeletionsRepo, sql, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481660${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const enqueue = (
  businessId: string,
  keys: string[],
  reason: 'business_deleted' | 'evidence_purged' = 'business_deleted',
) =>
  withBusiness(appDb, businessId, (tx) =>
    objectDeletionsRepo.enqueueObjectDeletions(tx, businessId, keys, reason),
  );

const LATER = new Date(Date.now() + 3_600_000);

describe('promising to delete an object', () => {
  it('queues each key once, however many times it is promised', async () => {
    const ada = await seedBusiness();

    expect(await enqueue(ada, ['documents/a/invoice_pdf/aaa.pdf'])).toBe(1);
    /* A sweep that runs twice over the same rows queues one job, not two:
     * the second delete call would otherwise fail for a key already gone
     * and look like a provider problem forever. */
    expect(await enqueue(ada, ['documents/a/invoice_pdf/aaa.pdf'])).toBe(0);

    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(1);
  });

  it('dedupes within one call, and does nothing with nothing', async () => {
    const ada = await seedBusiness();

    expect(await enqueue(ada, ['k1', 'k1', 'k2', ''])).toBe(2);
    expect(await enqueue(ada, [])).toBe(0);
    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(2);
  });
});

describe('working the queue', () => {
  it('hands out what is due, oldest promise first, up to the limit', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);
    await enqueue(ada, ['k2']);
    await enqueue(ada, ['k3']);

    const due = await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 2);
    expect(due).toHaveLength(2);
    expect(due.every((job) => job.attempts === 0)).toBe(true);
  });

  it('does not hand out a job that is waiting for its next attempt', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);
    const [job] = await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 10);

    await objectDeletionsRepo.objectDeletionFailed(workerDb, job!.id, 'r2 said no', LATER);

    expect(await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 10)).toHaveLength(0);
    /* But it is still owed, which is the number an operator reads. */
    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(1);
  });

  it('a failure counts the attempt and records why, and NEVER drops the job', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);

    for (let i = 0; i < 3; i += 1) {
      const [job] = await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 10);
      expect(job?.attempts).toBe(i);
      await objectDeletionsRepo.objectDeletionFailed(workerDb, job!.id, `refused ${i}`, new Date());
    }

    /* Three refusals and the promise still stands. There is no attempt count
     * at which a deletion we told somebody had happened may be forgotten. */
    const rows = await workerDb.execute<{ attempts: number; last_error: string }>(
      sql`SELECT attempts, last_error FROM pending_object_deletions`,
    );
    const row = [...rows][0];
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toBe('refused 2');
  });

  it('truncates a provider that answers with an essay', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);
    const [job] = await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 10);

    await objectDeletionsRepo.objectDeletionFailed(workerDb, job!.id, 'x'.repeat(5_000), LATER);

    const rows = await workerDb.execute<{ n: number }>(
      sql`SELECT length(last_error)::int AS n FROM pending_object_deletions`,
    );
    expect([...rows][0]?.n).toBe(300);
  });

  it('success takes the row with it: an empty queue is the healthy state', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);
    const [job] = await objectDeletionsRepo.dueObjectDeletions(workerDb, new Date(), 10);

    await objectDeletionsRepo.objectDeleted(workerDb, job!.id);

    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(0);
  });
});

describe('the credentials each half holds', () => {
  it('the application may promise but never perform', async () => {
    const ada = await seedBusiness();
    await enqueue(ada, ['k1']);

    /* Enqueueing happens inside the tenant transaction that orphaned the
     * object; performing happens on the worker, after the object is really
     * gone. Neither role needs the other half, so migration 0122 revokes it.
     * Drizzle wraps the Postgres refusal, so assert the refusal and then
     * that the row is untouched. */
    await expect(
      withBusiness(appDb, ada, (tx) => tx.execute(sql`DELETE FROM pending_object_deletions`)),
    ).rejects.toThrow();
    await expect(
      withBusiness(appDb, ada, (tx) =>
        tx.execute(sql`UPDATE pending_object_deletions SET attempts = 99`),
      ),
    ).rejects.toThrow();

    const rows = await ownerDb.execute<{ attempts: number }>(
      sql`SELECT attempts FROM pending_object_deletions`,
    );
    expect([...rows][0]?.attempts).toBe(0);
  });

  it('the worker may perform but never promise', async () => {
    const ada = await seedBusiness();

    /* A worker inventing a deletion nobody asked for is the one direction
     * that destroys data rather than failing to. */
    await expect(
      workerDb.execute(sql`
        INSERT INTO pending_object_deletions (business_id, storage_key, reason)
        VALUES (${ada}::uuid, 'invented', 'business_deleted')
      `),
    ).rejects.toThrow();

    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(0);
  });

  it('the application sees only its own tenant, and the worker sees all (R11)', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    await enqueue(ada, ['ada-key']);
    await enqueue(bola, ['bola-key']);

    /* This table carried business_id with no policy, so the grant alone
     * stood between the application role and every merchant's storage
     * keys. Migration 0124 scopes it.
     *
     * The revoke that looks simpler does not work, which is why the policy
     * is here: `enqueueObjectDeletions` ends in ON CONFLICT (storage_key),
     * and PostgreSQL needs table-level SELECT to infer the arbiter, so
     * taking SELECT away breaks the promise instead of tightening it. Both
     * enqueues above succeeding is that half of the assertion. */
    const adaSees = await withBusiness(appDb, ada, (tx) =>
      tx.execute<{ storage_key: string }>(sql`SELECT storage_key FROM pending_object_deletions`),
    );
    expect([...adaSees].map((row) => row.storage_key)).toEqual(['ada-key']);

    /* And the worker still sees both, which is the capability the sweep
     * depends on: by the time it runs, these businesses are usually gone,
     * so a tenant policy alone would match nothing and the objects would
     * stay in the bucket forever. */
    expect(await objectDeletionsRepo.pendingObjectDeletionCount(workerDb)).toBe(2);
  });
});
