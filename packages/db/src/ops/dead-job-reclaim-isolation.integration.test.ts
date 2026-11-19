/**
 * G2-1 (second independent review of PR #432): one dead-job record that cannot be written no longer
 * rolls back the whole cross-tenant reclaim pass.
 *
 * Before: `reclaimStalled` wrote each record in a savepoint but re-threw a failure, so the whole
 * transaction rolled back and every business's stalled jobs stayed `running`; with a record that
 * could never be written (a poison row), the reclaim never progressed for anyone. Now each job's
 * transition and its record share one savepoint: a job whose record fails stays `running` with
 * its expired lease and is retried on the next pass, and every other job is reclaimed. A death is
 * never committed without its record (I1: that could leave a `recovering` record stuck for good).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { jobsRepo } from '../index.js';
import {
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
  workerDb,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

/** A payment job on its last attempt whose worker stopped answering ten minutes ago. */
const stalledLastAttempt = (businessId: string) =>
  withBusiness(ownerDb, businessId, (tx) =>
    tx.execute(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts, locked_at, locked_by)
      VALUES (${businessId}::uuid, 'payment.process', '{"eventId": null}'::jsonb, 'running', 2, 1,
              now() - interval '10 minutes', 'gone-worker')`),
  );
const recordsOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM dead_job_exceptions WHERE business_id = ${businessId}::uuid`)),
  ][0]!.n;
const deadOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs WHERE business_id = ${businessId}::uuid AND state = 'dead'`)),
  ][0]!.n;

/** Every record insert for `businessId` fails. */
const poison = (businessId: string) =>
  ownerDb.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION public.test_poison_reclaim_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.business_id = '${businessId}'::uuid THEN
        RAISE EXCEPTION 'test: poison record' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_poison_reclaim_record ON dead_job_exceptions;
    CREATE TRIGGER test_poison_reclaim_record BEFORE INSERT ON dead_job_exceptions
      FOR EACH ROW EXECUTE FUNCTION public.test_poison_reclaim_record();`),
  );
const unpoison = () =>
  ownerDb.execute(
    sql.raw(`DROP TRIGGER IF EXISTS test_poison_reclaim_record ON dead_job_exceptions;
             DROP FUNCTION IF EXISTS public.test_poison_reclaim_record();`),
  );
afterEach(unpoison);

describe('G2-1: the reclaim pass survives one unwritable dead-job record', () => {
  it('reclaims every other tenant; the unwritable job stays running and is retried next pass', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await stalledLastAttempt(a);
    await stalledLastAttempt(b);
    await poison(a);

    let unrecorded = 0;
    const reclaimed = await jobsRepo.reclaimStalled(workerDb, 300_000, {
      onUnrecorded: (n) => (unrecorded += n),
    });
    expect(reclaimed).toBe(1);
    expect(unrecorded).toBe(1);
    expect(await deadOf(b)).toBe(1);
    expect(await recordsOf(b)).toBe(1);
    /* Neither half of A's death committed: no dead job without its record. */
    expect(await deadOf(a)).toBe(0);
    expect(await recordsOf(a)).toBe(0);

    /* Once the cause is gone, the next pass moves it, with its record. */
    await unpoison();
    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
    expect(await deadOf(a)).toBe(1);
    expect(await recordsOf(a)).toBe(1);
  });

  it('I1: a recovery run that crashes is reopened with its job, or not moved at all', async () => {
    const a = await seedBusiness();
    await stalledLastAttempt(a);
    const [job] = await ownerDb.execute<{ id: string }>(
      sql`SELECT id FROM jobs WHERE business_id = ${a}::uuid`,
    );
    /* An operator's recovery is in flight: the record says recovering, the run's lease expired. */
    await ownerDb.execute(sql`
      INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts, status,
                                       recovery_requested_at, recovery_requested_by, recovery_reason)
      VALUES (${job!.id}::uuid, ${a}::uuid, 'payment.process', 'stopped', 2, 'recovering', now(),
              'operator:ada', 'retry now')`);
    await ownerDb.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION public.test_poison_reclaim_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: reopen fails' USING ERRCODE = 'P0001'; END $$;
      DROP TRIGGER IF EXISTS test_poison_reclaim_record ON dead_job_exceptions;
      CREATE TRIGGER test_poison_reclaim_record BEFORE UPDATE ON dead_job_exceptions
        FOR EACH ROW EXECUTE FUNCTION public.test_poison_reclaim_record();`),
    );
    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(0);
    /* Not committed as dead behind a record still saying recovering. */
    expect(await deadOf(a)).toBe(0);
    await unpoison();
    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
    const [record] = await ownerDb.execute<{ status: string }>(sql`
      SELECT status FROM dead_job_exceptions WHERE job_id = ${job!.id}::uuid`);
    expect(record!.status).toBe('open');
    expect(await deadOf(a)).toBe(1);
  });
});
