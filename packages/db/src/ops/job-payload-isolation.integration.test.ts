/**
 * Cross-tenant payload isolation for the worker credential (owner brief, 15 Nov 2026: database-level
 * enforcement where feasible; migration 0228).
 *
 * The worker claims and coordinates every tenant's jobs (`worker_claim`, 0004), so it must see their
 * coordination columns across tenants. Until 0228 it could also read every tenant's job PAYLOAD in
 * one unpinned query: isolation rested on repository discipline (0225, the boundary rule). Since
 * 0228 the database refuses that: `rekoda_worker` holds no SELECT on `jobs.payload`, and reads a
 * payload only through `job_payload(job)`, which returns it for one job and only where that job's
 * business is the pinned tenant.
 *
 * What remains (stated, not hidden): the pin is set by the caller, and the worker process runs every
 * tenant's jobs, so a holder of the worker credential can still pin each business in turn and read
 * its jobs one at a time. What the database now enforces is that no worker statement reads a payload
 * unpinned, across tenants, or in bulk.
 *
 * Every probe runs on a live runtime connection; the owner only arranges state.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { jobsRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

async function jobWith(businessId: string, secret: string): Promise<string> {
  const row = await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind: 'inbound.message', payload: { secret } }),
  );
  return row!.id;
}
const payloadVia = (db: Db, pinned: string | null, jobId: string) => {
  const read = (tx: Db | Parameters<Parameters<typeof withBusiness>[2]>[0]) =>
    tx.execute<{ payload: unknown }>(sql`SELECT job_payload(${jobId}::uuid) AS payload`);
  return pinned === null
    ? read(db).then((rows) => [...rows][0]?.payload)
    : withBusiness(db, pinned, read).then((rows) => [...rows][0]?.payload);
};

describe('0228: the worker reads no payload across tenants', () => {
  it('ATTACK: an unpinned or a pinned direct read of jobs.payload is refused', async () => {
    const a = await seedBusiness();
    await jobWith(a, `secret-${randomUUID()}`);
    expect(await outcome(workerDb.execute(sql`SELECT payload FROM jobs`))).toMatch(
      /^42501 .*permission denied/,
    );
    expect(
      await outcome(withBusiness(workerDb, a, (tx) => tx.execute(sql`SELECT payload FROM jobs`))),
    ).toMatch(/^42501 .*permission denied/);
    for (const probe of [
      sql`SELECT to_jsonb(j) FROM jobs j`,
      sql`SELECT j.* FROM jobs j`,
      sql`SELECT payload->>'secret' FROM jobs`,
      sql`SELECT id FROM jobs WHERE payload->>'secret' IS NOT NULL`,
      sql`UPDATE jobs SET updated_at = now() WHERE state = 'pending' RETURNING payload`,
    ]) {
      expect(await outcome(workerDb.execute(probe))).toMatch(/^42501 .*permission denied/);
    }
  });

  it('still sees the coordination columns across tenants, as the claim needs', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await jobWith(a, 'x');
    await jobWith(b, 'y');
    const rows = [
      ...(await workerDb.execute<{ n: number }>(
        sql`SELECT count(DISTINCT business_id)::int AS n FROM jobs WHERE state = 'pending'`,
      )),
    ];
    expect(rows[0]!.n).toBe(2);
  });

  it('job_payload returns a payload only under its own business’s pin', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const job = await jobWith(a, 'only-for-a');
    expect(await payloadVia(workerDb, a, job)).toEqual({ secret: 'only-for-a' });
    expect(await payloadVia(workerDb, b, job)).toBeNull();
    expect(await payloadVia(workerDb, null, job)).toBeNull();
    expect(await payloadVia(workerDb, a, randomUUID())).toBeNull();
  });

  it('job_payload is the worker’s and settlement’s only; it is a pinned definer function', async () => {
    const [fn] = await ownerDb.execute<{ definer: boolean; config: string[] | null }>(sql`
      SELECT prosecdef AS definer, proconfig AS config FROM pg_proc
      WHERE oid = 'public.job_payload(uuid)'::regprocedure`);
    expect(fn!.definer).toBe(true);
    expect(fn!.config).toContain('search_path=pg_catalog, public, pg_temp');
    const a = await seedBusiness();
    const job = await jobWith(a, 'z');
    for (const db of [appDb, operatorDb]) {
      expect(await outcome(payloadVia(db, a, job))).toMatch(/^42501 .*permission denied/);
    }
    expect(await outcome(payloadVia(settlementDb, a, job))).toBe('allowed');
  });

  it('the claim still hands the runner its job with the payload, read under that job’s pin', async () => {
    const a = await seedBusiness();
    const job = await jobWith(a, 'claimed');
    const claimed = await jobsRepo.claimNext(workerDb, 'isolation-test');
    expect(claimed).toMatchObject({ id: job, businessId: a, payload: { secret: 'claimed' } });
  });

  it('a job that dies by markFailed still records its death from its payload', async () => {
    const a = await seedBusiness();
    const eventId = randomUUID();
    await withBusiness(appDb, a, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: a,
        kind: 'payment.process',
        payload: { eventId, reference: 'RKD-PAY-20261115-ABC228' },
        maxAttempts: 1,
      }),
    );
    const claimed = await jobsRepo.claimNext(workerDb, 'isolation-test');
    expect((await jobsRepo.markFailed(workerDb, claimed!, 'boom', 0)).state).toBe('dead');
    const [record] = await ownerDb.execute<{ reference: string | null }>(
      sql`SELECT reference FROM dead_job_exceptions WHERE job_id = ${claimed!.id}::uuid`,
    );
    expect(record!.reference).toBe('RKD-PAY-20261115-ABC228');
  });
});
