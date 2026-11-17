/**
 * Dead-letter handling for poison enrolment candidates (owner brief, 15 Nov 2026; migration 0229).
 *
 * The cutover enrolment pages 100 candidates by `updated_at, id`. Before 0229 a candidate whose
 * record could never be written stayed first in that order for ever, so 100 or more of them kept
 * every later candidate from being reached. Since 0229 each failure is recorded against its job and
 * retried with backoff (5, 10, 20, 40 minutes); the fifth failure dead-letters it; a dead-lettered
 * candidate is skipped until an operator requeues it, which is audited and never duplicates a record.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { jobsRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

/** Dead payment jobs with no record, as deaths before 0194 left them (staged as the owner). */
async function deadJobs(businessId: string, n: number): Promise<string[]> {
  const rows = await withBusiness(ownerDb, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts, updated_at)
      SELECT ${businessId}::uuid, 'payment.process', jsonb_build_object('eventId', gen_random_uuid()),
             'dead', 2, 2, now() - make_interval(secs => ${n} - g)
      FROM generate_series(1, ${n}::int) g
      RETURNING id`),
  );
  return [...rows].map((r) => r.id);
}

/** Every record insert for `businessId` fails, as a poison candidate's would. */
async function poison(businessId: string): Promise<void> {
  await ownerDb.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION public.test_poison_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.business_id = '${businessId}'::uuid THEN
        RAISE EXCEPTION 'test: poison candidate' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_poison_record ON dead_job_exceptions;
    CREATE TRIGGER test_poison_record BEFORE INSERT ON dead_job_exceptions
      FOR EACH ROW EXECUTE FUNCTION public.test_poison_record();`),
  );
}
afterEach(async () => {
  await ownerDb.execute(
    sql.raw(`DROP TRIGGER IF EXISTS test_poison_record ON dead_job_exceptions;
             DROP FUNCTION IF EXISTS public.test_poison_record();`),
  );
});

const failureOf = async (jobId: string) =>
  [
    ...(await ownerDb.execute<{
      attempts: number;
      last_sqlstate: string | null;
      due_in_minutes: number | null;
      dead: boolean;
    }>(sql`
      SELECT attempts, last_sqlstate::text,
             round(extract(epoch FROM next_attempt_at - now()) / 60)::int AS due_in_minutes,
             dead_lettered_at IS NOT NULL AS dead
      FROM dead_job_enrolment_failures WHERE job_id = ${jobId}::uuid`)),
  ][0];
