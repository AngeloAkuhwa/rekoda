/**
 * OWN-73: a payment job that dies after an operator already resolved its event binds nothing
 * (settled work: no operator item, no merchant exception behind a closed event), and resolving an
 * event and recording a death on it serialise on the event row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { deadJobsRepo, events, identity, jobsRepo } from '../index.js';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
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

describe('a death that meets an already resolved event', () => {
  it('records the dead job but binds no event, and flags nothing', async () => {
    const { businessId, eventId } = await seed();
    expect(
      await events.resolveEvent(workerDb, eventId, 'settled by hand', 'operator:bob', 'operator'),
    ).toBe(true);
    const job = await jobsRepo.claimNext(workerDb, 'late');
    expect((await jobsRepo.markFailed(workerDb, job!, 'boom', 0)).state).toBe('dead');

    expect((await records(businessId)).map((r) => r.event_id)).toEqual([null]);
    const [event] = await workerDb.execute<{ error: string | null }>(
      sql`SELECT error FROM external_events WHERE id = ${eventId}::uuid`,
    );
    expect(event?.error ?? null).toBeNull();
    expect(await deadJobsRepo.openJobForEvent(workerDb, eventId)).toBeNull();
  });
});

describe('a resolve and a death on the same event serialise on the event row', () => {
  it('whichever takes the row first wins: never an open dead job behind a resolved event', async () => {
    for (let round = 0; round < 8; round++) {
      await truncateAll(urls);
      const { businessId, eventId } = await seed();
      const job = await jobsRepo.claimNext(workerDb, `race-${round}`);
      const [resolved, died] = await Promise.all([
        events.resolveEvent(workerDb, eventId, 'settled by hand', 'operator:bob', 'operator'),
        jobsRepo.markFailed(workerDb, job!, 'boom', 0),
      ]);
      expect(died.state).toBe('dead');
      const eventRow = (
        await workerDb.execute<{ resolved_at: string | null }>(
          sql`SELECT resolved_at FROM external_events WHERE id = ${eventId}::uuid`,
        )
      )[0];
      const bound = (await records(businessId)).filter((r) => r.event_id === eventId);
      if (resolved) {
        // The resolve won: the event is closed and no record is bound to it.
        expect(eventRow?.resolved_at).not.toBeNull();
        expect(bound).toEqual([]);
      } else {
        // The death won: the guard refused the resolve, the event stays open and bound.
        expect(eventRow?.resolved_at).toBeNull();
        expect(bound).toHaveLength(1);
      }
    }
  });
});
