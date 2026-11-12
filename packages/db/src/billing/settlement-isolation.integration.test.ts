/**
 * OD-51.2 and OD-51.3 (migration 0217), at the database: what the settlement role holds, exactly,
 * and the one function that lets the renewal sweep run without the settlement credential.
 *
 * Until 0217 the settlement role was a member of the application role, so the credential that can
 * record a payment could also read and write any tenant record. These tests pin the role to the
 * grants settling uses, table by table, with the real role, and pin the rules of
 * `subscription_start_grace`, the narrow door that replaced a direct write of a guarded column.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { identity, subscriptionsRepo } from '../index.js';
import {
  applicationDb,
  migrate,
  operatorDb,
  requireUrls,
  setPlanAsOwner,
  settlementDb,
  truncateAll,
  type Urls,
} from '../testing.js';

const DAY = 86_400_000;
let urls: Urls;
let workerDb: Db;
let closeWorker: () => Promise<void>;
let owner: ReturnType<typeof postgres>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
  owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await closeWorker?.();
  await owner?.end();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    applicationDb(),
    `+23481940000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(applicationDb(), {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A paid Chat cycle that ended `endedAgoMs` ago, with or without the renewal the sweep opens. */
async function lapsedBusiness(
  endedAgoMs: number,
  renewal = true,
): Promise<{ businessId: string; endedAt: Date }> {
  const businessId = await seedBusiness();
  const endedAt = new Date(Date.now() - endedAgoMs);
  await setPlanAsOwner(urls, businessId, { plan: 'chat', planExpiresAt: endedAt });
  if (renewal) {
    await withBusiness(applicationDb(), businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        plan: 'chat',
        amountK: 990_000,
        reference: `RKD-SUB-20261112-G${String(phoneSeq).padStart(5, '0')}`,
        periodStart: endedAt,
        periodEnd: new Date(endedAt.getTime() + 30 * DAY),
      }),
    );
  }
  return { businessId, endedAt };
}

const startGrace = (db: Db, pinned: string, businessId: string, at: Date) =>
  withBusiness(db, pinned, async (tx) => {
    const rows = await tx.execute<{ started: boolean }>(
      sql`SELECT public.subscription_start_grace(${businessId}::uuid, ${at.toISOString()}::timestamptz) AS started`,
    );
    return [...rows][0]!.started;
  });
const refusal = (run: () => Promise<unknown>): Promise<string> =>
  run().then(
    () => 'allowed',
    (error: { message?: string; cause?: { message?: string } }) =>
      String(error.cause?.message ?? error.message),
  );
const failedAt = async (businessId: string): Promise<string | null> => {
  const rows = await owner`SELECT payment_failed_at FROM businesses WHERE id = ${businessId}`;
  const value = rows[0]!['payment_failed_at'] as Date | null;
  return value ? value.toISOString() : null;
};

