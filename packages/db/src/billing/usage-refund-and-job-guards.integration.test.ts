/**
 * MVP readiness review of PR #432 (migration 0222), second half: what stops a holder of the
 * application credential from undoing a spend it made or withholding settlement through the job row.
 *
 *   * an unbound reservation (a request's, not a job's) is refundable only while that request can
 *     still be running (15 minutes); a job-bound one keeps the 0218 rule;
 *   * the job and event guards apply to a login that only inherits `rekoda_app` / `rekoda_worker`
 *     (the review's MINOR residuals 10 and 11);
 *   * the application cannot complete, reschedule or pre-finish a settlement job.
 *
 * Every attack runs on a live `rekoda_app`, `rekoda_worker` or inheriting-login connection; the owner
 * only arranges state and reads it back. The ceiling and meter-row half is
 * `usage-entitlement-authority.integration.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { usagePeriod, type UsageUnit } from '@rekoda/core';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, jobsRepo, usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  urls,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const NOW_MONTH = () => usagePeriod(new Date());
const UNIT: UsageUnit = 'AI_ACTIONS';
const TRIAL_AI = 50;

const usedTotal = async (businessId: string, unit: string = UNIT) =>
  [
    ...(await ownerDb.execute<{ used: number }>(
      sql`SELECT used FROM usage_counters WHERE business_id = ${businessId}::uuid AND unit = ${unit}`,
    )),
  ].reduce((sum, row) => sum + row.used, 0);

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

describe('0222: an unbound reservation is refundable only while its request can be running', () => {
  const backdate = (meter: usageRepo.MeterRow, minutes: number) =>
    ownerDb.execute(sql`UPDATE usage_reservations
        SET created_at = now() - make_interval(mins => ${minutes})
        WHERE id = ${usageRepo.reservationOf(meter)}::uuid`);

  it('a failed operation within the window gives its unit back, once', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI),
    );
    await backdate(spent.meter, 14);
    const refund = () =>
      withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      );
    expect(await refund()).toBe(1);
    expect(await refund()).toBe(0);
    expect(await usedTotal(businessId)).toBe(0);
  });

  it('ATTACK: a handle kept past the request (a successful send, order or export) returns nothing', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI),
    );
    await backdate(spent.meter, 16);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, spent.meter, UNIT),
      ),
    ).toBe(0);
    expect(await usedTotal(businessId)).toBe(1);
  });

  it('a reservation bound to an unfinished job stays refundable past the window (0218 rule)', async () => {
    const businessId = await seedBusiness();
    const recorded = { id: await storedEvent(businessId) };
    const meter = await withBusiness(appDb, businessId, async (tx) => {
      const spent = await usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI);
      await events.noteReservedUnit(tx, businessId, recorded.id, UNIT, spent.meter);
      return spent.meter;
    });
    await backdate(meter, 120);
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        usageRepo.refundUnit(tx, businessId, meter, UNIT),
      ),
    ).toBe(1);
  });

  it('concurrent refunds of one reservation give back exactly once', async () => {
    const businessId = await seedBusiness();
    const spent = await withBusiness(appDb, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, NOW_MONTH(), UNIT, TRIAL_AI, 3),
    );
    const back = await Promise.all(
      Array.from({ length: 4 }, () =>
        withBusiness(appDb, businessId, (tx) =>
          usageRepo.refundUnit(tx, businessId, spent.meter, UNIT, 3),
        ),
      ),
    );
    expect(back.reduce((a, b) => a + b, 0)).toBe(3);
    expect(await usedTotal(businessId)).toBe(0);
  });
});

describe('0222: the guards hold for a login that only inherits the restricted role (residual 11)', () => {
  const APP_LOGIN = 'rekoda_app_login_t0222';
  const WORKER_LOGIN = 'rekoda_worker_login_t0222';
  let inheritsApp: Db;
  let inheritsWorker: Db;
  const closers: Array<() => Promise<void>> = [];
  const asLogin = (login: string) => {
    const url = new URL(urls.app);
    url.username = login;
    return url.toString();
  };

  beforeAll(async () => {
    for (const [login, role] of [
      [APP_LOGIN, 'rekoda_app'],
      [WORKER_LOGIN, 'rekoda_worker'],
    ] as const) {
      await ownerDb.execute(
        sql.raw(`DO $$ BEGIN CREATE ROLE ${login} LOGIN INHERIT;
                 EXCEPTION WHEN duplicate_object THEN NULL; END $$`),
      );
      await ownerDb.execute(sql.raw(`GRANT ${role} TO ${login}`));
    }
    for (const [login, set] of [
      [APP_LOGIN, (d: Db) => (inheritsApp = d)],
      [WORKER_LOGIN, (d: Db) => (inheritsWorker = d)],
    ] as const) {
      const { db, close } = createDb(asLogin(login), { max: 1 });
      set(db);
      closers.push(close);
    }
  });

  afterAll(async () => {
    for (const close of closers) await close();
    for (const login of [APP_LOGIN, WORKER_LOGIN]) {
      await ownerDb.execute(sql.raw(`DROP ROLE IF EXISTS ${login}`));
    }
  });

  async function runningJob(businessId: string): Promise<string> {
    const rows = await withBusiness(ownerDb, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO jobs (business_id, kind, payload, state, locked_by, locked_at)
        VALUES (${businessId}::uuid, 'message.inbound', '{}'::jsonb, 'running', 'w:1', now())
        RETURNING id`),
    );
    return [...rows][0]!.id;
  }

  it('an inheriting application login cannot park a running job or rewrite its lease', async () => {
    const businessId = await seedBusiness();
    const jobId = await runningJob(businessId);
    for (const statement of [
      sql`UPDATE jobs SET state = 'pending' WHERE id = ${jobId}::uuid`,
      sql`UPDATE jobs SET locked_by = 'attacker' WHERE id = ${jobId}::uuid`,
    ]) {
      expect(
        await outcome(withBusiness(inheritsApp, businessId, (tx) => tx.execute(statement))),
      ).toMatch(/^42501 /);
    }
    /* The honest completion still works for it. */
    expect(
      await outcome(
        withBusiness(inheritsApp, businessId, (tx) =>
          tx.execute(sql`UPDATE jobs SET state = 'done', locked_by = NULL, locked_at = NULL
                         WHERE id = ${jobId}::uuid`),
        ),
      ),
    ).toBe('allowed');
  });

  it('a recovered dead job goes back with no lease (residual 10)', async () => {
    const businessId = await seedBusiness();
    const jobId = await runningJob(businessId);
    await ownerDb.execute(sql`UPDATE jobs SET state = 'dead' WHERE id = ${jobId}::uuid`);
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`UPDATE jobs SET state = 'pending', locked_by = 'w:x', locked_at = now()
                         WHERE id = ${jobId}::uuid`),
        ),
      ),
    ).toMatch(/^42501 .*with no lease/);
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`UPDATE jobs SET state = 'pending', locked_by = NULL, locked_at = NULL
                         WHERE id = ${jobId}::uuid`),
        ),
      ),
    ).toBe('allowed');
  });

  it('an inheriting worker login cannot process an attributed event', async () => {
    const businessId = await seedBusiness();
    const recorded = { id: await storedEvent(businessId) };
    expect(
      await outcome(
        withBusiness(inheritsWorker, businessId, (tx) =>
          tx.execute(
            sql`UPDATE external_events SET processed_at = now() WHERE id = ${recorded.id}::uuid`,
          ),
        ),
      ),
    ).toMatch(/^42501 .*only flag an attributed event/);
  });
});

