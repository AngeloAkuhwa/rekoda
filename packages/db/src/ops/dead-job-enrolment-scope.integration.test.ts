/**
 * Final review of PR #432 (14 Nov 2026): the cutover enrolment of unrecorded dead jobs (OWN-73,
 * OWN-76) crosses tenants only to discover ids.
 *
 * Before: one unpinned query on the worker credential read every tenant's dead payment and billing
 * jobs, payload included, and wrote every record in one transaction, so one business's failure
 * rolled back every other business's enrolment. After (migration 0225): a worker-only SECURITY
 * DEFINER function returns job and business ids alone (ADR 0035 Amendment 1, class 2), and each job
 * is re-read, re-checked and recorded in its own transaction pinned to its own business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, identity, jobsRepo } from '../index.js';
import {
  migrate,
  ownerDb,
  requireUrls,
  storedEventId,
  truncateAll,
  type Urls,
} from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let settlementDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
    [urls.settlement, (d: Db) => (settlementDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const outcome = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: { cause?: { message?: string; code?: string }; message?: string }) =>
      `${error.cause?.code ?? ''} ${error.cause?.message ?? error.message ?? String(error)}`,
  );

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480500200${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

let externalSeq = 0;
async function attributedEvent(businessId: string): Promise<string> {
  externalSeq += 1;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: `scope-${externalSeq}:charge.success`,
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const id = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, id, businessId)).toBe(true);
  return id;
}

/** A dead payment job with no record, as a death before 0194 left it. Staged as the owner. */
async function unrecordedDeath(businessId: string, kind = 'payment.process'): Promise<string> {
  const eventId = await attributedEvent(businessId);
  await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, {
      businessId,
      kind,
      payload: { eventId },
      /* A settlement job is enqueued only with its own retry budget (0222). */
      ...(kind === 'payment.process'
        ? { maxAttempts: 2 }
        : { singletonKey: `billevent:${eventId}` }),
    }),
  );
  const rows = await withBusiness(ownerDb(), businessId, (tx) =>
    tx.execute<{ id: string }>(sql`UPDATE jobs SET state = 'dead', attempts = max_attempts
      WHERE business_id = ${businessId}::uuid AND state = 'pending' RETURNING id`),
  );
  return [...rows][0]!.id;
}

const recordsOf = async (businessId: string) =>
  [
    ...(await ownerDb().execute<{ job_id: string; business_id: string }>(
      sql`SELECT job_id, business_id FROM dead_job_exceptions WHERE business_id = ${businessId}::uuid`,
    )),
  ].map((r) => ({ jobId: r.job_id, businessId: r.business_id }));

