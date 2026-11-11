/**
 * OD-47 (ADR 0035 Amendment 2): the operator work lists are a narrow, fixed-column cross-tenant
 * read. The tables carry no cross-tenant policy; only the SECURITY DEFINER functions of 0194 and
 * 0195 reach across businesses, return operational columns only, are bounded, and execute for
 * `rekoda_worker` alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { deadJobsRepo, identity, subscriptionsRepo } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let ownerDb: Db;
let appDb: Db;
let workerDb: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [url, set] of [
    [urls.owner, (d: Db) => (ownerDb = d)],
    [urls.app, (d: Db) => (appDb = d)],
    [urls.worker, (d: Db) => (workerDb = d)],
  ] as const) {
    const { db, close } = createDb(url, { max: 4 });
    set(db);
    closers.push(close);
  }
});
afterAll(async () => {
  for (const c of closers) await c();
});
beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function business(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481960000${String(seq).padStart(2, '0')}`,
  );
  return (
    await identity.createBusinessWithOwner(appDb, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    })
  ).id;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let deadSeq = 0;
async function deadJob(businessId: string, extra: { eventId?: string; status?: string } = {}) {
  deadSeq += 1;
  const jobId = uuid(deadSeq);
  await ownerDb.execute(sql`
    INSERT INTO dead_job_exceptions (job_id, business_id, kind, event_id, status, summary, attempts)
    VALUES (${jobId}::uuid, ${businessId}::uuid, 'payment.process',
            ${extra.eventId ?? null}::uuid, ${extra.status ?? 'open'}, 'fixed summary', 3)`);
  return jobId;
}

async function blockedCharge(businessId: string, ref: string) {
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, reference, kind, plan, amount_k, status, blocked_at, blocked_reason)
    VALUES (${businessId}::uuid, ${ref}, 'renewal', 'chat', 500000, 'pending', now(),
            'payments_not_configured')`);
}

/** The SQLSTATE of a refused call: Drizzle wraps the driver error, so it sits on the cause. */
async function sqlState(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

describe('the dead-job table has no cross-tenant read', () => {
  it('shows the worker nothing without a tenant pin, whatever rows exist', async () => {
    await deadJob(await business());
    await deadJob(await business());
    const rows = await workerDb.execute(sql`SELECT job_id FROM dead_job_exceptions`);
    expect([...rows]).toHaveLength(0);
  });

  it('shows a pinned worker only its own business', async () => {
    const a = await business();
    const b = await business();
    const jobA = await deadJob(a);
    await deadJob(b);
    const rows = await withBusiness(workerDb, a, (tx) =>
      tx.execute<{ job_id: string }>(sql`SELECT job_id FROM dead_job_exceptions`),
    );
    expect([...rows].map((r) => r.job_id)).toEqual([jobA]);
  });
});

describe('the operator lists reach across businesses, with fixed columns', () => {
  it('lists open dead jobs of every business and nothing else', async () => {
    const a = await business();
    const b = await business();
    const jobA = await deadJob(a);
    const jobB = await deadJob(b);
    await deadJob(a, { status: 'resolved' });
    const rows = await deadJobsRepo.opsQueue(workerDb, 50);
    expect(rows.map((r) => r.jobId).sort()).toEqual([jobA, jobB].sort());
    expect(new Set(rows.map((r) => r.businessId))).toEqual(new Set([a, b]));
  });

  it('returns exactly the approved operational columns', async () => {
    await deadJob(await business());
    const raw = await workerDb.execute<Record<string, unknown>>(
      sql`SELECT * FROM dead_job_ops_queue(10, NULL::uuid[], false)`,
    );
    expect(Object.keys([...raw][0]!).sort()).toEqual(
      [
        'attempts',
        'business_id',
        'current_plan',
        'current_plan_expires_at',
        'death_count',
        'event_id',
        'failure_category',
        'job_id',
        'kind',
        'last_died_at',
        'opened_at',
        'payment_state',
        'recovery_reference',
        'recovery_requested_at',
        'reference',
        'status',
        'summary',
      ].sort(),
    );
    const one = await workerDb.execute<Record<string, unknown>>(
      sql`SELECT * FROM dead_job_find_for_ops(${uuid(deadSeq)}::uuid)`,
    );
    for (const hidden of ['recovery_reason', 'recovery_requested_by', 'closed_by', 'resolution']) {
      expect(Object.keys([...one][0]!)).not.toContain(hidden);
    }
  });

  it('lists open blocked renewals of every business with the approved columns only', async () => {
    const a = await business();
    const b = await business();
    await blockedCharge(a, 'RKD-SUB-20261108-AAAAAA');
    await blockedCharge(b, 'RKD-SUB-20261108-BBBBBB');
    const rows = await subscriptionsRepo.blockedRenewals(workerDb, 50);
    expect(rows.map((r) => r.businessId).sort()).toEqual([a, b].sort());
    const raw = await workerDb.execute<Record<string, unknown>>(
      sql`SELECT * FROM blocked_renewals_ops(10, 0)`,
    );
    expect(Object.keys([...raw][0]!).sort()).toEqual(
      [
        'amount_k',
        'blocked_at',
        'blocked_reason',
        'business_id',
        'current_plan',
        'current_renews_at',
        'plan',
        'reference',
      ].sort(),
    );
  });

  it('bounds every list, whatever limit is asked for', async () => {
    const a = await business();
    for (let i = 0; i < 3; i++) await deadJob(a);
    expect(await deadJobsRepo.opsQueue(workerDb, 1)).toHaveLength(1);
    const huge = await workerDb.execute<{ job_id: string }>(
      sql`SELECT job_id FROM dead_job_ops_queue(100000, NULL::uuid[], false)`,
    );
    expect([...huge].length).toBeLessThanOrEqual(200);
    // The cap itself, not just a small table: 205 open records still answer at most 200.
    await ownerDb.execute(sql`
      INSERT INTO dead_job_exceptions (job_id, business_id, kind, status, summary, attempts)
      SELECT gen_random_uuid(), ${a}::uuid, 'payment.process', 'open', 'fixed summary', 1
      FROM generate_series(1, 205)`);
    const capped = await workerDb.execute<{ job_id: string }>(
      sql`SELECT job_id FROM dead_job_ops_queue(100000, NULL::uuid[], false)`,
    );
    expect([...capped]).toHaveLength(200);
    const zero = await workerDb.execute(
      sql`SELECT * FROM dead_job_ops_queue(0, NULL::uuid[], false)`,
    );
    expect([...zero]).toHaveLength(1);
  });

  it('answers the worker passes with booleans and a job id only', async () => {
    const a = await business();
    const event = uuid(900);
    const job = await deadJob(a, { eventId: event, status: 'recovering' });
    expect(await deadJobsRepo.openJobForEvent(workerDb, event)).toBe(job);
    const flags = await workerDb.execute<{ rec: boolean; has: boolean; none: boolean }>(sql`
      SELECT dead_job_is_recovering(${job}::uuid) AS rec, dead_job_has_record(${job}::uuid) AS has,
             dead_job_has_record(${uuid(901)}::uuid) AS none`);
    expect([...flags][0]).toEqual({ rec: true, has: true, none: false });
  });
});

describe('only the worker credential may call the lists', () => {
  const calls = [
    sql`SELECT * FROM dead_job_ops_queue(10, NULL::uuid[], false)`,
    sql`SELECT dead_job_open_for_event(${uuid(1)}::uuid, NULL)`,
    sql`SELECT dead_job_is_recovering(${uuid(1)}::uuid)`,
    sql`SELECT dead_job_has_record(${uuid(1)}::uuid)`,
    sql`SELECT * FROM dead_job_find_for_ops(${uuid(1)}::uuid)`,
    sql`SELECT * FROM blocked_renewals_ops(10, 0)`,
    sql`SELECT * FROM blocked_renewals_close_batch(10)`,
    sql`SELECT renewal_block_close_claim(${uuid(1)}::uuid, 60)`,
    sql`SELECT renewal_block_close_advance(${uuid(1)}::uuid, 1::bigint, 'RKD-X', 0, 0, 60)`,
    sql`SELECT renewal_block_close_finish(${uuid(1)}::uuid, true)`,
    sql`SELECT renewal_block_close_release(${uuid(1)}::uuid)`,
    sql`SELECT * FROM renewal_block_close_status()`,
  ];

  it.each(calls.map((c, i) => [i, c] as const))(
    'refuses the application role (call %i)',
    async (_i, call) => {
      expect(await sqlState(appDb.execute(call))).toBe('42501');
    },
  );

  it('is a pinned-search-path SECURITY DEFINER function, closed to PUBLIC and the application', async () => {
    const rows = await ownerDb.execute<{
      proname: string;
      secdef: boolean;
      cfg: string[] | null;
      app: boolean;
      worker: boolean;
      pub: boolean;
    }>(sql`
      SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS cfg,
             has_function_privilege('rekoda_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('rekoda_worker', p.oid, 'EXECUTE') AS worker,
             coalesce((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a), false) AS pub
      FROM pg_proc p
      WHERE p.proname IN ('dead_job_ops_queue', 'dead_job_open_for_event', 'dead_job_is_recovering',
                          'dead_job_has_record', 'dead_job_find_for_ops', 'blocked_renewals_ops',
                          'blocked_renewals_close_batch', 'renewal_block_close_claim',
                          'renewal_block_close_advance', 'renewal_block_close_finish',
                          'renewal_block_close_release', 'renewal_block_close_status')`);
    const found = [...rows];
    expect(found).toHaveLength(12);
    for (const f of found) {
      expect(f).toMatchObject({ secdef: true, app: false, worker: true, pub: false });
      expect(f.cfg?.join(',')).toContain('search_path=pg_catalog, pg_temp');
    }
  });
});

describe('the blocked-renewal close cursor (0199) is reachable only through its functions', () => {
  it('the cursor table has forced RLS, no policy and no grant to any application role', async () => {
    const [t] = await ownerDb.execute<{
      rls: boolean;
      forced: boolean;
      policies: number;
      app: boolean;
      worker: boolean;
    }>(sql`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             has_table_privilege('rekoda_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app,
             has_table_privilege('rekoda_worker', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS worker
      FROM pg_class c WHERE c.relname = 'renewal_block_close_cursor'`);
    expect(t).toEqual({ rls: true, forced: true, policies: 0, app: false, worker: false });
    expect(await sqlState(workerDb.execute(sql`SELECT * FROM renewal_block_close_cursor`))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        workerDb.execute(sql`UPDATE renewal_block_close_cursor SET after_reference = 'x'`),
      ),
    ).toBe('42501');
  });

  it('lists the approved columns only, bounded, and validates every cursor input', async () => {
    const a = await business();
    await blockedCharge(a, 'RKD-SUB-20261108-CCCCCC');
    const raw = await workerDb.execute<Record<string, unknown>>(
      sql`SELECT * FROM blocked_renewals_close_batch(100000)`,
    );
    expect(Object.keys([...raw][0]!).sort()).toEqual(
      [
        'amount_k',
        'blocked_at',
        'blocked_at_us',
        'blocked_reason',
        'business_id',
        'current_plan',
        'current_renews_at',
        'plan',
        'reference',
      ].sort(),
    );
    for (const bad of [
      sql`SELECT renewal_block_close_claim(NULL, 60)`,
      sql`SELECT renewal_block_close_claim(${uuid(2)}::uuid, 5)`,
      sql`SELECT renewal_block_close_advance(${uuid(2)}::uuid, 1::bigint, ${'x'.repeat(65)}, 0, 0, 60)`,
      sql`SELECT renewal_block_close_advance(${uuid(2)}::uuid, 1::bigint, 'RKD-X', -1, 0, 60)`,
    ]) {
      expect(await sqlState(workerDb.execute(bad))).toBe('22023');
    }
  });
});
