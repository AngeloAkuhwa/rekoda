/**
 * OD-51.4, completed (migration 0218; found by the independent review of `2b602b0`, recorded as
 * OD-52): a reservation stops being refundable when the work it paid for is finished.
 *
 * 0216 made a refund possible only against a reservation, once, within 45 days. But a message that
 * was answered keeps its reservation's handle on its event, where the application credential can
 * read it, and nothing marked the reservation finished. A holder of that credential could return
 * every unit a business genuinely used in the last 45 days.
 *
 * The rule the code already follows: a unit goes back only inside an attempt of the same event's
 * job. So the database now closes an event's reservations when its job is done, and a closed
 * reservation gives nothing back. A job that has not finished, retries or dies keeps its
 * reservation refundable, exactly as before.
 *
 * Every assertion runs on a live connection as that principal.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { events, jobsRepo, usageRepo } from '../index.js';
import { MIGRATIONS_DIR } from '../migrate.js';
import { requireUrls } from '../testing.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const PERIOD = '2026-11';
const UNIT: usageRepo.UsageUnit = 'AI_ACTIONS';

const used = async (businessId: string): Promise<number> =>
  [
    ...(await ownerDb.execute<{ used: number }>(
      sql`SELECT used FROM usage_counters WHERE business_id = ${businessId}::uuid AND unit = ${UNIT}`,
    )),
  ][0]?.used ?? 0;

/** A stored inbound message and the job that will handle it, as the webhook ingress leaves them. */
async function message(businessId: string): Promise<{ eventId: string; jobId: string }> {
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
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload)
      VALUES (${businessId}::uuid, 'message.inbound',
              jsonb_build_object('eventId', ${recorded.id}::text))
      RETURNING id`),
  );
  return { eventId: recorded.id, jobId: [...rows][0]!.id };
}

/** The handler's metering step: spend one unit and record it on the message, in one transaction. */
const spendFor = (businessId: string, eventId: string, db: Db = appDb) =>
  withBusiness(db, businessId, async (tx) => {
    const spent = await usageRepo.reserveUnit(tx, businessId, PERIOD, UNIT, 10);
    if (spent.granted) await events.noteReservedUnit(tx, businessId, eventId, UNIT, spent.meter);
    return spent.meter;
  });

const setJob = (businessId: string, jobId: string, state: 'running' | 'pending' | 'dead') =>
  withBusiness(ownerDb, businessId, (tx) =>
    tx.execute(sql`UPDATE jobs SET state = ${state} WHERE id = ${jobId}::uuid`),
  );
/** The handler's last step, in its own transaction, on the application credential. */
const finish = (businessId: string, jobId: string) =>
  withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, jobId));

/** What a holder of the application credential can read back: the handle left on the event. */
const handleOnEvent = async (businessId: string, eventId: string): Promise<usageRepo.MeterRow> => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ handle: string }>(sql`
      SELECT reserved_meters ->> ${UNIT} AS handle FROM external_events
      WHERE id = ${eventId}::uuid`),
  );
  return [...rows][0]!.handle as usageRepo.MeterRow;
};
const refund = (db: Db, businessId: string, meter: usageRepo.MeterRow) =>
  withBusiness(db, businessId, (tx) => usageRepo.refundUnit(tx, businessId, meter, UNIT));
const reservation = async (meter: usageRepo.MeterRow) =>
  [
    ...(await ownerDb.execute<{ event_id: string | null; closed: boolean; refunded: number }>(
      sql`SELECT event_id, closed_at IS NOT NULL AS closed, refunded FROM usage_reservations
          WHERE id = ${usageRepo.reservationOf(meter)}::uuid`,
    )),
  ][0]!;

describe('a finished message keeps what it used (0218)', () => {
  it('the handle left on an answered message returns nothing, for the application or the worker', async () => {
    const businessId = await seedBusiness();
    const { eventId, jobId } = await message(businessId);
    await setJob(businessId, jobId, 'running');
    await spendFor(businessId, eventId);
    await finish(businessId, jobId);
    expect(await used(businessId)).toBe(1);

    /* The attack the review described: read the handle off the finished event and hand it back. */
    const handle = await handleOnEvent(businessId, eventId);
    expect(usageRepo.reservationOf(handle)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await refund(appDb, businessId, handle)).toBe(0);
    expect(await refund(workerDb, businessId, handle)).toBe(0);

    expect(await used(businessId)).toBe(1);
    expect(await reservation(handle)).toMatchObject({
      event_id: eventId,
      closed: true,
      refunded: 0,
    });
  });

  it('a whole month of answered messages cannot be handed back', async () => {
    const businessId = await seedBusiness();
    const handles: usageRepo.MeterRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { eventId, jobId } = await message(businessId);
      await setJob(businessId, jobId, 'running');
      handles.push(await spendFor(businessId, eventId));
      await finish(businessId, jobId);
    }
    expect(await used(businessId)).toBe(5);
    for (const handle of handles) expect(await refund(appDb, businessId, handle)).toBe(0);
    expect(await used(businessId)).toBe(5);
  });
});

describe('a unit still goes back while its job has not finished (0218)', () => {
  it('a running job gives its unit back, once', async () => {
    const businessId = await seedBusiness();
    const { eventId, jobId } = await message(businessId);
    await setJob(businessId, jobId, 'running');
    const meter = await spendFor(businessId, eventId);

    expect(await refund(appDb, businessId, meter)).toBe(1);
    expect(await refund(appDb, businessId, meter)).toBe(0);
    expect(await used(businessId)).toBe(0);
    /* Finishing afterwards closes a reservation that has nothing left to give. */
    await finish(businessId, jobId);
    expect(await reservation(meter)).toMatchObject({ closed: true, refunded: 1 });
  });

  it('a job sent back for a retry, or dead, keeps its reservation open', async () => {
    const businessId = await seedBusiness();
    for (const state of ['pending', 'dead'] as const) {
      const { eventId, jobId } = await message(businessId);
      await setJob(businessId, jobId, 'running');
      const meter = await spendFor(businessId, eventId);
      await setJob(businessId, jobId, state);
      expect((await reservation(meter)).closed, state).toBe(false);
      expect(await refund(appDb, businessId, meter), state).toBe(1);
    }
    expect(await used(businessId)).toBe(0);
  });

  it('a retry that finishes closes what the first attempt reserved, and only that message’s', async () => {
    const businessId = await seedBusiness();
    const first = await message(businessId);
    const second = await message(businessId);
    await setJob(businessId, first.jobId, 'running');
    await setJob(businessId, second.jobId, 'running');
    const firstMeter = await spendFor(businessId, first.eventId);
    const secondMeter = await spendFor(businessId, second.eventId);
    await setJob(businessId, first.jobId, 'pending'); // attempt one failed after metering
    await setJob(businessId, first.jobId, 'running'); // attempt two reuses the unit
    await finish(businessId, first.jobId);

    expect((await reservation(firstMeter)).closed).toBe(true);
    expect((await reservation(secondMeter)).closed).toBe(false);
    expect(await refund(appDb, businessId, secondMeter)).toBe(1);
    expect(await used(businessId)).toBe(1);
  });

  it('a reservation held only in memory by a request is not touched by any job', async () => {
    const businessId = await seedBusiness();
    /* A template send, a storefront order, an export: no event, the handle never leaves memory. */
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, PERIOD, UNIT, 10),
    );
    const { eventId, jobId } = await message(businessId);
    await setJob(businessId, jobId, 'running');
    await spendFor(businessId, eventId);
    await finish(businessId, jobId);

    expect(await reservation(spent.meter)).toMatchObject({ event_id: null, closed: false });
    expect(await refund(appDb, businessId, spent.meter)).toBe(1);
    expect(await used(businessId)).toBe(1);
  });

  it('another business’s finished job closes nothing here', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const { eventId, jobId } = await message(mine);
    await setJob(mine, jobId, 'running');
    const meter = await spendFor(mine, eventId);
    /* Their job names MY event in its payload. */
    const forged = await withBusiness(appDb, theirs, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO jobs (business_id, kind, payload, state)
        VALUES (${theirs}::uuid, 'message.inbound', jsonb_build_object('eventId', ${eventId}::text),
                'running')
        RETURNING id`),
    );
    await finish(theirs, [...forged][0]!.id);

    expect((await reservation(meter)).closed).toBe(false);
    expect(await refund(appDb, mine, meter)).toBe(1);
  });
});

