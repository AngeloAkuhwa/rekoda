/**
 * Shared helpers for the lost-message suites (OWN-74, PR #428): deliver a message without running
 * it, and kill or back off its job by the queue's real repository paths. Split from
 * meta-lost-message.integration.test.ts so the answer-type suite can use them too.
 */
import { expect } from 'vitest';
import { jobsRepo, withBusiness, sql } from '@rekoda/db';
import { db, messagePayload, post, workerDb } from './meta-webhook.fixtures.js';

export type Death = 'markFailed' | 'reclaimStalled';

/** Deliver a message to the queue without running it, so its job can be killed. */
export async function queueOnly(wamid: string, text: string, from = '2348031234567') {
  await post(messagePayload(from, wamid, text));
}

/**
 * A test-setup statement on `jobs`, run as the business it belongs to (`withBusiness`, so RLS applies
 * as in production) rather than through the worker pool's cross-tenant reach.
 */
export function asTenant(businessId: string, statement: ReturnType<typeof sql>) {
  return withBusiness(db, businessId, (tx) => tx.execute(statement));
}

/**
 * Kill the one waiting inbound job by the real repository path. One attempt is allowed, so
 * `markFailed` ends it at once; `reclaimStalled` gives it the one extra run past the last
 * attempt, and the job dies when that run's lease expires too.
 */
export async function killInboundJob(businessId: string, death: Death) {
  await asTenant(
    businessId,
    sql`
    UPDATE jobs SET max_attempts = 1
     WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message' AND state = 'pending'`,
  );
  const runs = death === 'markFailed' ? 1 : 2;
  for (let run = 1; run <= runs; run++) {
    const job = await jobsRepo.claimNext(workerDb, `dying-worker-${run}`);
    expect(job?.kind).toBe('inbound.message');
    if (death === 'markFailed') {
      expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 0)).state).toBe('dead');
    } else {
      await asTenant(
        businessId,
        sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${job!.id}::uuid`,
      );
      expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
    }
  }
  const [row] = await withBusiness(db, businessId, (tx) =>
    jobsRepo.jobsForBusiness(tx, 'inbound.message'),
  ).then((rows) => rows.filter((r) => r.state === 'dead'));
  expect(row?.state).toBe('dead');
}

export const inboundEventsProcessed = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ processed: boolean }>(sql`
        SELECT processed_at IS NOT NULL AS processed FROM external_events
         WHERE business_id = ${businessId}::uuid AND event_type LIKE 'message.%'
         ORDER BY created_at`),
    )),
  ].map((r) => r.processed);

/** Fail the waiting inbound job's first attempt and leave it backing off for a minute. */
export async function failOnceAndBackOff(businessId: string) {
  await asTenant(
    businessId,
    sql`
    UPDATE jobs SET max_attempts = 2
     WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message' AND state = 'pending'`,
  );
  const job = await jobsRepo.claimNext(workerDb, 'failing-worker');
  expect(job?.kind).toBe('inbound.message');
  expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 60_000)).state).toBe(
    'pending',
  );
  return job!.id;
}

/**
 * Bring the backing-off job due and fail its last attempt: it dies. Any other waiting job is
 * put out of reach first, so a deferred answer whose half-second wait has passed cannot be
 * claimed in its place.
 */
export async function failLastAttempt(businessId: string, jobId: string) {
  await asTenant(
    businessId,
    sql`
    UPDATE jobs SET run_at = CASE WHEN id = ${jobId}::uuid THEN now() ELSE now() + interval '1 hour' END
     WHERE business_id = ${businessId}::uuid AND state = 'pending'`,
  );
  const job = await jobsRepo.claimNext(workerDb, 'failing-worker-2');
  expect(job?.id).toBe(jobId);
  expect((await jobsRepo.markFailed(workerDb, job!, 'handler failed', 0)).state).toBe('dead');
}

/** Make every waiting job of the business due now (a deferred answer included). */
export async function bringDue(businessId: string) {
  await asTenant(
    businessId,
    sql`
    UPDATE jobs SET run_at = now()
     WHERE business_id = ${businessId}::uuid AND state = 'pending'`,
  );
}

/** The inbound jobs of the business still waiting to run (deferred or backing off). */
export async function pendingInbound(businessId: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    jobsRepo.jobsForBusiness(tx, 'inbound.message'),
  );
  return rows.filter((r) => r.state === 'pending').length;
}
