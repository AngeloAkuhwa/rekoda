/**
 * G2-1 (second independent review of PR #432): one dead-job record that cannot be written no longer
 * rolls back the whole cross-tenant reclaim pass.
 *
 * Before: `reclaimStalled` wrote each record in a savepoint but re-threw a failure, so the whole
 * transaction rolled back and every business's stalled jobs stayed `running`; with a record that
 * could never be written (a poison row), the reclaim never progressed for anyone. Now the failed
 * record rolls back only its savepoint, its job stays dead without a record, and the cutover
 * enrolment pass (0225, 0229, 0236) finds and records it, with its own retry and dead-letter policy.
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
  it('reclaims every tenant; the failed record is reported and left for enrolment', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await stalledLastAttempt(a);
    await stalledLastAttempt(b);
    await poison(a);

    let unrecorded = 0;
    const reclaimed = await jobsRepo.reclaimStalled(workerDb, 300_000, {
      onUnrecorded: (n) => (unrecorded += n),
    });
    expect(reclaimed).toBe(2);
    expect(unrecorded).toBe(1);
    expect(await deadOf(a)).toBe(1);
    expect(await deadOf(b)).toBe(1);
    expect(await recordsOf(b)).toBe(1);
    expect(await recordsOf(a)).toBe(0);

    /* The death was not lost: once the cause is gone, the enrolment pass records it. */
    await unpoison();
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect(await recordsOf(a)).toBe(1);
  });
});
