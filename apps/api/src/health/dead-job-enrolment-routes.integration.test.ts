/**
 * The operator routes for the enrolment dead letters (migration 0229): the list (`ops:read`) and
 * the requeue (`ops:payment`). A candidate whose record could not be written after five attempts is
 * listed by its ids and attempts only; a requeue puts it back in line under its own business, is
 * audited with the verified operator, and never duplicates a record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, jobsRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { OperatorRequest } from '../auth/operator.guard.js';
import { loadConfig } from '../config.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import { DeadJobRecoveryService } from './dead-job-recovery.service.js';
import { DeadJobsController } from './dead-jobs.controller.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 2 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  await ownerDb.execute(sql`DROP TRIGGER IF EXISTS test_poison_route ON dead_job_exceptions`);
  for (const close of closers) await close();
});
beforeEach(async () => {
  await truncateAll(urls);
});

const config = () =>
  loadConfig({
    ...process.env,
    DATABASE_URL: urls.app,
    OTP_PEPPER: 'p'.repeat(40),
    REKODA_API_SECRET: 's'.repeat(40),
    VAULT_KEY: 'a'.repeat(64),
    MATCH_KEY: 'b'.repeat(64),
  });
const controller = (worker: Db | null = workerDb) =>
  new DeadJobsController(
    new DeadJobRecoveryService(config(), appDb, worker, {} as PaymentProviderPort),
  );
const asOperator = { operator: { subject: 'alice@rekoda.app' } } as unknown as OperatorRequest;

let phoneSeq = 0;
async function deadLettered(): Promise<{ businessId: string; jobId: string }> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+2348060000${String(phoneSeq).padStart(3, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const rows = await withBusiness(ownerDb, business.id, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts)
      VALUES (${business.id}::uuid, 'payment.process', jsonb_build_object('eventId', gen_random_uuid()),
              'dead', 2, 2) RETURNING id`),
  );
  const jobId = [...rows][0]!.id;
  await ownerDb.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION public.test_poison_route() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test: poison' USING ERRCODE = 'P0001'; END $$;
    DROP TRIGGER IF EXISTS test_poison_route ON dead_job_exceptions;
    CREATE TRIGGER test_poison_route BEFORE INSERT ON dead_job_exceptions
      FOR EACH ROW EXECUTE FUNCTION public.test_poison_route();`),
  );
  for (let i = 0; i < 5; i += 1) {
    await jobsRepo.enrolUnrecordedDeaths(workerDb).catch(() => undefined);
    await ownerDb.execute(sql`UPDATE dead_job_enrolment_failures
      SET next_attempt_at = now() - interval '1 second' WHERE job_id = ${jobId}::uuid`);
  }
  await ownerDb.execute(sql`DROP TRIGGER test_poison_route ON dead_job_exceptions`);
  return { businessId: business.id, jobId };
}

describe('the enrolment dead-letter routes (0229)', () => {
  it('lists a dead-lettered candidate by its ids and attempts, and nothing of its payload', async () => {
    const { businessId, jobId } = await deadLettered();
    const listed = await controller().enrolmentFailures();
    expect(listed.items).toEqual([
      {
        jobId,
        businessId,
        kind: 'payment.process',
        attempts: 5,
        lastSqlstate: 'P0001',
        lastFailedAt: expect.any(String),
        deadLetteredAt: expect.any(String),
        requeueCount: 0,
      },
    ]);
  });

  it('requeues once, audited with the verified operator; the candidate then enrols once', async () => {
    const { businessId, jobId } = await deadLettered();
    expect(
      await controller().requeueEnrolment(asOperator, jobId, { reason: 'storage fixed' }),
    ).toEqual({ requeued: true });
    await expect(
      controller().requeueEnrolment(asOperator, jobId, { reason: 'again please' }),
    ).rejects.toMatchObject({ status: 404 });
    const [audit] = await ownerDb.execute<{ actor: string }>(sql`
      SELECT actor FROM audit_events
      WHERE business_id = ${businessId}::uuid AND action = 'enrolment_requeued'`);
    expect(audit?.actor).toBe('operator:alice@rekoda.app');
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(0);
    const [records] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`,
    );
    expect(records?.n).toBe(1);
  });

  it('refuses a malformed id, a missing reason, an unknown job, and a host with no worker credential', async () => {
    await expect(
      controller().requeueEnrolment(asOperator, 'not-a-uuid', { reason: 'storage fixed' }),
    ).rejects.toMatchObject({ status: 400 });
    const { jobId } = await deadLettered();
    await expect(controller().requeueEnrolment(asOperator, jobId, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      controller().requeueEnrolment(asOperator, '00000000-0000-4000-8000-000000000000', {
        reason: 'storage fixed',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(controller(null).enrolmentFailures()).rejects.toMatchObject({ status: 503 });
  });
});
