/**
 * OWN-73 and OWN-76 (PR B items 2 and 3): a payment or billing job that dies leaves a record.
 *
 * The acceptance criteria (REKODA_LAUNCH_READINESS.md G-122 item 7), at the repository:
 *   (a) on the transition to `dead`, by either path, a merchant exception (payment jobs only;
 *       a billing job is never a merchant reconciliation exception) and an operator item;
 *   (b) idempotent: a repeated pass or a retry writes neither twice;
 *   (c) business id, job id, failure category, timestamps, a safe summary;
 *   (d) no error text and no payload copied;
 *   (e) an audit event;
 *   (f) nothing booked;
 *   (g) the ordinary failure, the worker crash, duplicates, record creation, business isolation.
 * And the recovery primitives: one bounded attempt, a second death reopens the SAME record, a
 * finished recovery closes it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { deadJobsRepo, events, identity, jobsRepo, settleRepo } from '../index.js';
import {
  migrate,
  requireUrls,
  settlementDb,
  storedEventId,
  truncateAll,
  type Urls,
  ownerDb,
} from '../testing.js';

/** Every job of the business, dead: as the owner (0220: the application may not kill a job). */
const stageDeadJobs = (businessId: string) =>
  withBusiness(ownerDb(), businessId, (tx) =>
    tx.execute(sql`UPDATE jobs SET state = 'dead', attempts = 2`),
  );
let urls: Urls;
let appDb: Db;
let workerDb: Db;

/** The operator's generic resolve: found on the worker credential, written on the application
 * credential under the event's own business (migration 0204). True when it resolved. */
const operatorResolve = (id: string, resolution: string, actor: string): Promise<boolean> =>
  events
    .resolveExceptionAsOperator(appDb, workerDb, id, resolution, actor)
    .then((outcome) => outcome === 'resolved');
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480500000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

let externalSeq = 0;
/** An attributed Paystack event, as the pump leaves it before its job runs. */
async function attributedEvent(businessId: string): Promise<string> {
  externalSeq += 1;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: `dead-${externalSeq}:charge.success`,
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const id = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, id, businessId)).toBe(true);
  return id;
}

async function enqueue(
  businessId: string,
  kind: string,
  payload: Record<string, unknown>,
  maxAttempts = 2,
): Promise<void> {
  await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload, maxAttempts }),
  );
}

/** Fail every attempt through the handler path until the job is dead. A settlement job
 * (`billing.process`) is claimed and failed on the settlement credential, the only one the
 * database lets run it (migration 0217); every other kind on the worker's. */
async function killByHandler(times: number, error = 'boom'): Promise<string> {
  let id = '';
  for (let i = 0; i < times; i++) {
    const general = await jobsRepo.claimNext(workerDb, `w-${i}`, {
      except: jobsRepo.SETTLEMENT_JOB_KINDS,
    });
    const queue = general ? workerDb : settlementDb();
    const job =
      general ??
      (await jobsRepo.claimNext(queue, `s-${i}`, { only: jobsRepo.SETTLEMENT_JOB_KINDS }));
    expect(job).not.toBeNull();
    id = job!.id;
    await jobsRepo.markFailed(queue, job!, error, 0);
  }
  return id;
}

/** Kill the worker on every attempt: only the reclaim sees it. */
async function killByCrash(businessId: string, runs: number): Promise<string> {
  let id = '';
  for (let i = 0; i < runs; i++) {
    const job = await jobsRepo.claimNext(workerDb, `crash-${i}`);
    expect(job).not.toBeNull();
    id = job!.id;
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${id}::uuid`,
      ),
    );
    expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(1);
  }
  return id;
}

const recordsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<Record<string, unknown>>(
      sql`SELECT * FROM dead_job_exceptions WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => [...rows]);

const merchantExceptions = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 50 }),
  );

const auditOf = (businessId: string, jobId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ action: string; actor: string }>(sql`
      SELECT action, actor FROM audit_events
      WHERE business_id = ${businessId}::uuid AND entity = 'job' AND entity_id = ${jobId}
      ORDER BY created_at`),
  ).then((rows) => [...rows]);

const eventRow = async (id: string) =>
  [
    ...(await workerDb.execute<{ error: string | null; processed_at: string | null }>(
      sql`SELECT error, processed_at FROM external_events WHERE id = ${id}::uuid`,
    )),
  ][0];

/** Rows that would mean something was booked. All must stay zero. */
const bookedCounts = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ payments: number; ledger: number; charges: number }>(sql`
      SELECT (SELECT count(*) FROM payments)::int AS payments,
             (SELECT count(*) FROM ledger_transactions)::int AS ledger,
             (SELECT count(*) FROM subscription_charges WHERE status <> 'pending')::int AS charges`),
  ).then((rows) => [...rows][0]);