describe('0222: the application cannot withhold a settlement job', () => {
  const enqueueAsApp = (businessId: string, values: ReturnType<typeof sql>) =>
    outcome(
      withBusiness(appDb, businessId, (tx) =>
        tx.execute(sql`INSERT INTO jobs (business_id, kind, payload, state, run_at)
                       VALUES (${businessId}::uuid, 'billing.process', '{}'::jsonb, ${values})`),
      ),
    );
  async function settlementJob(businessId: string, state: string): Promise<string> {
    const eventId = await paystackEvent(businessId);
    const queued = await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId,
        kind: 'billing.process',
        payload: { eventId },
        singletonKey: `billevent:${eventId}`,
      }),
    );
    const id = queued!.id;
    if (state !== 'pending') {
      await withBusiness(ownerDb, businessId, (tx) =>
        tx.execute(sql`UPDATE jobs SET state = ${state},
                         locked_by = CASE WHEN ${state} = 'running' THEN 's:1' END,
                         locked_at = CASE WHEN ${state} = 'running' THEN now() END
                       WHERE id = ${id}::uuid`),
      );
    }
    return id;
  }
  const asApp = (businessId: string, statement: ReturnType<typeof sql>) =>
    outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)));

  /** A Paystack event attributed to the business, as the pump leaves it before enqueueing. */
  async function paystackEvent(businessId: string): Promise<string> {
    const recorded = await withBusiness(appDb, businessId, (tx) =>
      events.recordEvent(tx, {
        provider: 'paystack',
        eventType: 'charge.success',
        externalId: `evt_${randomUUID()}`,
        payload: { sealed: 'opaque' },
        businessId,
      }),
    );
    if (!recorded.isNew) throw new Error('the event was not stored');
    return recorded.id;
  }

  it('ATTACK: squatting a payment’s settlement key with a job naming something else is refused', async () => {
    const businessId = await seedBusiness();
    const real = await paystackEvent(businessId);
    const enqueue = (eventId: string, key: string) =>
      asApp(
        businessId,
        sql`INSERT INTO jobs (business_id, kind, payload, singleton_key)
            VALUES (${businessId}::uuid, 'billing.process',
                    jsonb_build_object('eventId', ${eventId}::text), ${key})`,
      );
    /* The real event's key with a bogus event in the payload, then a key that does not match. */
    expect(await enqueue(randomUUID(), `billevent:${real}`)).toMatch(
      /^42501 .*names the Paystack event of its singleton key/,
    );
    expect(await enqueue(real, `billevent:${randomUUID()}`)).toMatch(/^42501 /);
    /* Another business's event, under this business. */
    const other = await seedBusiness();
    const theirs = await paystackEvent(other);
    expect(await enqueue(theirs, `billevent:${theirs}`)).toMatch(/^42501 /);
    /* A no-charge upgrade job for a charge that does not exist. */
    expect(
      await asApp(
        businessId,
        sql`INSERT INTO jobs (business_id, kind, payload, singleton_key)
            VALUES (${businessId}::uuid, 'billing.apply_no_charge',
                    '{"reference":"RKD-SUB-NOPE"}'::jsonb, 'no-charge:RKD-SUB-NOPE')`,
      ),
    ).toMatch(/^42501 .*names the charge of its singleton key/);
    /* The honest one: the event's own key and payload. */
    expect(await enqueue(real, `billevent:${real}`)).toBe('allowed');
  });

  it('the honest enqueue (pending, due now) still works', async () => {
    const businessId = await seedBusiness();
    expect(await settlementJob(businessId, 'pending')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ATTACK: enqueueing a settlement job already finished, running, or due far in the future is refused', async () => {
    const businessId = await seedBusiness();
    expect(await enqueueAsApp(businessId, sql`'done', now()`)).toMatch(
      /^42501 .*pending work due now/,
    );
    expect(await enqueueAsApp(businessId, sql`'running', now()`)).toMatch(/^42501 /);
    expect(await enqueueAsApp(businessId, sql`'pending', 'infinity'::timestamptz`)).toMatch(
      /^42501 /,
    );
  });

  it('ATTACK: marking a running settlement job done, or rescheduling a pending one, is refused', async () => {
    const businessId = await seedBusiness();
    const running = await settlementJob(businessId, 'running');
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'done', locked_by = NULL, locked_at = NULL
                                  WHERE id = ${running}::uuid`,
      ),
    ).toMatch(/^42501 .*only settlement runs, completes or reschedules/);
    const pending = await settlementJob(businessId, 'pending');
    expect(
      await asApp(businessId, sql`UPDATE jobs SET run_at = 'infinity' WHERE id = ${pending}::uuid`),
    ).toMatch(/^42501 /);
  });

  it('an operator may still requeue a dead settlement job, and settlement completes its own', async () => {
    const businessId = await seedBusiness();
    const dead = await settlementJob(businessId, 'dead');
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'pending', run_at = now(),
                                    max_attempts = attempts + 1, locked_by = NULL, locked_at = NULL
                                  WHERE id = ${dead}::uuid`,
      ),
    ).toBe('allowed');
    const running = await settlementJob(businessId, 'running');
    expect(
      await outcome(
        withBusiness(settlementDb, businessId, (tx) =>
          tx.execute(sql`UPDATE jobs SET state = 'done', locked_by = NULL, locked_at = NULL
                         WHERE id = ${running}::uuid`),
        ),
      ),
    ).toBe('allowed');
  });
});