describe('0225: the discovery function returns ids only, to the worker only', () => {
  it('is SECURITY DEFINER with a pinned search_path, executable by rekoda_worker alone', async () => {
    const [fn] = await ownerDb().execute<{
      definer: boolean;
      config: string[] | null;
      result: string;
      acl: string;
    }>(sql`
      SELECT p.prosecdef AS definer, p.proconfig AS config,
             pg_get_function_result(p.oid) AS result, coalesce(p.proacl::text, '') AS acl
      FROM pg_proc p WHERE p.oid = 'public.dead_job_unrecorded_candidates(integer)'::regprocedure`);
    expect(fn!.definer).toBe(true);
    expect(fn!.config).toContain('search_path=pg_catalog, public, pg_temp');
    expect(fn!.result).toBe('TABLE(job_id uuid, business_id uuid)');
    for (const role of ['rekoda_app', 'rekoda_settlement', 'rekoda_billing_operator']) {
      const [can] = await ownerDb().execute<{ ok: boolean }>(
        sql`SELECT has_function_privilege(${role}, 'public.dead_job_unrecorded_candidates(integer)', 'EXECUTE') AS ok`,
      );
      expect({ role, ok: can!.ok }).toEqual({ role, ok: false });
    }
    expect(fn!.acl).not.toMatch(/(^|[{,])=X/); // no PUBLIC grant
  });

  it('refuses the application and settlement, and an out-of-range page size', async () => {
    for (const db of [appDb, settlementDb]) {
      expect(
        await outcome(db.execute(sql`SELECT * FROM dead_job_unrecorded_candidates(10)`)),
      ).toMatch(/^42501 /);
    }
    for (const limit of [0, 201, -1]) {
      expect(
        await outcome(
          workerDb.execute(sql`SELECT * FROM dead_job_unrecorded_candidates(${limit}::int)`),
        ),
      ).toMatch(/^22023 /);
    }
  });

  it('lists an unrecorded death by its ids, and no settled or recorded one', async () => {
    const mine = await seedBusiness();
    const job = await unrecordedDeath(mine);
    const rows = [
      ...(await workerDb.execute(sql`SELECT * FROM dead_job_unrecorded_candidates(10)`)),
    ];
    expect(rows).toEqual([{ job_id: job, business_id: mine }]);
  });
});

describe('0225: each death is enrolled in its own business, independently', () => {
  it('one business whose record cannot be written does not stop another business', async () => {
    const failing = await seedBusiness();
    const healthy = await seedBusiness();
    await unrecordedDeath(failing);
    const healthyJob = await unrecordedDeath(healthy);
    await ownerDb().execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION public.test_refuse_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_id = '${failing}'::uuid THEN
          RAISE EXCEPTION 'test: this business cannot be recorded';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_refuse_record BEFORE INSERT ON dead_job_exceptions
        FOR EACH ROW EXECUTE FUNCTION public.test_refuse_record();`),
    );
    try {
      expect(await outcome(jobsRepo.enrolUnrecordedDeaths(workerDb))).toMatch(
        /enrolment failed for 1 dead job/,
      );
    } finally {
      await ownerDb().execute(
        sql.raw(`
        DROP TRIGGER test_refuse_record ON dead_job_exceptions;
        DROP FUNCTION public.test_refuse_record();`),
      );
    }
    expect(await recordsOf(healthy)).toEqual([{ jobId: healthyJob, businessId: healthy }]);
    expect(await recordsOf(failing)).toEqual([]);
    /* The failing one is still a candidate: once its backoff has passed (0229) and the cause is
     * gone, it enrols. */
    await ownerDb().execute(sql`UPDATE dead_job_enrolment_failures
      SET next_attempt_at = now() - interval '1 second' WHERE business_id = ${failing}::uuid`);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(1);
    expect(await recordsOf(failing)).toHaveLength(1);
  });

  it('writes each record under its own business, never another', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const jobA = await unrecordedDeath(a);
    const jobB = await unrecordedDeath(b, 'billing.process');
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(2);
    expect(await recordsOf(a)).toEqual([{ jobId: jobA, businessId: a }]);
    expect(await recordsOf(b)).toEqual([{ jobId: jobB, businessId: b }]);
    /* A business-scoped reader sees its own record and nothing of the other's. */
    const seenByA = await withBusiness(appDb, a, (tx) =>
      tx.execute<{ job_id: string }>(sql`SELECT job_id FROM dead_job_exceptions`),
    );
    expect([...seenByA].map((r) => r.job_id)).toEqual([jobA]);
  });

  it('a candidate named under the wrong business reads and writes nothing', async () => {
    const owner = await seedBusiness();
    const other = await seedBusiness();
    const job = await unrecordedDeath(owner);
    expect(await jobsRepo.enrolDeath(workerDb, job, other)).toBe(false);
    expect(await recordsOf(owner)).toEqual([]);
    expect(await recordsOf(other)).toEqual([]);
    expect(await jobsRepo.enrolDeath(workerDb, job, owner)).toBe(true);
    expect(await recordsOf(owner)).toEqual([{ jobId: job, businessId: owner }]);
  });

  it('refuses ids that are not UUIDs before touching the database', async () => {
    const business = await seedBusiness();
    expect(await jobsRepo.enrolDeath(workerDb, 'not-a-uuid', business)).toBe(false);
    await expect(jobsRepo.enrolDeath(workerDb, business, "x'; --")).resolves.toBe(false);
  });

  it('two passes at once enrol a death once', async () => {
    const business = await seedBusiness();
    const job = await unrecordedDeath(business);
    const [one, two] = await Promise.all([
      jobsRepo.enrolUnrecordedDeaths(workerDb),
      jobsRepo.enrolUnrecordedDeaths(workerDb),
    ]);
    expect(one + two).toBe(1);
    expect(await recordsOf(business)).toEqual([{ jobId: job, businessId: business }]);
  });
});
