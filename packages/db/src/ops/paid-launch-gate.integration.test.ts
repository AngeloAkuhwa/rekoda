/**
 * OWN-92 paid-launch security gate (migration 0227): two things a holder of the application
 * credential could still do at 0226, each refused by the database.
 *
 *   (a) Qodo 12: reschedule queued work without changing its state. The 0223 guard checked a
 *       same-state update only for its lease, so the application could push a pending
 *       `payment.process` job's `run_at` out, or cut its retry budget, and so delay or suppress a
 *       verified customer payment. It could also INSERT a non-settlement job already `running`.
 *   (b) Qodo 11: bind a usage reservation to an event that does not exist, or to another
 *       business's, or to one whose job is not running. A bound reservation is refundable for 45
 *       days from its creation, not the 15 minutes of an unbound one, and only the event's job
 *       finishing closes it, so a forged binding kept a spent unit refundable for 45 days.
 *
 * Every attack runs on a live `rekoda_app` (or `rekoda_worker`) connection; the owner only
 * arranges state and reads it back.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { usagePeriod, type UsageUnit } from '@rekoda/core';
import { withBusiness, type Db } from '../client.js';
import { events, jobsRepo, usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
  workerDb,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

const UNIT: UsageUnit = 'AI_ACTIONS';
const TRIAL_AI = 50;
const MONTH = () => usagePeriod(new Date());

async function pendingJob(businessId: string, kind = 'payment.process'): Promise<string> {
  const row = await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload: { eventId: randomUUID() } }),
  );
  return row!.id;
}
const jobRow = async (id: string) =>
  [
    ...(await ownerDb.execute<{
      run_at: string;
      max_attempts: number;
      attempts: number;
      state: string;
    }>(sql`SELECT run_at::text, max_attempts, attempts, state FROM jobs WHERE id = ${id}::uuid`)),
  ][0]!;
const asApp = (businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)));

describe('0227 (a): the application cannot reschedule queued work', () => {
  it('ATTACK: pushing a pending payment job out, or cutting its budget, is refused', async () => {
    const businessId = await seedBusiness();
    const job = await pendingJob(businessId);
    const before = await jobRow(job);
    for (const change of [
      sql`run_at = now() + interval '30 days'`,
      sql`max_attempts = 1`,
      sql`max_attempts = 1000`,
      sql`attempts = attempts + 5`,
      sql`run_at = now() + interval '1 hour', max_attempts = 2`,
    ]) {
      expect(
        await asApp(businessId, sql`UPDATE jobs SET ${change} WHERE id = ${job}::uuid`),
      ).toMatch(/^42501 /);
    }
    expect(await jobRow(job)).toEqual(before);
  });

  it('ATTACK: a bulk same-state update of every pending job is refused as a whole', async () => {
    const businessId = await seedBusiness();
    const one = await pendingJob(businessId);
    const two = await pendingJob(businessId, 'inbound.message');
    const before = [await jobRow(one), await jobRow(two)];
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET run_at = now() + interval '7 days' WHERE state = 'pending'`,
      ),
    ).toMatch(/^42501 /);
    expect([await jobRow(one), await jobRow(two)]).toEqual(before);
  });

  it('ATTACK: completing a running job while moving its schedule is refused', async () => {
    const businessId = await seedBusiness();
    const job = await pendingJob(businessId);
    const claimed = await jobsRepo.claimNext(workerDb, 'gate-test');
    expect(claimed?.id).toBe(job);
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'done', locked_at = NULL, locked_by = NULL,
                            max_attempts = 99 WHERE id = ${job}::uuid`,
      ),
    ).toMatch(/^42501 /);
  });

  it('ATTACK: inserting a job already running, leased or with attempts spent is refused', async () => {
    const businessId = await seedBusiness();
    for (const extra of [
      sql`'running', now(), 'forged', 0`,
      sql`'pending', NULL, 'forged', 0`,
      sql`'pending', NULL, NULL, 3`,
      sql`'done', NULL, NULL, 0`,
    ]) {
      expect(
        await asApp(
          businessId,
          sql`INSERT INTO jobs (business_id, kind, payload, state, locked_at, locked_by, attempts)
              VALUES (${businessId}::uuid, 'inbound.message', '{}'::jsonb, ${extra})`,
        ),
      ).toMatch(/^42501 /);
    }
  });

  it('the honest paths still work: enqueue (with a delay), the worker retries and defers, the application completes', async () => {
    const businessId = await seedBusiness();
    const delayed = await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.enqueue(tx, { businessId, kind: 'inbound.message', payload: {}, delayMs: 60_000 }),
    );
    expect(delayed).not.toBeNull();
    const job = await pendingJob(businessId);
    const claimed = await jobsRepo.claimNext(workerDb, 'gate-test');
    expect(claimed?.id).toBe(job);
    /* The worker owns retry and scheduling. */
    expect((await jobsRepo.markFailed(workerDb, claimed!, 'transient', 5_000)).state).toBe(
      'pending',
    );
    await ownerDb.execute(sql`UPDATE jobs SET run_at = now() WHERE id = ${job}::uuid`);
    const again = await jobsRepo.claimNext(workerDb, 'gate-test');
    expect(again?.id).toBe(job);
    await jobsRepo.deferClaimed(workerDb, job, 1_000, 'gate-test');
    await ownerDb.execute(sql`UPDATE jobs SET run_at = now() WHERE id = ${job}::uuid`);
    expect((await jobsRepo.claimNext(workerDb, 'gate-test'))?.id).toBe(job);
    /* The handler's transaction (application, pinned) completes it. */
    await withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, job, 'gate-test'));
    expect((await jobRow(job)).state).toBe('done');
  });
});

