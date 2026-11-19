/**
 * OWN-73: resolving a dead job closes the record, the merchant's reconciliation exception and the
 * flagged event in ONE transaction. If the event write fails, nothing closes (CodeRabbit on #432).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  events,
  identity,
  jobsRepo,
  settleRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig } from '../config.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import type { OperatorRequest } from '../auth/operator.guard.js';
import { DeadJobRecoveryService } from './dead-job-recovery.service.js';
import { DeadJobsController } from './dead-jobs.controller.js';

const asOperator = { operator: { subject: 'alice@rekoda.app' } } as unknown as OperatorRequest;

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
let controller: DeadJobsController;
const closers: Array<() => Promise<void>> = [];

const key = (label: string) =>
  createHash('sha256')
    .update(`${label}:${randomBytes(8).toString('hex')}`)
    .digest('hex');

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.owner, (d: Db) => (ownerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = key('pepper');
  process.env['REKODA_API_SECRET'] = key('secret');
  process.env['VAULT_KEY'] = key('vault');
  process.env['MATCH_KEY'] = key('match');
  controller = new DeadJobsController(
    new DeadJobRecoveryService(loadConfig(), appDb, workerDb, new StubPaymentProvider()),
  );
});
afterAll(async () => {
  await ownerDb?.execute(sql`DROP FUNCTION IF EXISTS refuse_event_close() CASCADE`);
  for (const c of closers) await c();
});
beforeEach(async () => {
  await ownerDb.execute(sql`DROP FUNCTION IF EXISTS refuse_event_close() CASCADE`);
  await truncateAll(urls);
});

/** A business with a dead payment job bound to its own flagged event. */
async function deadJobWithEvent() {
  const user = await identity.upsertUserByPhone(appDb, '+2348130009901');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: 'atomic-1:charge.success',
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const eventId = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, eventId, business.id)).toBe(true);
  await withBusiness(appDb, business.id, (tx) =>
    jobsRepo.enqueue(tx, {
      businessId: business.id,
      kind: 'payment.process',
      payload: { eventId },
      maxAttempts: 1,
    }),
  );
  const job = await jobsRepo.claimNext(workerDb, 'atomic');
  expect((await jobsRepo.markFailed(workerDb, job!, 'boom', 0)).state).toBe('dead');
  return { businessId: business.id, jobId: job!.id, eventId };
}

const state = async (businessId: string, jobId: string, eventId: string) => {
  const record = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ status: string }>(
      sql`SELECT status FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`,
    ),
  );
  const merchant = await withBusiness(appDb, businessId, (tx) =>
    settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 50 }),
  );
  const flagged = (await events.exceptionQueue(workerDb)).flagged.some((r) => r.id === eventId);
  return {
    record: [...record][0]?.status,
    merchantOpen: merchant.filter((r) => r.reason === 'payment_processing_stopped' && !r.resolvedAt)
      .length,
    eventStillFlagged: flagged,
  };
};

describe('resolving a dead job is one transaction', () => {
  it('closes the record, the merchant exception and the event together', async () => {
    const { businessId, jobId, eventId } = await deadJobWithEvent();
    await controller.resolve(asOperator, jobId, { resolution: 'settled by hand' });
    expect(await state(businessId, jobId, eventId)).toEqual({
      record: 'resolved',
      merchantOpen: 0,
      eventStillFlagged: false,
    });
  });

  it('when the event write fails, the record and the merchant exception stay open', async () => {
    const { businessId, jobId, eventId } = await deadJobWithEvent();
    await ownerDb.execute(sql`
      CREATE FUNCTION refuse_event_close() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'event write refused'; END $f$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER refuse_event_close BEFORE UPDATE ON external_events
      FOR EACH ROW WHEN (NEW.resolved_at IS NOT NULL) EXECUTE FUNCTION refuse_event_close()`);

    // Drizzle wraps the driver error ("Failed query: ..."); the trigger's
    // message is on the cause.
    const failure = await controller
      .resolve(asOperator, jobId, { resolution: 'settled by hand' })
      .then(
        () => undefined,
        (error: unknown) => error as { message?: string; cause?: { message?: string } },
      );
    expect(`${failure?.message}\n${failure?.cause?.message}`).toMatch(/event write refused/);

    expect(await state(businessId, jobId, eventId)).toEqual({
      record: 'open',
      merchantOpen: 1,
      eventStillFlagged: true,
    });
    const audit = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ action: string }>(
        sql`SELECT action FROM audit_events WHERE entity = 'job' AND action = 'dead_job_resolved'`,
      ),
    );
    expect([...audit]).toHaveLength(0);
  });
});