describe('a payment job that dies by its handler failing (markFailed)', () => {
  it('writes the operator record, the merchant exception, the event flag and an audit event', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });

    const jobId = await killByHandler(2);

    const records = await recordsOf(businessId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      job_id: jobId,
      business_id: businessId,
      kind: 'payment.process',
      event_id: eventId,
      status: 'open',
      failure_category: 'handler_error',
      attempts: 2,
      death_count: 1,
    });
    expect(records[0]!['opened_at']).toBeTruthy();

    const exceptions = await merchantExceptions(businessId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ reason: 'payment_processing_stopped', resolvedAt: null });

    // Flagged for the operator, and still unprocessed, so it stays recoverable.
    expect(await eventRow(eventId)).toMatchObject({
      error: 'payment_job_dead',
      processed_at: null,
    });
    expect((await auditOf(businessId, jobId)).map((a) => a.action)).toEqual([
      'dead_job_exception_opened',
    ]);
    expect(await bookedCounts(businessId)).toEqual({ payments: 0, ledger: 0, charges: 0 });
  });

  it('copies no error text and no payload into the record', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId, secret: 'payload-detail-xyz' });
    const fakeKey = ['sk', 'live', 'q'.repeat(24)].join('_');
    await killByHandler(2, `provider said ${fakeKey} for +2348050000001`);

    const raw = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ row: string }>(
        sql`SELECT row_to_json(d)::text AS row FROM dead_job_exceptions d`,
      ),
    );
    expect([...raw][0]?.row).not.toMatch(/sk_live_|provider said|2348050000001|payload-detail/);
    const audit = await workerDb.execute<{ row: string }>(
      sql`SELECT row_to_json(a)::text AS row FROM audit_events a WHERE entity = 'job'`,
    );
    for (const row of audit) expect(row.row).not.toMatch(/sk_live_|provider said|payload-detail/);
  });
});

describe('a payment job whose worker dies on every attempt (reclaimStalled)', () => {
  it('writes the same record when the reclaim sends it to dead, and nothing before that', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });

    // Attempts 1 and 2 are reclaimed to pending: no record yet.
    await killByCrash(businessId, 2);
    expect(await recordsOf(businessId)).toHaveLength(0);

    // The run past the last attempt dies too: dead, and the record.
    const jobId = await killByCrash(businessId, 1);
    const records = await recordsOf(businessId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      job_id: jobId,
      status: 'open',
      failure_category: 'lease_expired',
      attempts: 3,
    });
    expect(await merchantExceptions(businessId)).toHaveLength(1);
    expect((await eventRow(eventId))?.error).toBe('payment_job_dead');
  });

  it('a repeated reclaim pass after the death writes nothing twice', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    const jobId = await killByCrash(businessId, 3);

    expect(await jobsRepo.reclaimStalled(workerDb, 0)).toBe(0);
    await jobsRepo.reclaimStalled(workerDb, 300_000);

    expect(await recordsOf(businessId)).toHaveLength(1);
    expect(await merchantExceptions(businessId)).toHaveLength(1);
    expect(await auditOf(businessId, jobId)).toHaveLength(1);
  });

  it('records one dead job per tenant in a single cross-tenant reclaim pass', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await enqueue(a, 'payment.process', { eventId: await attributedEvent(a) }, 1);
    await enqueue(b, 'payment.process', { eventId: await attributedEvent(b) }, 1);
    for (let i = 0; i < 2; i++) {
      for (const _ of [a, b]) {
        const job = await jobsRepo.claimNext(workerDb, `x-${i}`);
        expect(job).not.toBeNull();
      }
      await workerDb.execute(
        sql`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE state = 'running'`,
      );
      expect(await jobsRepo.reclaimStalled(workerDb, 300_000)).toBe(2);
    }
    expect(await recordsOf(a)).toHaveLength(1);
    expect(await recordsOf(b)).toHaveLength(1);
    expect((await recordsOf(a))[0]!['business_id']).toBe(a);
    expect((await recordsOf(b))[0]!['business_id']).toBe(b);
  });
});