describe('subscription_start_grace: the grace clock without the settlement credential', () => {
  it('starts the clock once, for the application and for the worker, and never moves it', async () => {
    const first = await lapsedBusiness(DAY);
    expect(
      await startGrace(applicationDb(), first.businessId, first.businessId, first.endedAt),
    ).toBe(true);
    expect(await failedAt(first.businessId)).toBe(first.endedAt.toISOString());
    /* A second failure a day later: the seven days still run from the first. */
    expect(await startGrace(applicationDb(), first.businessId, first.businessId, new Date())).toBe(
      false,
    );
    expect(await failedAt(first.businessId)).toBe(first.endedAt.toISOString());

    const second = await lapsedBusiness(DAY);
    expect(await startGrace(workerDb, second.businessId, second.businessId, second.endedAt)).toBe(
      true,
    );
  });

  it('is not the settlement role’s or the operator’s to call', async () => {
    const { businessId, endedAt } = await lapsedBusiness(DAY);
    for (const db of [settlementDb(), operatorDb()]) {
      expect(await refusal(() => startGrace(db, businessId, businessId, endedAt))).toMatch(
        /permission denied/,
      );
    }
    expect(await failedAt(businessId)).toBeNull();
  });

  it('refuses a business other than the pinned tenant', async () => {
    const mine = await lapsedBusiness(DAY);
    const theirs = await lapsedBusiness(DAY);
    expect(
      await refusal(() =>
        startGrace(applicationDb(), mine.businessId, theirs.businessId, theirs.endedAt),
      ),
    ).toMatch(/not the pinned tenant/);
    expect(await failedAt(theirs.businessId)).toBeNull();
  });

  it('refuses a trial, an expired plan, and a paid cycle with no renewal open', async () => {
    const trial = await seedBusiness();
    expect(await refusal(() => startGrace(applicationDb(), trial, trial, new Date()))).toMatch(
      /only a paid plan/,
    );
    const expired = await seedBusiness();
    await setPlanAsOwner(urls, expired, { plan: 'expired', planExpiresAt: new Date() });
    expect(await refusal(() => startGrace(applicationDb(), expired, expired, new Date()))).toMatch(
      /only a paid plan/,
    );
    /* Paid and current, nothing due: there is no renewal, so there is nothing to have failed. */
    const current = await lapsedBusiness(DAY, false);
    expect(
      await refusal(() =>
        startGrace(applicationDb(), current.businessId, current.businessId, current.endedAt),
      ),
    ).toMatch(/no renewal is open/);
    for (const id of [trial, expired, current.businessId]) expect(await failedAt(id)).toBeNull();
  });

  it('refuses a paid cycle that has not ended yet, even with its renewal already open (0220)', async () => {
    /* A paying business two days before its renewal date, whose renewal row is open early. */
    const { businessId, endedAt: renewsAt } = await lapsedBusiness(-2 * DAY);
    for (const at of [renewsAt, new Date()]) {
      expect(
        await refusal(() => startGrace(applicationDb(), businessId, businessId, at)),
        at.toISOString(),
      ).toMatch(/the cycle has not ended/);
    }
    expect(await failedAt(businessId)).toBeNull();
  });

  it('refuses a time before the cycle ended or in the future', async () => {
    const { businessId, endedAt } = await lapsedBusiness(DAY);
    for (const at of [
      new Date(endedAt.getTime() - DAY),
      new Date(endedAt.getTime() - 60_000),
      new Date(Date.now() + 10 * 60_000),
      new Date(Date.now() + 30 * DAY),
    ]) {
      expect(
        await refusal(() => startGrace(applicationDb(), businessId, businessId, at)),
        at.toISOString(),
      ).toMatch(/between the end of the cycle and now/);
    }
    expect(await failedAt(businessId)).toBeNull();
  });

  it('is the only way a runtime role starts, moves or clears the clock', async () => {
    const { businessId, endedAt } = await lapsedBusiness(DAY);
    expect(await startGrace(applicationDb(), businessId, businessId, endedAt)).toBe(true);
    /* The cycle guard (0206) stands down while the harness's fixture writer exists, which it never
     * does in a deployed database (the boot check and the pre-start smoke refuse one). So the
     * deployed rule is shown the way the smoke test shows it: the fixture dropped, each role
     * assumed, inside a transaction that is always rolled back. */
    const outcomes: string[] = [];
    await owner
      .begin(async (tx) => {
        await tx.unsafe('DROP FUNCTION public.test_fixture_set_plan(uuid, text, timestamptz)');
        for (const role of ['rekoda_app', 'rekoda_worker', 'rekoda_usage_writer']) {
          for (const value of ['NULL', 'now()']) {
            await tx.unsafe('SAVEPOINT attempt');
            try {
              await tx.unsafe(`SET LOCAL ROLE ${role}`);
              await tx.unsafe(`SELECT set_config('app.business_id', '${businessId}', true)`);
              await tx.unsafe(
                `UPDATE businesses SET payment_failed_at = ${value} WHERE id = '${businessId}'`,
              );
              outcomes.push(`${role} wrote ${value}`);
            } catch (error) {
              outcomes.push(String((error as Error).message));
            }
            await tx.unsafe('ROLLBACK TO SAVEPOINT attempt');
            await tx.unsafe('RESET ROLE');
          }
        }
        throw new Error('roll back');
      })
      .catch((error: Error) => {
        if (error.message !== 'roll back') throw error;
      });
    expect(outcomes).toHaveLength(6);
    for (const outcome of outcomes) {
      expect(outcome).toMatch(/permission denied|change only through settlement/);
    }
    expect(await failedAt(businessId)).toBe(endedAt.toISOString());
  });
});

