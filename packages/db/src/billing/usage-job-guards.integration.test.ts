/**
 * MVP readiness review of PR #432 (migration 0222), split from
 * `usage-entitlement-authority.integration.test.ts` by concern: the job and event guards.
 *
 * The job and event guards apply to a login that only inherits the restricted role (the review's
 * MINOR residuals 10 and 11), and the application cannot withhold a settlement job. Every attack
 * runs on a live restricted connection, never as the owner; the owner is used only to arrange state
 * and to read it back.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, jobsRepo } from '../index.js';
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
    const queued = await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId,
        kind: 'billing.process',
        payload: { eventId: randomUUID() },
        singletonKey: `billevent:${randomUUID()}`,
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