describe('binding and closing are the database’s, not a runtime role’s (0218)', () => {
  const bind = (
    db: Db,
    pinned: string,
    businessId: string,
    meter: usageRepo.MeterRow,
    event: string,
  ) =>
    withBusiness(db, pinned, async (tx) => {
      const rows = await tx.execute<{ bound: boolean }>(
        sql`SELECT public.usage_bind_event(${businessId}::uuid,
              ${usageRepo.reservationOf(meter)}::uuid, ${event}::uuid) AS bound`,
      );
      return [...rows][0]!.bound;
    });

  it('a reservation is bound once, to one event, for the pinned business only', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const first = await message(businessId);
    const second = await message(businessId);
    const meter = await spendFor(businessId, first.eventId);
    expect((await reservation(meter)).event_id).toBe(first.eventId);

    /* The same event again is a repeat. Moving it to another event would let it dodge closing. */
    expect(await bind(appDb, businessId, businessId, meter, first.eventId)).toBe(true);
    expect(await outcome(bind(appDb, businessId, businessId, meter, second.eventId))).toMatch(
      /belongs to another event/,
    );
    expect(await outcome(bind(appDb, other, businessId, meter, first.eventId))).toMatch(
      /not the pinned tenant/,
    );
    /* Under another business's pin the reservation is not there at all. */
    expect(await bind(appDb, other, other, meter, first.eventId)).toBe(false);
    expect((await reservation(meter)).event_id).toBe(first.eventId);
  });

  it('settlement and the operator cannot bind; no runtime role can read, reopen or re-date a reservation', async () => {
    const businessId = await seedBusiness();
    const { eventId, jobId } = await message(businessId);
    await setJob(businessId, jobId, 'running');
    const meter = await spendFor(businessId, eventId);
    await finish(businessId, jobId);
    const id = usageRepo.reservationOf(meter)!;

    for (const db of [settlementDb, operatorDb]) {
      expect(await outcome(bind(db, businessId, businessId, meter, eventId))).toMatch(
        /permission denied/,
      );
    }
    for (const db of [appDb, workerDb, settlementDb, operatorDb]) {
      for (const statement of [
        sql`SELECT id FROM usage_reservations WHERE id = ${id}::uuid`,
        sql`UPDATE usage_reservations SET closed_at = NULL WHERE id = ${id}::uuid`,
        sql`UPDATE usage_reservations SET event_id = NULL WHERE id = ${id}::uuid`,
        sql`UPDATE usage_reservations SET created_at = now(), refunded = 0 WHERE id = ${id}::uuid`,
        sql`DELETE FROM usage_reservations WHERE id = ${id}::uuid`,
        sql`SELECT rekoda_private.jobs_close_event_reservations()`,
      ]) {
        expect(await outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)))).toMatch(
          /permission denied/,
        );
      }
    }
    /* Reopening the JOB does not reopen the reservation either. */
    await setJob(businessId, jobId, 'pending');
    expect(await reservation(meter)).toMatchObject({ closed: true });
    expect(await refund(appDb, businessId, meter)).toBe(0);
    expect(await used(businessId)).toBe(1);
  });
});

