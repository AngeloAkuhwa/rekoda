/**
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
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_cursor_advance() CASCADE`);
  await ownerDb?.execute(sql`DROP SEQUENCE IF EXISTS refuse_attempts`);
  for (const c of closers) await c();
});
beforeEach(async () => {
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

describe('the blocked-renewal close cursor is durable', () => {
  it('more than 4,000 blocks refusing the close AND the stamp never starve later blocks, with a worker restart after every pass', async () => {
    const stuck = PASS_ROWS; // exactly one full pass of double failures at the head of the list
    await seedBlocked(stuck + 150, stuck, true);
    expect(await openCount()).toBe(stuck + 150);

    // Pass 1, first process: bounded, it spends its 20 pages on the failing head and closes none.
    await (await restartedWorker()).sweep();
    expect(await openCount()).toBe(stuck + 150);
    const afterPass1 = (await cursorRow()).after_reference;

    // Pass 2, a NEW process: it resumes after the durable position, so the 150 behind the head
    // close. (The in-memory offset restarted at 0 here and closed none.)
    await (await restartedWorker()).sweep();
    expect(await openCount()).toBe(stuck);
    expect(afterPass1).toBe(ref(stuck));
    // The list was exhausted, so the cursor wrapped to the start for the next pass.
    expect((await cursorRow()).after_reference).toBeNull();
    expect((await cursorRow()).passes_completed).toBe('1');
  }, 600_000);

  it('a restart after every single batch still progresses, and the failing head is revisited after the wrap', async () => {
    await seedBlocked(8, 6, true);
    const oneBatch = { blockPageSize: 2, maxBlockPages: 1 };
    // Each pass is one batch of 2 in a brand-new process: 3 batches of failures, then the 2 healthy.
    const positions: Array<string | null> = [];
    for (let pass = 1; pass <= 3; pass += 1) {
      await (await restartedWorker()).sweep(oneBatch);
      expect(await openCount()).toBe(8);
      positions.push((await cursorRow()).after_reference);
    }
    await (await restartedWorker()).sweep(oneBatch);
    expect(await openCount()).toBe(6);
    expect(positions).toEqual([ref(2), ref(4), ref(6)]);
    expect(await attempts()).toBe(12); // 6 blocks x (close + stamp), each tried once

    // The next pass finds nothing after the cursor and wraps; the one after retries the head.
    await (await restartedWorker()).sweep(oneBatch);
    expect((await cursorRow()).after_reference).toBeNull();
    const beforeRevisit = await attempts();
    await (await restartedWorker()).sweep(oneBatch);
    expect((await attempts()) - beforeRevisit).toBe(4); // blocks 1 and 2: close + stamp each

    // Once the cause is fixed the revisits close them.
    await ownerDb.execute(sql`DROP FUNCTION refuse_block_close() CASCADE`);
    for (let pass = 0; pass < 4 && (await openCount()) > 0; pass += 1) {
      await (await restartedWorker()).sweep(oneBatch);
    }
    expect(await openCount()).toBe(0);
  }, 120_000);

  it('a crash before the cursor is saved replays that batch safely: nothing is skipped or closed twice', async () => {
    await seedBlocked(6, 0);
    // The advance is refused once (the process "died" after closing the batch, before saving).
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION refuse_cursor_advance() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'crash before the cursor was saved'; END $f$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_cursor_advance BEFORE UPDATE ON renewal_block_close_cursor
      FOR EACH ROW WHEN (NEW.after_reference IS DISTINCT FROM OLD.after_reference)
      EXECUTE FUNCTION refuse_cursor_advance()`);

    await (await restartedWorker()).sweep({ blockPageSize: 2 });
    // The batch's closes committed, but the cursor did not move and the lease was given back.
    expect(await openCount()).toBe(4);
    const crashed = await cursorRow();
    expect(crashed.after_reference).toBeNull();
    expect(crashed.lease_owner).toBeNull();

    await ownerDb.execute(sql`DROP FUNCTION refuse_cursor_advance() CASCADE`);
    await (await restartedWorker()).sweep({ blockPageSize: 2 });
    expect(await openCount()).toBe(0);
    const [audited] = await ownerDb.execute<{ n: number; distinct: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT entity_id)::int AS distinct
      FROM audit_events WHERE action = 'renewal_block_resolved'`);
    expect(audited).toEqual({ n: 6, distinct: 6 });
  }, 120_000);

  it('a pass that stops before saving still raises its alert and records the failures it saw', async () => {
    await seedBlocked(4, 2, true);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION refuse_cursor_advance() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'crash before the cursor was saved'; END $f$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_cursor_advance BEFORE UPDATE ON renewal_block_close_cursor
      FOR EACH ROW WHEN (NEW.after_reference IS DISTINCT FROM OLD.after_reference)
      EXECUTE FUNCTION refuse_cursor_advance()`);
    vi.resetModules();
    const { Logger } = await import('@nestjs/common');
    const error = vi.spyOn(Logger.prototype, 'error');
    try {
      await sweep({ blockPageSize: 10 });
      expect(
        error.mock.calls.filter(([m]) =>
          /^ALERT renewal_block_close_pass failed=2 .*stopped=true/.test(String(m)),
        ),
      ).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
    const status = await subscriptionsRepo.blockCloseCursorStatus(workerDb);
    expect(status).toMatchObject({ lastPassFailed: 2, positioned: false, leased: false });
    expect(evaluateOpsAlerts(await collectOpsSnapshot(workerDb)).map((a) => a.key)).toContain(
      'billing.renewal_block_close_failing',
    );
  }, 120_000);

  it('a pass that stops and cannot release its lease is never silent: logged, stalled alert, counts kept on takeover', async () => {
    await seedBlocked(30, 30, true);
    // The first batch saves; the second batch's advance is refused, and so is the release.
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION refuse_cursor_advance() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'database lost before the cursor was saved'; END $f$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_cursor_advance BEFORE UPDATE ON renewal_block_close_cursor
      FOR EACH ROW WHEN (NEW.after_reference = ${sql.raw(`'${ref(20)}'`)})
      EXECUTE FUNCTION refuse_cursor_advance()`);
    await ownerDb.execute(
      sql`REVOKE EXECUTE ON FUNCTION renewal_block_close_release(uuid, integer) FROM rekoda_worker`,
    );
    vi.resetModules();
    const { Logger } = await import('@nestjs/common');
    const error = vi.spyOn(Logger.prototype, 'error');
    try {
      await sweep({ blockPageSize: 10, maxBlockPages: 3 });
      const lines = error.mock.calls.map(([m]) => String(m));
      expect(
        lines.filter((m) =>
          /^ALERT renewal_block_close_release_failed unrecorded_failed=10 /.test(m),
        ),
      ).toHaveLength(1);
      expect(
        lines.filter((m) => /^ALERT renewal_block_close_pass failed=20 .*stopped=true/.test(m)),
      ).toHaveLength(1);
    } finally {
      error.mockRestore();
      await ownerDb.execute(
        sql`GRANT EXECUTE ON FUNCTION renewal_block_close_release(uuid, integer) TO rekoda_worker`,
      );
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_cursor_advance() CASCADE`);
    }
    // The saved batch stands; the lease was never given back.
    expect((await cursorRow()).after_reference).toBe(ref(10));
    expect((await cursorRow()).lease_owner).not.toBeNull();

    // Once the lease expires unreleased, the ops alert says the pass stalled.
    await ownerDb.execute(sql`
      UPDATE renewal_block_close_cursor SET lease_expires_at = clock_timestamp() - interval '1 second'`);
    expect(await subscriptionsRepo.blockCloseCursorStatus(workerDb)).toMatchObject({
      abandoned: true,
      leased: false,
    });
    expect(evaluateOpsAlerts(await collectOpsSnapshot(workerDb)).map((a) => a.key)).toContain(
      'billing.renewal_block_close_stalled',
    );

    // A new runner takes over: the abandoned pass's saved failures reach the failing alert instead
    // of being wiped, and the unsaved batch is replayed from the saved position.
    const next = await restartedWorker();
    expect(await subscriptionsRepo.claimBlockCloseCursor(next.worker, randomUUID(), 60)).toBe(true);
    const taken = await subscriptionsRepo.blockCloseCursorStatus(workerDb);
    expect(taken).toMatchObject({ abandoned: false, passesAbandoned: 1, lastPassFailed: 10 });
    const keys = evaluateOpsAlerts(await collectOpsSnapshot(workerDb)).map((a) => a.key);
    expect(keys).toContain('billing.renewal_block_close_failing');
    // The takeover cleared the expired lease, but the stalled alert stays on for a day after it, so
    // an alert pass that runs after the takeover still sees it (Qodo, PR #432).
    expect(keys).toContain('billing.renewal_block_close_stalled');
    await ownerDb.execute(sql`
      UPDATE renewal_block_close_cursor SET last_abandoned_at = clock_timestamp() - interval '25 hours'`);
    expect(evaluateOpsAlerts(await collectOpsSnapshot(workerDb)).map((a) => a.key)).not.toContain(
      'billing.renewal_block_close_stalled',
    );
    await ownerDb.execute(
      sql`UPDATE renewal_block_close_cursor SET lease_owner = NULL, lease_expires_at = NULL`,
    );
    await next.closePass({ workerDb: next.worker, appDb: next.app, config: OPEN_GATE }, 10, 1, 60);
    expect((await cursorRow()).after_reference).toBe(ref(20));
  }, 120_000);

  it('blocks sharing a block time, or a microsecond apart, are each reached once across restarts', async () => {
    await seedBlocked(6, 0);
    // Three blocks at the same instant (the reference breaks the tie), two a microsecond apart.
    await ownerDb.execute(sql`
      UPDATE subscription_charges SET blocked_at = CASE
        WHEN reference IN (${ref(1)}, ${ref(2)}, ${ref(3)}) THEN timestamptz '2026-11-08 10:00:00.000001+00'
        WHEN reference = ${ref(4)} THEN timestamptz '2026-11-08 10:00:00.000002+00'
        WHEN reference = ${ref(5)} THEN timestamptz '2026-11-08 10:00:00.000003+00'
        ELSE timestamptz '2026-11-08 10:00:01+00' END`);
    // One batch of two per pass, on a new worker each time: 6 -> 4 -> 2 -> 0, nothing skipped.
    for (const left of [4, 2, 0]) {
      const w = await restartedWorker();
      await w.closePass({ workerDb: w.worker, appDb: w.app, config: OPEN_GATE }, 2, 1);
      expect(await openCount()).toBe(left);
    }
  }, 120_000);

  it('the ops alert stays on across clean windows until a whole cycle runs clean', async () => {
    await seedBlocked(30, 10);
    const failing = async () =>
      evaluateOpsAlerts(await collectOpsSnapshot(workerDb))
        .map((a) => a.key)
        .includes('billing.renewal_block_close_failing');
    const pass = () => closeOnce({ workerDb, appDb, config: OPEN_GATE }, 10, 1);
    // Cycle 1: a failing window, two clean windows, then the wrap. On throughout.
    for (let i = 0; i < 4; i += 1) {
      await pass();
      expect(await failing()).toBe(true);
    }
    // The failing blocks are fixed: the next pass closes them, but the cycle is not over yet.
    await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_block_close() CASCADE`);
    await pass();
    expect(await openCount()).toBe(0);
    expect(await failing()).toBe(true);
    // The wrap ends a clean cycle: off.
    await pass();
    expect(await failing()).toBe(false);
  }, 120_000);

  it('a batch that cannot be listed does not move the cursor or reset it', async () => {
    await seedBlocked(6, 6);
    await sweep({ blockPageSize: 2, maxBlockPages: 1 });
    const before = await cursorRow();
    expect(before.after_reference).toBe(ref(2));

    await ownerDb.execute(
      sql`REVOKE EXECUTE ON FUNCTION blocked_renewals_close_batch(integer) FROM rekoda_worker`,
    );
    try {
      await sweep({ blockPageSize: 2, maxBlockPages: 1 });
    } finally {
      await ownerDb.execute(
        sql`GRANT EXECUTE ON FUNCTION blocked_renewals_close_batch(integer) TO rekoda_worker`,
      );
    }
    const after = await cursorRow();
    expect(after.after_reference).toBe(before.after_reference);
    expect(after.after_us).toBe(before.after_us);
    expect(after.lease_owner).toBeNull();
  }, 120_000);

  it('blocks leaving the eligible set, including the one the cursor points at, skip nothing', async () => {
    await seedBlocked(8, 1);
    await sweep({ blockPageSize: 2, maxBlockPages: 1 });
    // Block 1 failed, block 2 closed: the cursor's own key is no longer an open block.
    expect((await cursorRow()).after_reference).toBe(ref(2));
    // Block 3 is closed by an operator meanwhile.
    await ownerDb.execute(sql`
      UPDATE subscription_charges SET blocked_resolved_at = now(), blocked_resolved_by = 'operator:t',
        blocked_resolution = 'closed by hand'
      WHERE reference = ${ref(3)}`);
    // The next batch is the two blocks after the cursor that are still open: 4 and 5.
    await sweep({ blockPageSize: 2, maxBlockPages: 1 });
    expect((await cursorRow()).after_reference).toBe(ref(5));
    await sweep({ blockPageSize: 2 });
    // Everything healthy is closed; only block 1 (still failing) remains.
    const [open] = await ownerDb.execute<{ refs: string[] }>(sql`
      SELECT coalesce(array_agg(reference ORDER BY reference), '{}') AS refs FROM subscription_charges
      WHERE blocked_at IS NOT NULL AND blocked_resolved_at IS NULL`);
    expect(open!.refs).toEqual([ref(1)]);
  }, 120_000);

  it('blocks raised while the sweep is under way are reached, before or after the cursor', async () => {
    await seedBlocked(6, 2);
    await sweep({ blockPageSize: 2, maxBlockPages: 1 }); // cursor at block 2
    const user = await identity.upsertUserByPhone(appDb, '+2348194000002');
    await ownerDb.execute(sql`
      WITH b AS (
        INSERT INTO businesses (name, owner_user_id)
        SELECT 'Late ' || g, ${user.id}::uuid FROM generate_series(1, 2) g RETURNING id)
      INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, status, reference, period_start, period_end,
         blocked_at, blocked_reason, quantity)
      SELECT b.id, 'renewal', 'chat', 1000, 'pending', 'RKD-SUB-LATE-' || row_number() OVER (),
             now() - interval '1 day', now() + interval '29 days',
             -- one key BEFORE the cursor (found after the wrap), one AFTER it (found this pass)
             CASE WHEN row_number() OVER () = 1 THEN now() - interval '2 hours' ELSE now() END,
             'awaiting_platform_confirmation', 1
      FROM b`);
    for (let pass = 0; pass < 6; pass += 1) {
      await sweep({ blockPageSize: 2, maxBlockPages: 1 });
    }
    const [late] = await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM subscription_charges
      WHERE reference LIKE 'RKD-SUB-LATE-%' AND blocked_resolved_at IS NULL`);
    expect(late!.n).toBe(0);
    expect(await openCount()).toBe(2); // only the two failing blocks
  }, 120_000);

  it('two runners cannot race the cursor: one holds the lease, a stale holder cannot write', async () => {
    await seedBlocked(6, 0);
    const other = '00000000-0000-4000-8000-000000000001';
    // Another runner holds a live lease: this pass does nothing.
    expect(await subscriptionsRepo.claimBlockCloseCursor(workerDb, other, 600)).toBe(true);
    const a = await restartedWorker();
    const skipped = await a.closePass({ workerDb: a.worker, appDb: a.app, config: OPEN_GATE }, 2);
    expect(skipped.ran).toBe(false);
    expect(await openCount()).toBe(6);

    // The other runner died: its lease expires and the next pass takes over.
    await ownerDb.execute(
      sql`UPDATE renewal_block_close_cursor SET lease_expires_at = now() - interval '1 second'`,
    );
    const taken = await a.closePass({ workerDb: a.worker, appDb: a.app, config: OPEN_GATE }, 2, 1);
    expect(taken.ran).toBe(true);
    const positioned = await cursorRow();
    expect(positioned.after_reference).toBe(ref(2));

    // The dead runner comes back: it cannot move the cursor any more.
    expect(
      await subscriptionsRepo.advanceBlockCloseCursor(
        workerDb,
        other,
        { blockedAtUs: '1', reference: ref(6) },
        { closed: 0, failed: 0 },
        600,
      ),
    ).toBe(false);
    expect(await subscriptionsRepo.finishBlockClosePass(workerDb, other, true)).toBe(false);
    expect((await cursorRow()).after_reference).toBe(ref(2));
  }, 120_000);

  it('concurrent sweeps close every block exactly once and audit each once', async () => {
    await seedBlocked(300, 0);
    const [x, y] = [await restartedWorker(), await restartedWorker()];
    await Promise.all([
      x.sweep({ blockPageSize: 50 }),
      y.sweep({ blockPageSize: 50 }),
      sweep({ blockPageSize: 50 }),
    ]);
    // A runner that found the lease held skipped its pass; one more pass picks up anything left.
    if ((await openCount()) > 0) await sweep({ blockPageSize: 50 });
    expect(await openCount()).toBe(0);
    const [audited] = await ownerDb.execute<{ n: number; distinct: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT entity_id)::int AS distinct
      FROM audit_events WHERE action = 'renewal_block_resolved'`);
    expect(audited).toEqual({ n: 300, distinct: 300 });
    expect((await cursorRow()).lease_owner).toBeNull();
  }, 120_000);

  it('an empty sweep and a clean pass each complete and wrap', async () => {
    await sweep();
    let row = await cursorRow();
    expect(row.after_reference).toBeNull();
    expect(row.passes_completed).toBe('1');

    await seedBlocked(5, 0);
    await sweep();
    expect(await openCount()).toBe(0);
    row = await cursorRow();
    expect(row.after_reference).toBeNull();
    expect(row.passes_completed).toBe('2');
    const status = await subscriptionsRepo.blockCloseCursorStatus(workerDb);
    expect(status).toMatchObject({ lastPassClosed: 5, lastPassFailed: 0, leased: false });
  }, 120_000);

  it('every affected pass warns per block, raises the pass alert, and keeps the ops alert active until it clears', async () => {
    await seedBlocked(4, 2, true);
    /* The sweep module may have been re-imported by a restart test; spy on the Logger class the
     * freshly loaded module will use. */
    vi.resetModules();
    const { Logger } = await import('@nestjs/common');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');
    try {
      for (let pass = 1; pass <= 2; pass += 1) {
        warn.mockClear();
        error.mockClear();
        await sweep({ blockPageSize: 10 });
        const failures = warn.mock.calls.filter(([m]) =>
          String(m).startsWith('renewal_block_close_failed'),
        );
        expect(failures.map(([m]) => String(m).match(/reference=(\S+)/)?.[1])).toEqual([
          ref(1),
          ref(2),
        ]);
        for (const [m] of failures) {
          expect(String(m)).toMatch(
            /business=[0-9a-f-]{36} reference=\S+ reason=\S+ stamped=false/,
          );
        }
        expect(
          error.mock.calls.filter(([m]) => String(m).startsWith('ALERT renewal_block_close_pass')),
        ).toHaveLength(1);
        const snapshot = await collectOpsSnapshot(workerDb);
        expect(snapshot.billing?.blockCloseFailed).toBe(2);
        expect(evaluateOpsAlerts(snapshot).map((a) => a.key)).toContain(
          'billing.renewal_block_close_failing',
        );
      }
      await ownerDb.execute(sql`DROP FUNCTION refuse_block_close() CASCADE`);
      error.mockClear();
      await sweep({ blockPageSize: 10 });
      expect(await openCount()).toBe(0);
      expect(
        error.mock.calls.filter(([m]) => String(m).startsWith('ALERT renewal_block_close_pass')),
      ).toHaveLength(0);
      const cleared = await collectOpsSnapshot(workerDb);
      expect(cleared.billing?.blockCloseFailed).toBe(0);
      expect(evaluateOpsAlerts(cleared).map((a) => a.key)).not.toContain(
        'billing.renewal_block_close_failing',
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 120_000);

  it('a full pass of failing blocks never stands in the way of the sweep returning', async () => {
    await seedBlocked(10, 10);
    const result = (await sweep()) as { raised: number; skipped: number };
    expect(result).toEqual({ raised: 0, skipped: 0 });
    expect(await openCount()).toBe(10);
  }, 120_000);
});