describe('the settlement role, exactly (0217)', () => {
  it('is a member of no other role, and no other runtime role is a member of it', async () => {
    const rows = await owner`
      SELECT r.rolname AS role, m.rolname AS member
      FROM pg_auth_members a
      JOIN pg_roles r ON r.oid = a.roleid
      JOIN pg_roles m ON m.oid = a.member
      WHERE 'rekoda_settlement' IN (r.rolname, m.rolname)
        AND m.rolname LIKE 'rekoda\_%' AND r.rolname LIKE 'rekoda\_%'
      ORDER BY 1, 2`;
    /* None at all: it reaches the plan and usage writers through EXECUTE on their functions. */
    expect(rows.map((row) => `${row['member']}->${row['role']}`)).toEqual([]);
  });

  it('holds exactly these table rights and no others', async () => {
    const rows = await owner`
      SELECT c.relname AS table_name,
             string_agg(p.priv, ',' ORDER BY p.priv) AS rights
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
      WHERE c.relkind IN ('r', 'p', 'v', 'm')
        AND CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE')
                 THEN has_any_column_privilege('rekoda_settlement', c.oid, p.priv)
                 ELSE has_table_privilege('rekoda_settlement', c.oid, p.priv) END
      GROUP BY c.relname ORDER BY c.relname`;
    expect(Object.fromEntries(rows.map((row) => [row['table_name'], row['rights']]))).toEqual({
      add_on_grants: 'SELECT',
      add_ons: 'SELECT',
      audit_events: 'INSERT',
      billing_pricing_source: 'SELECT',
      business_add_ons: 'INSERT,SELECT,UPDATE',
      businesses: 'SELECT,UPDATE',
      dead_job_exceptions: 'INSERT,SELECT,UPDATE',
      external_events: 'SELECT,UPDATE',
      jobs: 'SELECT,UPDATE',
      plan_prices: 'SELECT',
      plan_versions: 'SELECT',
      subscription_charge_attempts: 'SELECT,UPDATE',
      subscription_charges: 'SELECT,UPDATE',
      usage_packs: 'SELECT',
    });
  });

  it('writes only the columns settling writes', async () => {
    const rows = await owner`
      SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS columns
      FROM information_schema.column_privileges
      WHERE grantee = 'rekoda_settlement' AND table_schema = 'public' AND privilege_type = 'UPDATE'
        AND table_name IN ('businesses', 'external_events', 'jobs', 'subscription_charge_attempts')
      GROUP BY table_name ORDER BY table_name`;
    const columns = Object.fromEntries(rows.map((row) => [row['table_name'], row['columns']]));
    expect(columns['external_events']).toBe('error,processed_at');
    expect(columns['subscription_charge_attempts']).toBe('status,updated_at');
    expect(columns['jobs']).toBe(
      'attempts,failure_category,last_error,locked_at,locked_by,run_at,state,updated_at',
    );
    /* The cycle, never the identity of the business or its settings. */
    for (const forbidden of ['name', 'owner_user_id', 'settings', 'trial_started_at', 'id']) {
      expect(String(columns['businesses']).split(',')).not.toContain(forbidden);
    }
    for (const never of ['kind', 'amount_k', 'business_id', 'plan', 'pack_id', 'reference']) {
      const granted = await owner`
        SELECT has_column_privilege('rekoda_settlement', 'public.subscription_charges', ${never}, 'UPDATE') AS ok`;
      expect(granted[0]!['ok'], never).toBe(false);
    }
  });

  it('gains nothing from a table created after it: no default privilege', async () => {
    await owner`CREATE TABLE public.od51_probe (id int)`;
    try {
      const rows = await owner`
        SELECT has_table_privilege('rekoda_settlement', 'public.od51_probe', 'SELECT') AS reads,
               has_table_privilege('rekoda_settlement', 'public.od51_probe', 'INSERT') AS writes`;
      expect(rows[0]).toMatchObject({ reads: false, writes: false });
    } finally {
      await owner`DROP TABLE public.od51_probe`;
    }
  });
});