const records = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM dead_job_exceptions WHERE business_id = ${businessId}::uuid`,
    )),
  ][0]!.n;
/** The backoff has passed: the next attempt is due now. */
const dueNow = (jobId: string) =>
  ownerDb.execute(sql`UPDATE dead_job_enrolment_failures SET next_attempt_at = now() - interval '1 second'
                      WHERE job_id = ${jobId}::uuid`);
const pass = () => outcome(jobsRepo.enrolUnrecordedDeaths(workerDb));

describe('0229: a failing candidate is retried with backoff, then dead-lettered', () => {
  it('records each failure (count, SQLSTATE, next attempt) and skips it while it backs off', async () => {
    const businessId = await seedBusiness();
    const [job] = await deadJobs(businessId, 1);
    await poison(businessId);
    expect(await pass()).toMatch(/enrolment failed for 1 dead job/);
    expect(await failureOf(job!)).toEqual({
      attempts: 1,
      last_sqlstate: 'P0001',
      due_in_minutes: 5,
      dead: false,
    });
    /* Backing off: the next pass does not touch it. */
    expect(await pass()).toBe('allowed');
    expect((await failureOf(job!))!.attempts).toBe(1);
    for (const [attempt, minutes] of [
      [2, 10],
      [3, 20],
      [4, 40],
    ] as const) {
      await dueNow(job!);
      expect(await pass()).toMatch(/enrolment failed for 1 dead job/);
      expect(await failureOf(job!)).toMatchObject({ attempts: attempt, due_in_minutes: minutes });
    }
    await dueNow(job!);
    expect(await pass()).toMatch(/enrolment failed for 1 dead job/);
    expect(await failureOf(job!)).toEqual({
      attempts: 5,
      last_sqlstate: 'P0001',
      due_in_minutes: null,
      dead: true,
    });
    /* Dead-lettered: never picked again by an ordinary pass. */
    expect(await pass()).toBe('allowed');
    expect((await failureOf(job!))!.attempts).toBe(5);
    expect(await jobsRepo.enrolmentDeadLetters(workerDb)).toMatchObject([
      { jobId: job, businessId, kind: 'payment.process', attempts: 5, lastSqlstate: 'P0001' },
    ]);
  });

  it('more than a page of poison candidates cannot starve a healthy one', async () => {
    const sick = await seedBusiness();
    const well = await seedBusiness();
    await deadJobs(sick, 105); // older than the healthy one: first in the page order
    const [healthy] = await deadJobs(well, 1);
    await poison(sick);
    /* Pass 1 fills its page of 100 with poison; each fails and backs off. */
    expect(await pass()).toMatch(/enrolment failed for 100 dead job/);
    expect(await records(well)).toBe(0);
    /* Pass 2: the 100 are backing off, so the remaining 5 and the healthy one are reached. */
    expect(await pass()).toMatch(/enrolment failed for 5 dead job\(s\); 1 enrolled/);
    expect(await records(well)).toBe(1);
    expect((await failureOf(healthy!)) ?? null).toBeNull();
  });
});

describe('0229: an operator inspects and requeues a dead-lettered candidate', () => {
  async function deadLettered(businessId: string): Promise<string> {
    const [job] = await deadJobs(businessId, 1);
    await poison(businessId);
    for (let i = 0; i < 5; i += 1) {
      await pass();
      await dueNow(job!);
    }
    expect((await failureOf(job!))!.dead).toBe(true);
    return job!;
  }
  const requeue = (pinned: string, businessId: string, jobId: string, db = appDb) =>
    outcome(
      withBusiness(db, pinned, (tx) =>
        jobsRepo.requeueEnrolment(tx, {
          businessId,
          jobId,
          actor: 'operator:ada@rekoda.test',
          reason: 'storage fixed; retry',
        }),
      ),
    );

  /* R05 (second review of #432, 0233): the actor follows the shared operator-actor contract,
   * `operator:<subject>` with a subject of 1 to 255 printable characters and no space, exactly as
   * `auditActorOf` produces it. */
  it('accepts a 255-character operator subject and refuses a 256-character or malformed actor', async () => {
    const businessId = await seedBusiness();
    const job = await deadLettered(businessId);
    const attempt = (actor: string) =>
      outcome(
        withBusiness(appDb, businessId, (tx) =>
          jobsRepo.requeueEnrolment(tx, { businessId, jobId: job, actor, reason: 'fixed; retry' }),
        ),
      );
    const longest = `operator:${'s'.repeat(255)}`;
    expect(await attempt(longest)).toBe('allowed');
    const [row] = await ownerDb.execute<{ requeued_by: string }>(sql`
      SELECT requeued_by FROM dead_job_enrolment_failures WHERE job_id = ${job}::uuid`);
    expect(row!.requeued_by).toBe(longest);
    for (const bad of [
      `operator:${'s'.repeat(256)}`,
      'alice',
      'operator:',
      'operator:has space',
      'operator:new\nline',
      ' operator:ada',
      'OPERATOR:ada',
    ]) {
      expect(await attempt(bad)).toMatch(/^22023 /);
    }
    /* The column holds the same contract, whoever writes it. */
    expect(
      await outcome(
        ownerDb.execute(sql`UPDATE dead_job_enrolment_failures SET requeued_by = 'alice'
                            WHERE job_id = ${job}::uuid`),
      ),
    ).toMatch(/^23514 /);
  });

  it('requeues once, audited; the candidate then enrols exactly once', async () => {
    const businessId = await seedBusiness();
    const job = await deadLettered(businessId);
    await ownerDb.execute(sql.raw(`DROP TRIGGER test_poison_record ON dead_job_exceptions;`));
    const done = await withBusiness(appDb, businessId, (tx) =>
      jobsRepo.requeueEnrolment(tx, {
        businessId,
        jobId: job,
        actor: 'operator:ada',
        reason: 'fixed; retry',
      }),
    );
    expect(done).toBe(true);
    expect(await failureOf(job)).toMatchObject({ attempts: 0, dead: false, due_in_minutes: null });
    const [audit] = await ownerDb.execute<{ actor: string; reason: string }>(sql`
      SELECT actor, new_value->>'reason' AS reason FROM audit_events
      WHERE business_id = ${businessId}::uuid AND action = 'enrolment_requeued' AND entity_id = ${job}`);
    expect(audit).toEqual({ actor: 'operator:ada', reason: 'fixed; retry' });
    /* A second requeue finds nothing dead-lettered and changes nothing. */
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        jobsRepo.requeueEnrolment(tx, {
          businessId,
          jobId: job,
          actor: 'operator:ada',
          reason: 'again',
        }),
      ),
    ).toBe(false);
    expect(await pass()).toBe('allowed');
    expect(await pass()).toBe('allowed');
    expect(await records(businessId)).toBe(1);
    expect(await jobsRepo.enrolmentDeadLetters(workerDb)).toEqual([]);
  });

  it('refuses another business’s pin, a job that is not dead-lettered, and every other role', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const job = await deadLettered(businessId);
    expect(await requeue(other, businessId, job)).toMatch(/^42501 .*not the pinned tenant/);
    expect(await requeue(other, other, job)).toBe('allowed'); // nothing of theirs: false, no change
    expect((await failureOf(job))!.dead).toBe(true);
    expect(await requeue(businessId, businessId, randomUUID())).toBe('allowed');
    for (const db of [workerDb, settlementDb]) {
      expect(await requeue(businessId, businessId, job, db)).toMatch(/^42501 .*permission denied/);
    }
    for (const statement of [
      sql`SELECT * FROM dead_job_enrolment_dead_letters(10)`,
      sql`SELECT dead_job_enrolment_failed(${businessId}::uuid, ${job}::uuid, 'P0001')`,
      sql`INSERT INTO dead_job_enrolment_failures (job_id, business_id, attempts) VALUES (${randomUUID()}::uuid, ${businessId}::uuid, 0)`,
      sql`UPDATE dead_job_enrolment_failures SET dead_lettered_at = NULL`,
    ]) {
      expect(await outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)))).toMatch(
        /^42501 .*permission denied/,
      );
    }
    expect(
      await outcome(workerDb.execute(sql`SELECT * FROM dead_job_enrolment_dead_letters(201)`)),
    ).toMatch(/^22023 /);
  });

  it('the functions are pinned definers; the table is tenant-scoped', async () => {
    const rows = [
      ...(await ownerDb.execute<{ name: string; definer: boolean; config: string[] | null }>(sql`
        SELECT proname AS name, prosecdef AS definer, proconfig AS config FROM pg_proc
        WHERE proname IN ('dead_job_enrolment_failed', 'dead_job_enrolment_dead_letters',
                          'dead_job_enrolment_requeue', 'dead_job_unrecorded_candidates')`)),
    ];
    /* Five: 0236 adds the cursor overload of the discovery function beside the page-size one. */
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.definer).toBe(true);
      expect(row.config).toContain('search_path=pg_catalog, public, pg_temp');
    }
    const [table] = await ownerDb.execute<{ rls: boolean; forced: boolean }>(sql`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
      WHERE oid = 'public.dead_job_enrolment_failures'::regclass`);
    expect(table).toEqual({ rls: true, forced: true });
  });
});

/* R08 (second review of #432, 0236): when the failure itself cannot be recorded. */
describe('0236: enrolment progresses when failure tracking also fails', () => {
  /** Failure records for `businessId` cannot be written either (a broken tenant). */
  async function poisonTracking(businessId: string): Promise<void> {
    await ownerDb.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION public.test_poison_tracking() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.business_id = '${businessId}'::uuid THEN
          RAISE EXCEPTION 'test: tracking broken' USING ERRCODE = 'P0002';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_poison_tracking ON dead_job_enrolment_failures;
      CREATE TRIGGER test_poison_tracking BEFORE INSERT ON dead_job_enrolment_failures
        FOR EACH ROW EXECUTE FUNCTION public.test_poison_tracking();`),
    );
  }
  afterEach(async () => {
    await ownerDb.execute(
      sql.raw(`DROP TRIGGER IF EXISTS test_poison_tracking ON dead_job_enrolment_failures;
               DROP FUNCTION IF EXISTS public.test_poison_tracking();`),
    );
  });

  it('reports an untracked failure by SQLSTATE instead of swallowing it', async () => {
    const broken = await seedBusiness();
    await deadJobs(broken, 1);
    await poison(broken);
    await poisonTracking(broken);
    const message = await pass();
    expect(message).toMatch(
      /enrolment failed for 1 dead job\(s\); 0 enrolled; the failure of 1 could not be recorded \(SQLSTATE P0002\)/,
    );
    /* Nothing about the row leaks into the report. */
    expect(message).not.toMatch(/test: tracking broken|poison/);
  });

  it('a page full of untrackable failures does not starve a later healthy candidate', async () => {
    const broken = await seedBusiness();
    const healthy = await seedBusiness();
    await deadJobs(broken, 3); // the oldest three: they head the page
    const [later] = await deadJobs(healthy, 1);
    await ownerDb.execute(sql`UPDATE jobs SET updated_at = now() WHERE id = ${later!}::uuid`);
    await poison(broken);
    await poisonTracking(broken);

    /* The runner's loop, with a page of 3 and the cursor carried between passes. */
    let after: string | null = null;
    const first = await jobsRepo.enrolUnrecordedDeathsPage(workerDb, { limit: 3, after });
    expect(first).toMatchObject({ enrolled: 0, failed: 3 });
    expect(first.untracked).toHaveLength(3);
    after = first.next;
    expect(after).not.toBeNull();
    const second = await jobsRepo.enrolUnrecordedDeathsPage(workerDb, { limit: 3, after });
    expect(second).toMatchObject({ enrolled: 1, failed: 0, next: null });
    expect(await records(healthy)).toBe(1);
    /* Short page: the next pass starts over and meets the broken ones again (retried, not lost). */
    const third = await jobsRepo.enrolUnrecordedDeathsPage(workerDb, {
      limit: 3,
      after: second.next,
    });
    expect(third.failed).toBe(3);
  });

  it('overlapping passes enrol each candidate once and spend one attempt per failure', async () => {
    const businessId = await seedBusiness();
    const healthy = await seedBusiness();
    const [failing] = await deadJobs(businessId, 1);
    await deadJobs(healthy, 2);
    await poison(businessId);
    const passes = await Promise.all(
      Array.from({ length: 3 }, () => jobsRepo.enrolUnrecordedDeathsPage(workerDb, { limit: 10 })),
    );
    expect(passes.reduce((n, p) => n + p.enrolled, 0)).toBe(2);
    expect(await records(healthy)).toBe(2);
    /* Each pass that reached the failing candidate spent one attempt; never more than passes ran,
     * and the backoff then keeps later passes off it. */
    const attempts = (await failureOf(failing!))!.attempts;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(await jobsRepo.enrolUnrecordedDeathsPage(workerDb, { limit: 10 })).toMatchObject({
      enrolled: 0,
      failed: 0,
    });
  });
});