describe('what a dead job leaves, by kind and by payload', () => {
  it('a job with no eventId still gets its own job-keyed record, and no event is touched', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'payment.process', {});
    const jobId = await killByHandler(2);

    const records = await recordsOf(businessId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ job_id: jobId, event_id: null, status: 'open' });
    const queue = await deadJobsRepo.opsQueue(workerDb);
    expect(queue.map((r) => [r.jobId, r.eventId])).toEqual([[jobId, null]]);
  });

  it('a malformed eventId is treated as none, and the death is still recorded', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'payment.process', { eventId: "x'; DROP TABLE jobs; --" });
    await killByHandler(2);
    expect((await recordsOf(businessId))[0]).toMatchObject({ event_id: null });
  });

  it('an event of another business is never bound: no event_id, and that event is not flagged', async () => {
    const businessId = await seedBusiness();
    const foreign = await attributedEvent(await seedBusiness());
    await enqueue(businessId, 'payment.process', { eventId: foreign });
    await killByHandler(2);
    expect((await recordsOf(businessId))[0]).toMatchObject({ event_id: null });
    expect((await eventRow(foreign))?.error).toBeNull();
  });

  it('a death with no record (pre-0194, or an old worker) is enrolled once by the sweep', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    // As the old code left it: dead, with no record.
    await stageDeadJobs(businessId);
    expect(await recordsOf(businessId)).toHaveLength(0);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(0);
    expect((await recordsOf(businessId))[0]).toMatchObject({ event_id: eventId, status: 'open' });
    expect(await merchantExceptions(businessId)).toHaveLength(1);
    expect((await eventRow(eventId))?.error).toBe('payment_job_dead');
  });

  it('an event behind an open dead job cannot be resolved directly, even by a stale caller', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    await killByHandler(2);
    expect(await operatorResolve(eventId, 'not ours', 'operator:bob')).toBe(false);
    expect((await eventRow(eventId))?.processed_at).toBeNull();
  });

  it('enrolment skips a death whose event an operator already resolved, and lists event-less ones first', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    await enqueue(businessId, 'billing.process', {});
    await stageDeadJobs(businessId);
    expect(await operatorResolve(eventId, 'settled by hand', 'operator:bob')).toBe(true);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect((await recordsOf(businessId)).map((r) => r['event_id'])).toEqual([null]);
    expect(await merchantExceptions(businessId)).toHaveLength(0);
  });

  it('another business resolving its own event never hides this business’s dead job from enrolment', async () => {
    const businessId = await seedBusiness();
    const foreign = await attributedEvent(await seedBusiness());
    expect(await operatorResolve(foreign, 'theirs', 'operator:bob')).toBe(true);
    await enqueue(businessId, 'payment.process', { eventId: foreign });
    await stageDeadJobs(businessId);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect((await recordsOf(businessId))[0]).toMatchObject({ event_id: null, status: 'open' });
  });

  it('the event-less list is filtered in SQL, so older event-bound records cannot crowd it out', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'payment.process', { eventId: await attributedEvent(businessId) });
    await killByHandler(2);
    await enqueue(businessId, 'payment.process', {});
    await killByHandler(2);
    const page = await deadJobsRepo.opsQueue(workerDb, 1, undefined, true);
    expect(page.map((d) => d.eventId)).toEqual([null]);
  });

  it('a billing job gets the operator record and event flag but NEVER a merchant reconciliation exception', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'billing.process', { eventId });
    await killByHandler(2);

    expect((await recordsOf(businessId))[0]).toMatchObject({
      kind: 'billing.process',
      status: 'open',
    });
    expect(await merchantExceptions(businessId)).toHaveLength(0);
    expect((await eventRow(eventId))?.error).toBe('billing_job_dead');
  });

  it('a job of any other kind dies exactly as before, with no record', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'inbound.message', {});
    await killByHandler(2);
    expect(await recordsOf(businessId)).toHaveLength(0);
    expect(await merchantExceptions(businessId)).toHaveLength(0);
  });

  it('a job that fails but is not exhausted leaves no record', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'payment.process', { eventId: await attributedEvent(businessId) });
    await killByHandler(1);
    expect(await recordsOf(businessId)).toHaveLength(0);
  });
});