/** A stored inbound message event for the business, as the webhook records it. */
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
/** The event's job, claimed by the worker: running, as when its handler binds a spend. */
async function runningJobFor(businessId: string, eventId: string): Promise<string> {
  await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind: 'inbound.message', payload: { eventId } }),
  );
  const claimed = await jobsRepo.claimNext(workerDb, 'gate-test');
  expect(claimed?.payload).toEqual({ eventId });
  return claimed!.id;
}
const spend = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    usageRepo.reserveUnit(tx, businessId, MONTH(), UNIT, TRIAL_AI),
  );
const bind = (db: Db, businessId: string, reservation: string, eventId: string) =>
  outcome(
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`SELECT usage_bind_event(${businessId}::uuid, ${reservation}::uuid,
                                             ${eventId}::uuid)`),
    ),
  );
const reservationRow = async (id: string) =>
  [
    ...(await ownerDb.execute<{
      event_id: string | null;
      created_at: string;
      closed_at: string | null;
    }>(
      sql`SELECT event_id, created_at::text, closed_at::text FROM usage_reservations WHERE id = ${id}::uuid`,
    )),
  ][0]!;

describe('0227 (b): a reservation binds only to its own business’s event, while its job runs', () => {
  const NOT_BINDABLE =
    /^42501 .*usage_bind_event: not an event of this business whose job is running/;

  it('ATTACK: a nonexistent event, another business’s event, or an event with no running job is refused, and nothing changes', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const theirEvent = await storedEvent(theirs);
    await runningJobFor(theirs, theirEvent);
    const idle = await storedEvent(mine); // stored, but no job is running for it
    const spent = await spend(mine);
    const reservation = usageRepo.reservationOf(spent.meter)!;
    const before = await reservationRow(reservation);
    for (const target of [randomUUID(), theirEvent, idle]) {
      expect(await bind(appDb, mine, reservation, target)).toMatch(NOT_BINDABLE);
    }
    expect(await reservationRow(reservation)).toEqual(before);
  });

  it('ATTACK: a forged binding cannot stretch the refund window past 15 minutes', async () => {
    const businessId = await seedBusiness();
    const spent = await spend(businessId);
    const reservation = usageRepo.reservationOf(spent.meter)!;
    expect(await bind(appDb, businessId, reservation, randomUUID())).toMatch(NOT_BINDABLE);
    await ownerDb.execute(sql`UPDATE usage_reservations SET created_at = now() - interval '16 minutes'
                              WHERE id = ${reservation}::uuid`);
    const back = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
    );
    expect(back).toBe(0);
  });

  it('binds to its own running job’s event, repeats idempotently, refuses another event', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    await runningJobFor(businessId, eventId);
    const spent = await spend(businessId);
    const reservation = usageRepo.reservationOf(spent.meter)!;
    expect(await bind(appDb, businessId, reservation, eventId)).toBe('allowed');
    expect(await bind(appDb, businessId, reservation, eventId)).toBe('allowed');
    expect((await reservationRow(reservation)).event_id).toBe(eventId);
    const other = await storedEvent(businessId);
    expect(await bind(appDb, businessId, reservation, other)).toMatch(
      /^42501 .*belongs to another event/,
    );
    expect((await reservationRow(reservation)).event_id).toBe(eventId);
  });

  it('the honest path (noteReservedUnit in the running handler) binds, and the bound window is 45 days from creation', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    await runningJobFor(businessId, eventId);
    const spent = await spend(businessId);
    await withBusiness(appDb, businessId, (tx) =>
      events.noteReservedUnit(tx, businessId, eventId, UNIT, spent.meter),
    );
    const reservation = usageRepo.reservationOf(spent.meter)!;
    expect((await reservationRow(reservation)).event_id).toBe(eventId);
    const refundAfter = async (age: string) => {
      await ownerDb.execute(sql`UPDATE usage_reservations SET created_at = now() - ${age}::interval,
                                refunded = 0 WHERE id = ${reservation}::uuid`);
      return withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      );
    };
    expect(await refundAfter('44 days 23 hours')).toBe(1);
    expect(await refundAfter('45 days 1 minute')).toBe(0);
  });

  it('the unbound window is 15 minutes from creation, at the boundary', async () => {
    const businessId = await seedBusiness();
    const spent = await spend(businessId);
    const reservation = usageRepo.reservationOf(spent.meter)!;
    const refundAfter = async (age: string) => {
      await ownerDb.execute(sql`UPDATE usage_reservations SET created_at = now() - ${age}::interval,
                                refunded = 0 WHERE id = ${reservation}::uuid`);
      return withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      );
    };
    expect(await refundAfter('14 minutes 50 seconds')).toBe(1);
    expect(await refundAfter('15 minutes 10 seconds')).toBe(0);
  });
});
