/**
 * OWN-73: a payment job that dies after an operator already resolved its event binds nothing to
 * that event (the closed event is not flagged and no record points at it; the record and merchant
 * exception are still written, unbound, as OWN-73 requires), and resolving an event and recording
 * a death on it serialise on the event row, proved here with a held lock in both orders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { deadJobsRepo, events, identity, jobsRepo, settleRepo } from '../index.js';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
/** The owner sees every session's wait state; a runtime role sees only its own role's (0204 moved the
 * resolve onto the application credential, so the two sides are different roles). */
let ownerDb: Db;

/** The operator's generic resolve: found on the worker credential, written on the application
 * credential under the event's own business (migration 0204). True when it resolved. */
const operatorResolve = (id: string, resolution: string, actor: string): Promise<boolean> =>
  events
    .resolveExceptionAsOperator(appDb, workerDb, id, resolution, actor)
    .then((outcome) => outcome === 'resolved');
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 6 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const c of closers) await c();
});
beforeEach(async () => {
  await truncateAll(urls);
});

async function seed() {
  const user = await identity.upsertUserByPhone(appDb, '+2348130009911');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: 'late-1:charge.success',
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const eventId = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, eventId, business.id)).toBe(true);
  await withBusiness(appDb, business.id, (tx) =>
    jobsRepo.enqueue(tx, {
      businessId: business.id,
      kind: 'payment.process',
      payload: { eventId },
      maxAttempts: 1,
    }),
  );
  return { businessId: business.id, eventId };
}

const records = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ event_id: string | null }>(sql`SELECT event_id FROM dead_job_exceptions`),
  ).then((rows) => [...rows]);

const reconciliationsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ reason: string }>(
      sql`SELECT reason FROM reconciliations WHERE status = 'EXCEPTION'`,
    ),
  ).then((rows) => [...rows]);

/** Wait until some session is blocked on a lock (the other side of a held-lock interleaving). */
async function untilALockWaitExists(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const waiting = await ownerDb.execute(
      sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if ([...waiting].length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('nothing ever waited on a lock: the two sides are not serialising');
}

describe('a death that meets an already resolved event', () => {
  it('still records the dead job and its merchant exception, but binds no event and flags nothing', async () => {
    const { businessId, eventId } = await seed();
    expect(await operatorResolve(eventId, 'settled by hand', 'operator:bob')).toBe(true);
    const job = await jobsRepo.claimNext(workerDb, 'late');
    expect((await jobsRepo.markFailed(workerDb, job!, 'boom', 0)).state).toBe('dead');

    // The record exists (every dead job leaves one) and is not bound to the closed event.
    expect((await records(businessId)).map((r) => r.event_id)).toEqual([null]);
    expect((await reconciliationsOf(businessId)).map((r) => r.reason)).toEqual([
      'payment_processing_stopped',
    ]);
    const [event] = await workerDb.execute<{ error: string | null }>(
      sql`SELECT error FROM external_events WHERE id = ${eventId}::uuid`,
    );
    expect(event?.error ?? null).toBeNull();
    expect(await deadJobsRepo.openJobForEvent(workerDb, eventId)).toBeNull();

    // Both OWN-73 notices exist: the operator queue item (unbound) and the merchant exception.
    const queue = await deadJobsRepo.opsQueue(workerDb);
    expect(queue.map((r) => [r.businessId, r.eventId])).toEqual([[businessId, null]]);
    const exceptions = await withBusiness(appDb, businessId, (tx) =>
      settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 50 }),
    );
    expect(exceptions).toHaveLength(1);
  });
});

describe('a resolve and a death on the same event serialise on the event row', () => {
  it('a death already holding the event: the resolve waits, then is refused by its guard', async () => {
    const { businessId, eventId } = await seed();
    const job = await jobsRepo.claimNext(workerDb, 'death-first');
    let resolve: Promise<boolean> | undefined;
    await workerDb.transaction(async (tx) => {
      // The death's own first steps, left uncommitted: pin, lock the event, write the record.
      await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
      await tx.execute(sql`SELECT 1 FROM external_events WHERE id = ${eventId}::uuid FOR UPDATE`);
      await tx.execute(sql`
        INSERT INTO dead_job_exceptions (job_id, business_id, kind, event_id, summary, attempts)
        VALUES (${job!.id}::uuid, ${businessId}::uuid, 'payment.process', ${eventId}::uuid, 'fixed', 1)`);
      resolve = operatorResolve(eventId, 'settled by hand', 'operator:bob');
      await untilALockWaitExists(); // the resolve is now blocked behind the death
    });
    expect(await resolve).toBe(false); // it saw the record the death committed
    const [row] = await workerDb.execute<{ resolved_at: string | null }>(
      sql`SELECT resolved_at FROM external_events WHERE id = ${eventId}::uuid`,
    );
    expect(row?.resolved_at).toBeNull();
  });

  it('a resolve already holding the event: the death waits, then binds nothing to it', async () => {
    const { businessId, eventId } = await seed();
    const job = await jobsRepo.claimNext(workerDb, 'resolve-first');
    let death: ReturnType<typeof jobsRepo.markFailed> | undefined;
    await appDb.transaction(async (tx) => {
      // The resolve's write (application credential, pinned to the event's business, 0204), left
      // uncommitted: it holds the event row.
      await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
      await tx.execute(sql`
        UPDATE external_events SET resolved_at = now(), resolved_by = 'operator:bob',
               resolution = 'settled by hand', processed_at = COALESCE(processed_at, now())
        WHERE id = ${eventId}::uuid`);
      death = jobsRepo.markFailed(workerDb, job!, 'boom', 0);
      await untilALockWaitExists(); // the death is now blocked behind the resolve
    });
    expect((await death)!.state).toBe('dead');
    expect((await records(businessId)).map((r) => r.event_id)).toEqual([null]);
  });
});
