/**
 * Owner review of PR #432 (11 Nov 2026, OWN-89; migration 0201): the close cursor's LEASE. The
 * fixtures are those of renewal-gate-cursor.integration.test.ts (durable cursor, 0199).
 *
 * OWN-70 / OWN-87 (PR B): closing blocked renewals walks a DURABLE keyset cursor (migration 0199),
 * so blocks that persistently fail to close, even blocks whose failure stamp also fails, cannot
 * starve the blocks behind them: not across passes, not across worker restarts, not when a batch
 * is replayed after a crash, and not when two runners start at once. A pass stays bounded
 * (20 pages of 200).
 *
 * A "restart" here is a genuinely new process state: fresh database pools and a freshly imported
 * sweep module (`vi.resetModules`), so nothing held in memory by an earlier pass survives. The
 * previous in-memory fallback offset fails the restart tests below; the durable cursor passes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateOpsAlerts } from '@rekoda/core';
import { createDb, identity, sql, subscriptionsRepo, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls, settlementDb } from '@rekoda/db/testing';
import { collectOpsSnapshot } from '../health/ops-alerts.js';
import type * as SweepModule from './renewal-sweep.js';

const LIVE = ['sk', 'live', 'p'.repeat(24)].join('_');
const OPEN_GATE = {
  planCatalogueReads: false,
  paystackSecretKey: LIVE,
  paystackPlatformConfirmed: true,
};
const PASS_ROWS = 20 * 200;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

function pools(): { app: Db; worker: Db } {
  const app = createDb(urls.app, { max: 6 });
  const worker = createDb(urls.worker, { max: 6 });
  closers.push(app.close, worker.close);
  return { app: app.db, worker: worker.db };
}

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ app: appDb, worker: workerDb } = pools());
  const owner = createDb(urls.owner, { max: 6 });
  ownerDb = owner.db;
  closers.push(owner.close);
});
afterAll(async () => {
  await ownerDb?.execute(sql`DROP TABLE IF EXISTS lease_takeovers`);
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS slow_block_close() CASCADE`);
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_cursor_advance() CASCADE`);
  await ownerDb?.execute(sql`DROP SEQUENCE IF EXISTS refuse_attempts`);
  for (const c of closers) await c();
});
beforeEach(async () => {
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS slow_block_close() CASCADE`);
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_cursor_advance() CASCADE`);
  await truncateAll(urls);
  // The cursor row is operational state, not test data: put it back to "start of the list".
  await ownerDb.execute(sql`
    UPDATE renewal_block_close_cursor SET after_blocked_at = NULL, after_reference = NULL,
      lease_owner = NULL, lease_expires_at = NULL, pass_started_at = NULL, pass_closed = 0,
      pass_failed = 0, passes_completed = 0, passes_abandoned = 0, last_abandoned_at = NULL, cycle_failed = 0, last_cycle_failed = NULL, last_pass_closed = NULL, last_pass_failed = NULL,
      last_pass_finished_at = NULL, last_advanced_at = NULL`);
  await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS refuse_attempts`);
  await ownerDb.execute(sql`CREATE SEQUENCE refuse_attempts`);
});

/**
 * `total` open blocked renewals, in block-time order; the first `stuck` cannot be closed. With
 * `stampFails` their failure stamp is refused too (the case the in-memory offset used to cover).
 * Every refused attempt bumps a sequence, which survives the rollback, so attempts can be counted.
 */
