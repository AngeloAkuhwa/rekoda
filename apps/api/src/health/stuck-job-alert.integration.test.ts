/**
 * E-F4 (owner instruction, 18 Nov 2026): a job the reclaim cannot move pages someone, and stops
 * paging only when it genuinely moves.
 *
 * Since `8e263c5` a stalled job dies together with its dead-job record or not at all, so a payment or
 * billing job whose record cannot be written stays `running` with its expired lease, and every
 * reclaim pass retries it. Until this change that was a count in one warning line per pass: no alert,
 * no job named, nothing after a restart. Now the queue aggregate counts jobs still running a long
 * time after their lease expired (the row itself is the durable state, so the count survives
 * restarts), the alert pass raises `jobs.stuck_running` once per cooldown, and it resolves when the
 * job leaves `running`. The reclaim log names each job by id, kind and SQLSTATE.
 *
 * The fault is injected in the database: a trigger that refuses one business's dead-job records.
 * A "restart" is new pools and an empty alert memory, as a new worker process starts with.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, jobsRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { AlertState } from '@rekoda/core';
import { collectOpsSnapshot, runOpsAlertPass, type AlertNotice } from './ops-alerts.js';

let urls: Urls;
let appDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

function pool(url: string): Db {
  const { db, close } = createDb(url, { max: 4 });
  closers.push(close);
  return db;
}

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  appDb = pool(urls.app);
  ownerDb = pool(urls.owner);
});
afterAll(async () => {
  for (const close of closers) await close();
});
beforeEach(async () => {
  await truncateAll(urls);
});
afterEach(async () => {
  await ownerDb.execute(
    sql.raw(`DROP TRIGGER IF EXISTS test_refuse_dead_job_record ON dead_job_exceptions;
             DROP FUNCTION IF EXISTS public.test_refuse_dead_job_record();`),
  );
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481950000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A job past its last attempt whose process stopped answering `minutesAgo` minutes ago. */
async function stalled(businessId: string, kind: string, minutesAgo: number): Promise<string> {
  const [row] = await ownerDb.execute<{ id: string }>(sql`
    INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts, locked_at, locked_by)
    VALUES (${businessId}::uuid, ${kind}, '{"eventId": null}'::jsonb, 'running', 6, 5,
            now() - make_interval(mins => ${minutesAgo}), 'gone-process')
    RETURNING id`);
  return row!.id;
}