describe('the operator queue and tenant isolation', () => {
  it('a flagged event carries its dead job id; another business sees none of it', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const eventId = await attributedEvent(a);
    await enqueue(a, 'payment.process', { eventId });
    const jobId = await killByHandler(2);

    const queue = await events.exceptionQueue(workerDb);
    expect(queue.flagged.find((row) => row.id === eventId)?.jobId).toBe(jobId);
    expect((await deadJobsRepo.opsQueue(workerDb)).map((r) => r.eventId)).toEqual([eventId]);

    expect(await recordsOf(b)).toHaveLength(0);
    expect(await merchantExceptions(b)).toHaveLength(0);
    // Pinned to B, A's record is invisible even by its id.
    const seen = await withBusiness(appDb, b, (tx) =>
      tx.execute(sql`SELECT 1 FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`),
    );
    expect([...seen]).toHaveLength(0);
  });

  it('the application role cannot write a record or delete one', async () => {
    const businessId = await seedBusiness();
    await enqueue(businessId, 'payment.process', {});
    const jobId = await killByHandler(2);
    const denied = (run: Promise<unknown>) =>
      run.then(
        () => 'allowed',
        (error: { cause?: { message?: string } }) => String(error.cause?.message),
      );
    expect(
      await denied(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`DELETE FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await denied(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`UPDATE dead_job_exceptions SET business_id = business_id`),
        ),
      ),
    ).toMatch(/permission denied/);
  });
});

describe('recovery: one bounded attempt, verified by the caller', () => {
  async function deadPaymentJob(businessId: string) {
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    const jobId = await killByHandler(2);
    return { eventId, jobId };
  }
  const begin = (businessId: string, jobId: string) =>
    withBusiness(appDb, businessId, (tx) =>
      deadJobsRepo.beginRecovery(tx, {
        businessId,
        jobId,
        actor: 'operator:alice',
        reason: 'Paystack shows it paid',
        reference: 'RKD-PAY-TEST',
        verification: 'found:success',
      }),
    );

  it('requeues the dead job for exactly one more attempt, and only once', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);

    expect(await begin(businessId, jobId)).toBe(true);
    expect(await begin(businessId, jobId)).toBe(false);
    expect((await recordsOf(businessId))[0]).toMatchObject({
      status: 'recovering',
      recovery_requested_by: 'operator:alice',
      recovery_reference: 'RKD-PAY-TEST',
    });

    const again = await jobsRepo.claimNext(workerDb, 'recovery');
    expect(again?.id).toBe(jobId);
    expect(again?.attempts).toBe(again?.maxAttempts);
  });

  it('a second death reopens the SAME record and raises one fresh merchant exception at most', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    expect(await begin(businessId, jobId)).toBe(true);

    await killByHandler(1);

    const records = await recordsOf(businessId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ job_id: jobId, status: 'open', death_count: 2 });
    // The merchant's exception was still open: no second one.
    expect(await merchantExceptions(businessId)).toHaveLength(1);
    // And it does not run again by itself.
    expect(await jobsRepo.claimNext(workerDb, 'nobody')).toBeNull();
    expect((await auditOf(businessId, jobId)).map((a) => a.action)).toEqual([
      'dead_job_exception_opened',
      'dead_job_recovery_started',
      'dead_job_exception_reopened',
    ]);
  });

  it('a recovery attempt whose worker crashes is not run again: dead, record reopened', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    expect(await begin(businessId, jobId)).toBe(true);

    await killByCrash(businessId, 1);

    expect((await recordsOf(businessId))[0]).toMatchObject({ status: 'open', death_count: 2 });
    expect(await jobsRepo.claimNext(workerDb, 'nobody')).toBeNull();
  });

  it('a stale enrolment never reopens a record a recovery has moved on', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    expect(await begin(businessId, jobId)).toBe(true);
    // A pass that read the job as dead and unrecorded before the recovery began.
    await workerDb.transaction((tx) =>
      deadJobsRepo.recordDeath(
        tx,
        {
          id: jobId,
          businessId,
          kind: 'payment.process',
          payload: {},
          attempts: 2,
          failureCategory: null,
        },
        { enrolOnly: true },
      ),
    );
    expect((await recordsOf(businessId))[0]).toMatchObject({
      status: 'recovering',
      death_count: 1,
    });
  });

  it('a merchant who dismissed the exception sees a fresh one when the job dies again', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    const [first] = await merchantExceptions(businessId);
    await withBusiness(appDb, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, first!.id, 'user:owner'),
    );
    expect(await begin(businessId, jobId)).toBe(true);
    await killByHandler(1);

    const exceptions = await merchantExceptions(businessId);
    expect(exceptions).toHaveLength(2);
    expect(exceptions.filter((e) => e.resolvedAt === null)).toHaveLength(1);
  });

  it('a finished recovery closes the record and the merchant exception, in the job commit', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    expect(await begin(businessId, jobId)).toBe(true);
    const job = await jobsRepo.claimNext(workerDb, 'recovery');
    await withBusiness(appDb, businessId, (tx) => jobsRepo.markDone(tx, job!.id, 'recovery'));

    expect((await recordsOf(businessId))[0]).toMatchObject({ status: 'recovered' });
    const exceptions = await merchantExceptions(businessId);
    expect(exceptions[0]?.resolvedAt).not.toBeNull();
  });

  it('an operator may close an open record instead; a recovery after that is refused', async () => {
    const businessId = await seedBusiness();
    const { jobId } = await deadPaymentJob(businessId);
    const closed = await withBusiness(appDb, businessId, (tx) =>
      deadJobsRepo.resolveByOperator(tx, {
        businessId,
        jobId,
        actor: 'operator:bob',
        resolution: 'settled by hand',
      }),
    );
    expect(closed).toBe(true);
    expect(await begin(businessId, jobId)).toBe(false);
    expect((await merchantExceptions(businessId))[0]?.resolvedAt).not.toBeNull();
  });

  it('another business cannot start a recovery of this job', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const { jobId } = await deadPaymentJob(a);
    expect(await begin(b, jobId)).toBe(false);
    expect((await recordsOf(a))[0]).toMatchObject({ status: 'open' });
  });
});
