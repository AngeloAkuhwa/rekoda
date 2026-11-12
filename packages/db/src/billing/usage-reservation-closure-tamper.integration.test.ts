/**
 * OD-52 (migration 0220; reopened by the independent security review of `4d5f1cd..5654ee2`): the
 * application credential cannot keep a delivered unit refundable by tampering with the job row the
 * 0218 closure keys on.
 *
 * The three vectors the review named, each run as `rekoda_app` on a live connection:
 *   1. an `eventId` written in a form PostgreSQL casts to the same uuid but the trigger's pattern
 *      did not match (hyphenless, braced, upper case), so the finished job closed nothing;
 *   2. the `eventId` removed from, or changed in, the payload while the job runs;
 *   3. the job deleted, or moved away from `running`, before it is marked done.
 * And the honest transitions the application makes still work: running to done (the handler's
 * last step) and dead to pending (an operator's recovery).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { events, jobsRepo, usageRepo } from '../index.js';
import {
  appDb,
  workerDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const PERIOD = '2026-11';
const UNIT: usageRepo.UsageUnit = 'AI_ACTIONS';

async function storedEvent(businessId: string): Promise<string> {
  const recorded = await withBusiness(appDb, businessId, (tx) =>
    events.recordEvent(tx, {
      provider: 'meta',
      eventType: 'message',
      externalId: `wamid.${randomUUID()}`,
      payload: { sealed: 'opaque' },
      businessId,
    }),
  );
  if (!recorded.isNew) throw new Error('the event was not stored');
  return recorded.id;
}

/** A job for the event, enqueued by the application with whatever text it chooses for the id. */
async function jobFor(businessId: string, eventIdText: string): Promise<string> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload)
      VALUES (${businessId}::uuid, 'message.inbound', jsonb_build_object('eventId', ${eventIdText}::text))
      RETURNING id`),
  );
  const id = [...rows][0]!.id;
  /* Claimed, as the worker would claim it. */
  await withBusiness(ownerDb, businessId, (tx) =>
    tx.execute(sql`UPDATE jobs SET state = 'running', locked_by = 'w:1', locked_at = now()
                   WHERE id = ${id}::uuid`),
  );
  return id;
}

const spendFor = (businessId: string, eventId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const spent = await usageRepo.reserveUnit(tx, businessId, PERIOD, UNIT, 10);
    await events.noteReservedUnit(tx, businessId, eventId, UNIT, spent.meter);
    return spent.meter;
  });
const closed = async (meter: usageRepo.MeterRow) =>
  [
    ...(await ownerDb.execute<{ closed: boolean }>(
      sql`SELECT closed_at IS NOT NULL AS closed FROM usage_reservations
          WHERE id = ${usageRepo.reservationOf(meter)}::uuid`,
    )),
  ][0]!.closed;
const refund = (businessId: string, meter: usageRepo.MeterRow) =>
  withBusiness(appDb, businessId, (tx) => usageRepo.refundUnit(tx, businessId, meter, UNIT));
const asApp = (db: Db, businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)));

describe('vector 1: any spelling of the event id closes the reservation (0220)', () => {
  it.each([
    ['hyphenless', (id: string) => id.replaceAll('-', '')],
    ['braced', (id: string) => `{${id}}`],
    ['upper case', (id: string) => id.toUpperCase()],
  ])('a job whose eventId is %s still closes what its event reserved', async (_label, spell) => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const jobId = await jobFor(businessId, spell(eventId));
    const meter = await spendFor(businessId, eventId);

    await withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, jobId));

    expect(await closed(meter)).toBe(true);
    expect(await refund(businessId, meter)).toBe(0);
  });

  it('an eventId that is not a uuid at all closes nothing and breaks nothing', async () => {
    const businessId = await seedBusiness();
    const jobId = await jobFor(businessId, 'not-a-uuid');
    expect(
      await asApp(appDb, businessId, sql`UPDATE jobs SET state = 'done' WHERE id = ${jobId}::uuid`),
    ).toBe('allowed');
  });
});

describe('vectors 2 and 3: the application cannot rewrite, remove or park a job (0220)', () => {
  it('cannot change or remove the payload, the kind or the business of a job', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const jobId = await jobFor(businessId, eventId);
    for (const statement of [
      sql`UPDATE jobs SET payload = payload - 'eventId' WHERE id = ${jobId}::uuid`,
      sql`UPDATE jobs SET payload = jsonb_build_object('eventId', ${randomUUID()}::text) WHERE id = ${jobId}::uuid`,
      sql`UPDATE jobs SET kind = 'deploy.smoke.probe' WHERE id = ${jobId}::uuid`,
      sql`UPDATE jobs SET business_id = business_id WHERE id = ${jobId}::uuid`,
    ]) {
      expect(await asApp(appDb, businessId, statement)).toMatch(/permission denied/);
    }
  });

  it('cannot delete a job', async () => {
    const businessId = await seedBusiness();
    const jobId = await jobFor(businessId, await storedEvent(businessId));
    expect(await asApp(appDb, businessId, sql`DELETE FROM jobs WHERE id = ${jobId}::uuid`)).toMatch(
      /permission denied/,
    );
  });

  it('cannot move a running job anywhere but done, so the reservation is closed when it finishes', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const jobId = await jobFor(businessId, eventId);
    const meter = await spendFor(businessId, eventId);
    for (const state of ['pending', 'dead']) {
      expect(
        await asApp(
          appDb,
          businessId,
          sql`UPDATE jobs SET state = ${state} WHERE id = ${jobId}::uuid`,
        ),
        state,
      ).toMatch(/a job's state moves only/);
    }
    expect(await closed(meter)).toBe(false);

    await withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, jobId, 'w:1'));
    expect(await closed(meter)).toBe(true);
    /* And a finished job cannot be reopened by the application either. */
    expect(
      await asApp(
        appDb,
        businessId,
        sql`UPDATE jobs SET state = 'running' WHERE id = ${jobId}::uuid`,
      ),
    ).toMatch(/a job's state moves only/);
  });

  it('still requeues a dead job for an operator’s recovery, and enqueues new work', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const jobId = await jobFor(businessId, eventId);
    await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET state = 'dead', locked_by = NULL, locked_at = NULL
                     WHERE id = ${jobId}::uuid`),
    );
    expect(
      await asApp(
        appDb,
        businessId,
        sql`UPDATE jobs SET state = 'pending', max_attempts = attempts + 1, run_at = now(),
              locked_at = NULL, locked_by = NULL, updated_at = now()
            WHERE id = ${jobId}::uuid`,
      ),
    ).toBe('allowed');
    expect(await jobFor(businessId, eventId)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the closure does not depend on the session pin (0221)', () => {
  it('a job marked done with no tenant pinned still closes its event’s reservations', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const jobId = await jobFor(businessId, eventId);
    const meter = await spendFor(businessId, eventId);

    /* The worker, with nothing pinned, finishes the job (as a future worker-side path might). */
    await workerDb.transaction((tx) =>
      tx.execute(sql`UPDATE jobs SET state = 'done' WHERE id = ${jobId}::uuid`),
    );

    expect(await closed(meter)).toBe(true);
    expect(await refund(businessId, meter)).toBe(0);
  });
});