async function seedBlocked(total: number, stuck: number, stampFails = false): Promise<void> {
  const user = await identity.upsertUserByPhone(appDb, '+2348194000001');
  await ownerDb.execute(sql`
    INSERT INTO businesses (name, owner_user_id)
    SELECT 'Ada ' || g, ${user.id}::uuid FROM generate_series(1, ${total}) g`);
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, amount_k, status, reference, period_start, period_end,
       blocked_at, blocked_reason, quantity)
    SELECT b.id, 'renewal', 'chat', 1000, 'pending',
           'RKD-SUB-20261108-' || lpad(upper(to_hex(n)), 6, '0'),
           now() - interval '1 day', now() + interval '29 days',
           now() - interval '1 hour' + n * interval '1 millisecond',
           'awaiting_platform_confirmation',
           CASE WHEN n <= ${stuck} THEN 2 ELSE 1 END
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM businesses) b`);
  await ownerDb.execute(sql`
    CREATE OR REPLACE FUNCTION refuse_block_close() RETURNS trigger LANGUAGE plpgsql
    SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$
    BEGIN PERFORM nextval('public.refuse_attempts'); RAISE EXCEPTION 'cannot close'; END $f$`);
  if (stampFails) {
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_block_close BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (OLD.quantity = 2
        AND (NEW.blocked_resolved_at IS NOT NULL
             OR NEW.blocked_close_failed_at IS DISTINCT FROM OLD.blocked_close_failed_at))
      EXECUTE FUNCTION refuse_block_close()`);
  } else {
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_block_close BEFORE UPDATE ON subscription_charges
      FOR EACH ROW WHEN (OLD.quantity = 2 AND NEW.blocked_resolved_at IS NOT NULL)
      EXECUTE FUNCTION refuse_block_close()`);
  }
}

const openCount = () => subscriptionsRepo.blockedRenewalCount(workerDb);
const closeOnce: typeof SweepModule.closeBlocksTheGateNoLongerHolds = async (...args) => {
  const { closeBlocksTheGateNoLongerHolds } = await import('./renewal-sweep.js');
  return closeBlocksTheGateNoLongerHolds(...args);
};
const sweep = async (extra: Record<string, unknown> = {}) => {
  const { sweepRenewals } = await import('./renewal-sweep.js');
  return sweepRenewals({
    settlementDb: settlementDb(),
    workerDb,
    appDb,
    config: OPEN_GATE,
    ...extra,
  });
};

/** A new worker process: fresh pools and a freshly loaded sweep module, nothing carried over. */
async function restartedWorker(): Promise<{
  sweep: (extra?: Record<string, unknown>) => Promise<unknown>;
  closePass: typeof SweepModule.closeBlocksTheGateNoLongerHolds;
  worker: Db;
  app: Db;
}> {
  vi.resetModules();
  const mod = (await import('./renewal-sweep.js')) as typeof SweepModule;
  const { app, worker } = pools();
  return {
    sweep: (extra = {}) =>
      mod.sweepRenewals({
        settlementDb: settlementDb(),
        workerDb: worker,
        appDb: app,
        config: OPEN_GATE,
        ...extra,
      }),
    closePass: mod.closeBlocksTheGateNoLongerHolds,
    worker,
    app,
  };
}

async function attempts(): Promise<number> {
  const [seq] = await ownerDb.execute<{ last: string; called: boolean }>(
    sql`SELECT last_value::text AS last, is_called AS called FROM refuse_attempts`,
  );
  return seq?.called ? Number(seq.last) : 0;
}

async function cursorRow(): Promise<{
  after_reference: string | null;
  after_us: string | null;
  lease_owner: string | null;
  passes_completed: string;
}> {
  const [row] = await ownerDb.execute<{
    after_reference: string | null;
    after_us: string | null;
    lease_owner: string | null;
    passes_completed: string;
  }>(sql`
    SELECT after_reference, (EXTRACT(EPOCH FROM after_blocked_at) * 1000000)::bigint::text AS after_us,
           lease_owner::text, passes_completed::text
    FROM renewal_block_close_cursor`);
  // No row yet reads as "start of the list" (the claim creates it).
  return row ?? { after_reference: null, after_us: null, lease_owner: null, passes_completed: '0' };
}

const ref = (n: number) => `RKD-SUB-20261108-${n.toString(16).toUpperCase().padStart(6, '0')}`;

/**
 * Owner review of #432 (11 Nov 2026): the lease must hold for as long as a runner is legitimately
 * working, expire only when the runner stops, and a runner that lost it must stop at once. Time is
 * simulated in the database: a trigger on each close moves the lease expiry back by 20 seconds,
 * as if that close had taken 20 seconds, against a 30-second lease, and then lets a second runner
 * try to claim the cursor while the first is still mid-batch.
 */
describe('the close cursor lease follows the runner that holds it', () => {
  const B = '00000000-0000-4000-8000-0000000000b2';

  async function slowCloses(takeover: 'claim' | 'force-on-second'): Promise<void> {
    await ownerDb.execute(sql`DROP TABLE IF EXISTS lease_takeovers`);
    await ownerDb.execute(sql`CREATE TABLE lease_takeovers (n serial PRIMARY KEY, ok boolean)`);
    if (takeover === 'claim') {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION slow_block_close() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$
        BEGIN
          -- This close "took" 20 seconds of a 30-second lease...
          UPDATE renewal_block_close_cursor SET lease_expires_at = lease_expires_at - interval '20 seconds';
          -- ...and a second runner tries to take the cursor while the first is still working.
          INSERT INTO lease_takeovers (ok)
            SELECT renewal_block_close_claim('00000000-0000-4000-8000-0000000000b2'::uuid, 30);
          RETURN NEW;
        END $f$`);
    } else {
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION slow_block_close() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$
        BEGIN
          -- The first runner stalled past its lease during its second close and the second runner
          -- took the cursor over meanwhile.
          IF (SELECT count(*) FROM subscription_charges WHERE blocked_resolved_at IS NOT NULL) = 2 THEN
            UPDATE renewal_block_close_cursor
            SET lease_owner = '00000000-0000-4000-8000-0000000000b2'::uuid, lease_expires_at = clock_timestamp() + interval '10 minutes';
            INSERT INTO lease_takeovers (ok) VALUES (true);
          END IF;
          RETURN NEW;
        END $f$`);
    }
    await ownerDb.execute(sql`
      CREATE TRIGGER slow_block_close AFTER UPDATE ON subscription_charges
      FOR EACH ROW WHEN (OLD.blocked_resolved_at IS NULL AND NEW.blocked_resolved_at IS NOT NULL)
      EXECUTE FUNCTION slow_block_close()`);
  }

  async function takeovers(): Promise<boolean[]> {
    const rows = await ownerDb.execute<{ ok: boolean }>(
      sql`SELECT ok FROM lease_takeovers ORDER BY n`,
    );
    return [...rows].map((r) => r.ok);
  }

  async function cursorCounts(): Promise<{
    completed: string;
    abandoned: string;
    owner: string | null;
  }> {
    const [row] = await ownerDb.execute<{
      completed: string;
      abandoned: string;
      owner: string | null;
    }>(sql`
      SELECT passes_completed::text AS completed, passes_abandoned::text AS abandoned,
             lease_owner::text AS owner
      FROM renewal_block_close_cursor`);
    return row!;
  }

  it('a slow but healthy batch keeps its lease: no second runner can take over while it is still closing', async () => {
    await seedBlocked(6, 0);
    await slowCloses('claim');
    const a = await restartedWorker();
    // One batch of six closes, each "20 seconds" long, under a 30-second lease: two closes outlast
    // the lease unless the runner renews it as it works.
    const result = await a.closePass(
      { workerDb: a.worker, appDb: a.app, config: OPEN_GATE },
      6,
      2,
      30,
    );
    expect(await takeovers()).toEqual([false, false, false, false, false, false]);
    expect(result).toEqual({ ran: true, closed: 6, failed: 0, wrapped: true });
    expect(await openCount()).toBe(0);
    expect(await cursorCounts()).toEqual({ completed: '1', abandoned: '0', owner: null });
  }, 120_000);

  it('a runner that lost its lease mid-batch stops at once: it closes nothing more and saves nothing', async () => {
    await seedBlocked(6, 0);
    await slowCloses('force-on-second');
    const a = await restartedWorker();
    await expect(
      a.closePass({ workerDb: a.worker, appDb: a.app, config: OPEN_GATE }, 6, 2, 30),
    ).rejects.toThrow(/lease/);
    expect(await takeovers()).toEqual([true]);
    // Only the two closes made before the takeover: the stale runner did not carry on.
    expect(await openCount()).toBe(4);
    // It saved nothing, and its release did not hand back the new holder's lease.
    const row = await cursorRow();
    expect(row.after_reference).toBeNull();
    expect(row.lease_owner).toBe(B);
  }, 120_000);

  it('a runner that genuinely stopped is taken over once its lease expires, and on its return cannot renew, save or finish', async () => {
    await seedBlocked(6, 0);
    const dead = '00000000-0000-4000-8000-0000000000d1';
    expect(await subscriptionsRepo.claimBlockCloseCursor(workerDb, dead, 30)).toBe(true);
    // While its lease is live, nobody else may take it, and its own heartbeat keeps it.
    const early = await restartedWorker();
    expect(
      (
        await early.closePass(
          { workerDb: early.worker, appDb: early.app, config: OPEN_GATE },
          2,
          1,
          30,
        )
      ).ran,
    ).toBe(false);
    expect(await subscriptionsRepo.heartbeatBlockCloseCursor(workerDb, dead, 30)).toBe(true);
    // It stops heartbeating; its lease runs out.
    await ownerDb.execute(
      sql`UPDATE renewal_block_close_cursor SET lease_expires_at = clock_timestamp() - interval '1 second'`,
    );
    const b = await restartedWorker();
    const taken = await b.closePass(
      { workerDb: b.worker, appDb: b.app, config: OPEN_GATE },
      2,
      1,
      30,
    );
    expect(taken).toEqual({ ran: true, closed: 2, failed: 0, wrapped: false });
    expect((await cursorRow()).after_reference).toBe(ref(2));
    expect((await cursorCounts()).abandoned).toBe('1');

    // The stale runner comes back: every write is a compare-and-set on the owner, so it can do
    // nothing to the newer position.
    expect(await subscriptionsRepo.heartbeatBlockCloseCursor(workerDb, dead, 30)).toBe(false);
    expect(
      await subscriptionsRepo.advanceBlockCloseCursor(
        workerDb,
        dead,
        { blockedAtUs: '9999999999999999', reference: ref(6) },
        { closed: 4, failed: 0 },
        30,
      ),
    ).toBe(false);
    expect(await subscriptionsRepo.finishBlockClosePass(workerDb, dead, true)).toBe(false);
    expect(await subscriptionsRepo.releaseBlockCloseCursor(workerDb, dead, 0)).toBe(false);
    expect((await cursorRow()).after_reference).toBe(ref(2));
    expect((await cursorRow()).passes_completed).toBe('0');

    // The next pass resumes from the newer position and finishes the list; nothing is closed twice.
    await b.closePass({ workerDb: b.worker, appDb: b.app, config: OPEN_GATE }, 10, 1, 30);
    expect(await openCount()).toBe(0);
    const [audited] = await ownerDb.execute<{ n: number; distinct: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT entity_id)::int AS distinct
      FROM audit_events WHERE action = 'renewal_block_resolved'`);
    expect(audited).toEqual({ n: 6, distinct: 6 });
  }, 120_000);

  it('the heartbeat is worker-only and validates its input', async () => {
    const owner = '00000000-0000-4000-8000-0000000000e1';
    const code = (run: Promise<unknown>) =>
      run.then(
        () => 'ok',
        (e: { cause?: { code?: string } }) => e.cause?.code,
      );
    // 42501: insufficient privilege (the application credential cannot run it).
    expect(await code(subscriptionsRepo.heartbeatBlockCloseCursor(appDb, owner, 30))).toBe('42501');
    // 22023: an out-of-range lease is refused.
    expect(await code(subscriptionsRepo.heartbeatBlockCloseCursor(workerDb, owner, 5))).toBe(
      '22023',
    );
    // Nobody holds the lease: a heartbeat claims nothing.
    expect(await subscriptionsRepo.heartbeatBlockCloseCursor(workerDb, owner, 30)).toBe(false);
    expect((await cursorRow()).lease_owner).toBeNull();
  });
});