/** Every dead-job record for `businessId` is refused (the fault injection). */
const refuseRecordsOf = (businessId: string) =>
  ownerDb.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION public.test_refuse_dead_job_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.business_id = '${businessId}'::uuid THEN
        RAISE EXCEPTION 'test: record refused' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_refuse_dead_job_record ON dead_job_exceptions;
    CREATE TRIGGER test_refuse_dead_job_record BEFORE INSERT ON dead_job_exceptions
      FOR EACH ROW EXECUTE FUNCTION public.test_refuse_dead_job_record();`),
  );
const healRecords = () =>
  ownerDb.execute(
    sql.raw(`DROP TRIGGER IF EXISTS test_refuse_dead_job_record ON dead_job_exceptions`),
  );

const stateOf = async (jobId: string) =>
  [
    ...(await ownerDb.execute<{ state: string }>(
      sql`SELECT state FROM jobs WHERE id = ${jobId}::uuid`,
    )),
  ][0]!.state;

/** One alert pass, as the worker runs it, recording what reached the destination. */
async function pass(workerDb: Db, state: AlertState, sent: AlertNotice[], at = new Date()) {
  return runOpsAlertPass(
    {
      collect: () => collectOpsSnapshot(workerDb),
      sink: { deliver: async (notice) => void sent.push(notice) },
      log: { error: () => {}, warn: () => {} },
      build: { release: 'test', commit: 'test' },
      now: () => at,
    },
    state,
  );
}

describe('E-F4: a job the reclaim cannot move is alerted, survives restarts and resolves', () => {
  it('pages once, names the jobs in the log, survives a restart and clears when the job moves', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const paymentA = await stalled(a, 'payment.process', 20);
    const billingA = await stalled(a, 'billing.process', 20);
    const paymentB = await stalled(b, 'payment.process', 20);
    await refuseRecordsOf(a);

    const worker = pool(urls.worker);
    const settlement = pool(urls.settlement);
    const unmoved: jobsRepo.UnrecordedReclaim[] = [];
    const collect = (_n: number, jobs: jobsRepo.UnrecordedReclaim[]) => unmoved.push(...jobs);
    // The worker reclaims payment jobs, settlement its own billing jobs (0217).
    expect(await jobsRepo.reclaimStalled(worker, 300_000, { onUnrecorded: collect })).toBe(1);
    expect(await jobsRepo.reclaimStalled(settlement, 300_000, { onUnrecorded: collect })).toBe(0);
    /* Tenant isolation and progress: B's job died with its record; A's could not and stays running. */
    expect(await stateOf(paymentB)).toBe('dead');
    expect(await stateOf(paymentA)).toBe('running');
    expect(await stateOf(billingA)).toBe('running');
    expect(unmoved).toEqual(
      expect.arrayContaining([
        { jobId: paymentA, kind: 'payment.process', sqlstate: 'P0001' },
        { jobId: billingA, kind: 'billing.process', sqlstate: 'P0001' },
      ]),
    );
    expect(unmoved).toHaveLength(2);

    const health = await jobsRepo.queueHealth(worker);
    expect(health.stuckRunning).toEqual({ payment: 1, billing: 1, other: 0 });
    expect(health.oldestStuckSeconds).toBeGreaterThanOrEqual(20 * 60 - 5);

    const sent: AlertNotice[] = [];
    const t0 = new Date();
    const first = await pass(worker, {}, sent, t0);
    const stuckNotices = () => sent.filter((n) => n.key === 'jobs.stuck_running');
    expect(stuckNotices()).toHaveLength(1);
    expect(stuckNotices()[0]).toMatchObject({ kind: 'alert', severity: 'critical' });
    expect(stuckNotices()[0]!.summary).toMatch(/1 customer-payment, 1 Rekoda billing job\(s\)/);
    /* Nothing tenant-shaped leaves the process: no business, no job id. */
    for (const id of [a, b, paymentA, billingA]) expect(JSON.stringify(sent)).not.toContain(id);

    // Still stuck a minute later: no second page inside the cooldown (no alert storm).
    const second = await pass(worker, first.next, sent, new Date(t0.getTime() + 60_000));
    expect(stuckNotices()).toHaveLength(1);

    // A worker restart: new pools and no memory of what was sent. The job row is the state.
    const restarted = pool(urls.worker);
    const afterRestart = await pass(restarted, {}, sent, new Date(t0.getTime() + 120_000));
    expect(afterRestart.active.map((alert) => alert.key)).toContain('jobs.stuck_running');
    // And the reclaim keeps retrying it, pass after pass, without moving it while the fault holds.
    expect(await jobsRepo.reclaimStalled(restarted, 300_000)).toBe(0);
    expect(await stateOf(paymentA)).toBe('running');

    // The cause is repaired; the next reclaim passes move both jobs with their records.
    await healRecords();
    expect(await jobsRepo.reclaimStalled(restarted, 300_000)).toBe(1);
    expect(await jobsRepo.reclaimStalled(settlement, 300_000)).toBe(1);
    expect(await stateOf(paymentA)).toBe('dead');
    expect(await stateOf(billingA)).toBe('dead');
    const records = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM dead_job_exceptions WHERE business_id = ${a}::uuid`,
    );
    expect([...records][0]!.n).toBe(2);

    const cleared = await pass(restarted, second.next, sent, new Date(t0.getTime() + 180_000));
    expect(cleared.active.map((alert) => alert.key)).not.toContain('jobs.stuck_running');
    expect(stuckNotices().at(-1)).toMatchObject({ kind: 'resolved', key: 'jobs.stuck_running' });
    expect((await jobsRepo.queueHealth(restarted)).stuckRunning).toEqual({
      payment: 0,
      billing: 0,
      other: 0,
    });
  });

  it('does not page for a job whose lease only just expired, or for one whose process is alive', async () => {
    const a = await seedBusiness();
    await stalled(a, 'payment.process', 6); // reclaimable now, not stuck
    const alive = await stalled(a, 'billing.process', 30);
    // A live process renews its lease (`touch`): the job is running, but not stuck.
    await withBusiness(ownerDb, a, (tx) =>
      tx.execute(sql`UPDATE jobs SET locked_at = now() WHERE id = ${alive}::uuid`),
    );
    const worker = pool(urls.worker);
    expect((await jobsRepo.queueHealth(worker)).stuckRunning).toEqual({
      payment: 0,
      billing: 0,
      other: 0,
    });
    const sent: AlertNotice[] = [];
    await pass(worker, {}, sent);
    expect(sent.filter((n) => n.key === 'jobs.stuck_running')).toHaveLength(0);
  });
});