describe('existing reservations are bound and closed by the migration (0218)', () => {
  async function rerunMigration(): Promise<void> {
    const owner = postgres(requireUrls().owner, { max: 1, onnotice: () => {} });
    try {
      await owner
        .unsafe(await readFile(join(MIGRATIONS_DIR, '0218_usage_reservation_closure.sql'), 'utf8'))
        .simple();
    } finally {
      await owner.end();
    }
  }
  /** A reservation as 0216 left it: its handle on the event, not bound, not closed. */
  async function asLeftBy0216(
    businessId: string,
    state: 'done' | 'pending' | 'running' | 'dead' | null,
  ) {
    const { eventId, jobId } = await message(businessId);
    const meter = await spendFor(businessId, eventId);
    await ownerDb.execute(
      sql`UPDATE usage_reservations SET event_id = NULL, closed_at = NULL
          WHERE id = ${usageRepo.reservationOf(meter)}::uuid`,
    );
    /* Staged as the owner, with the closing trigger off, so the row is exactly the old shape. */
    await ownerDb.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE jobs DISABLE TRIGGER jobs_close_event_reservations`);
      await tx.execute(
        state === null
          ? sql`DELETE FROM jobs WHERE id = ${jobId}::uuid`
          : sql`UPDATE jobs SET state = ${state} WHERE id = ${jobId}::uuid`,
      );
      await tx.execute(sql`ALTER TABLE jobs ENABLE TRIGGER jobs_close_event_reservations`);
    });
    return { meter, eventId };
  }

  it('closes what is finished, leaves what may still go back, and changes no counter', async () => {
    const businessId = await seedBusiness();
    const done = await asLeftBy0216(businessId, 'done');
    const purged = await asLeftBy0216(businessId, null); // its finished job was cleaned up long ago
    const pending = await asLeftBy0216(businessId, 'pending');
    const running = await asLeftBy0216(businessId, 'running');
    const dead = await asLeftBy0216(businessId, 'dead');
    expect(await used(businessId)).toBe(5);

    await rerunMigration();

    expect(await reservation(done.meter)).toMatchObject({ event_id: done.eventId, closed: true });
    expect(await reservation(purged.meter)).toMatchObject({
      event_id: purged.eventId,
      closed: true,
    });
    for (const open of [pending, running, dead]) {
      expect(await reservation(open.meter)).toMatchObject({
        event_id: open.eventId,
        closed: false,
      });
    }
    expect(await used(businessId)).toBe(5);
    expect(await refund(appDb, businessId, done.meter)).toBe(0);
    expect(await refund(appDb, businessId, purged.meter)).toBe(0);
    expect(await refund(appDb, businessId, pending.meter)).toBe(1);
    expect(await used(businessId)).toBe(4);

    /* A second run changes nothing: what was refunded stays refunded, what was open stays open. */
    await rerunMigration();
    expect(await used(businessId)).toBe(4);
    expect(await reservation(running.meter)).toMatchObject({ closed: false });
    expect(await reservation(pending.meter)).toMatchObject({ closed: false, refunded: 1 });
  });
});
