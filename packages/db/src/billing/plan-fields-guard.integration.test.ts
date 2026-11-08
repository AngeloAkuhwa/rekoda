/**
 * OD-37 (PR B item 5; migration 0196): `businesses.plan` and `businesses.plan_expires_at` change
 * only through the subscription writers, enforced by the database.
 *
 * The exemption is a ROLE (`rekoda_plan_writer`, the owner of the two SECURITY DEFINER writers),
 * never a setting: no session or transaction setting, and no role the application holds, reaches
 * it. The table owner keeps migrations and an administrator's repair.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { billingRepo, identity, subscriptionsRepo } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

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
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480600000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The Postgres error behind drizzle's wrapper, or 'allowed'. */
const outcome = (run: Promise<unknown>) =>
  run.then(
    () => 'allowed',
    (error: { cause?: { message?: string; code?: string } }) =>
      `${error.cause?.code ?? ''} ${error.cause?.message ?? String(error)}`,
  );

const planOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ plan: string; plan_expires_at: string | null }>(
      sql`SELECT plan, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid`,
    )),
  ][0];

const FUTURE = new Date(Date.now() + 30 * 86_400_000);

describe('OD-37: a direct write to the plan fields is refused', () => {
  it('refuses the application role setting plan or plan_expires_at, under its own tenant pin', async () => {
    const businessId = await seedBusiness();
    const before = await planOf(businessId);

    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`),
        ),
      ),
    ).toMatch(/42501.*subscription writers \(OD-37\)/);
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`UPDATE businesses SET plan_expires_at = now() + interval '1 year' WHERE id = ${businessId}::uuid`,
          ),
        ),
      ),
    ).toMatch(/42501/);
    expect(await planOf(businessId)).toEqual(before);
  });

  it('refuses the worker role too', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(workerDb, businessId, (tx) =>
          tx.execute(sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`),
        ),
      ),
    ).toMatch(/42501|permission denied/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('no session or transaction setting authorises a write', async () => {
    const businessId = await seedBusiness();
    for (const setting of [
      sql`SELECT set_config('rekoda.plan_writer', 'on', true)`,
      sql`SELECT set_config('rekoda.plan_writer', 'on', false)`,
      sql`SELECT set_config('app.role', 'rekoda_plan_writer', true)`,
      sql`SELECT set_config('application_name', 'rekoda_plan_writer', true)`,
      sql`SELECT set_config('rekoda.migration_mode', 'on', true)`,
    ]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, async (tx) => {
            await tx.execute(setting);
            await tx.execute(
              sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`,
            );
          }),
        ),
      ).toMatch(/42501/);
    }
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('the application cannot become the writer role', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) => tx.execute(sql`SET LOCAL ROLE rekoda_plan_writer`)),
      ),
    ).toMatch(/permission denied/);
  });

  it('a write that leaves both fields unchanged, or touches other columns, is not refused', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`UPDATE businesses SET plan = plan, plan_expires_at = plan_expires_at, name = 'Ada Couture' WHERE id = ${businessId}::uuid`,
          ),
        ),
      ),
    ).toBe('allowed');
  });
});

describe('OD-37: the sanctioned writers still work', () => {
  it('a provider cycle (writeSubscriptionState via applyCycle) moves the plan and the date together', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(),
        renewsAt: FUTURE,
        anchorDay: FUTURE.getUTCDate(),
      }),
    );
    const after = await planOf(businessId);
    expect(after?.plan).toBe('chat');
    expect(new Date(after!.plan_expires_at!).toISOString()).toBe(FUTURE.toISOString());
  });

  it('an operator correction (billingRepo.setPlan) and a lapse (expireSubscription) work, audited as before', async () => {
    const businessId = await seedBusiness();
    expect(
      await billingRepo.setPlan(appDb, {
        businessId,
        plan: 'complete',
        expiresAt: FUTURE,
        actor: 'operator:alice',
      }),
    ).toBe(true);
    expect((await planOf(businessId))?.plan).toBe('complete');

    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    const previous = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.expireSubscription(tx, businessId, 'system:test', 'cancelled'),
    );
    expect(previous).toBe('complete');
    expect((await planOf(businessId))?.plan).toBe('expired');

    const audit = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ action: string }>(sql`
        SELECT action FROM audit_events WHERE business_id = ${businessId}::uuid
          AND action IN ('plan_changed', 'subscription_expired') ORDER BY created_at`),
    );
    expect([...audit].map((a) => a.action)).toEqual(['plan_changed', 'subscription_expired']);
  });

  it('a lapse whose condition no longer holds changes nothing (the race guard is kept)', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        plan: 'chat',
        cycleStartedAt: new Date(),
        renewsAt: FUTURE,
        anchorDay: FUTURE.getUTCDate(),
      }),
    );
    // Not in grace (no failed renewal): a grace lapse must not land.
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:test', 'grace'),
      ),
    ).toBeNull();
    expect((await planOf(businessId))?.plan).toBe('chat');
  });

  it('the trial insert is not touched by the guard', async () => {
    const businessId = await seedBusiness();
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect((await planOf(businessId))?.plan_expires_at).not.toBeNull();
  });
});

describe('OD-37: the boundary itself', () => {
  it('a writer refuses a business other than the pinned tenant', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, b, (tx) =>
          tx.execute(
            sql`SELECT subscription_write_plan(${a}::uuid, 'complete', ${FUTURE.toISOString()}::timestamptz)`,
          ),
        ),
      ),
    ).toMatch(/42501.*not the pinned tenant/);
    expect(
      await outcome(
        appDb.execute(sql`SELECT subscription_expire_plan(${a}::uuid, 'trial', 'grace')`),
      ),
    ).toMatch(/not the pinned tenant/);
    expect((await planOf(a))?.plan).toBe('trial');
  });

  it('the owner may repair directly (migrations and administration)', async () => {
    const businessId = await seedBusiness();
    await ownerDb.execute(
      sql`UPDATE businesses SET plan = 'chat', plan_expires_at = ${FUTURE.toISOString()}::timestamptz WHERE id = ${businessId}::uuid`,
    );
    expect((await planOf(businessId))?.plan).toBe('chat');
  });

  it('is built from the role, not a definer trigger: the catalogue says so', async () => {
    const procs = await ownerDb.execute<{ proname: string; prosecdef: boolean; owner: string }>(sql`
      SELECT p.proname, p.prosecdef, p.proowner::regrole::text AS owner FROM pg_proc p
      WHERE p.proname IN ('subscription_write_plan', 'subscription_expire_plan',
                          'businesses_plan_fields_guard') ORDER BY p.proname`);
    expect([...procs]).toEqual([
      { proname: 'businesses_plan_fields_guard', prosecdef: false, owner: expect.any(String) },
      { proname: 'subscription_expire_plan', prosecdef: true, owner: 'rekoda_plan_writer' },
      { proname: 'subscription_write_plan', prosecdef: true, owner: 'rekoda_plan_writer' },
    ]);
    const role = [
      ...(await ownerDb.execute<{
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        members: number;
      }>(sql`
        SELECT r.rolcanlogin, r.rolbypassrls,
               (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid
                  AND m.member::regrole::text IN ('rekoda_app', 'rekoda_worker'))::int AS members
        FROM pg_roles r WHERE r.rolname = 'rekoda_plan_writer'`)),
    ][0];
    expect(role).toEqual({ rolcanlogin: false, rolbypassrls: false, members: 0 });
  });

  it('the documented rollback statement is valid (run and undone inside one transaction)', async () => {
    let dropped = false;
    await ownerDb
      .transaction(async (tx) => {
        await tx.execute(sql`DROP TRIGGER businesses_plan_fields_guard ON businesses`);
        dropped = true;
        tx.rollback();
      })
      /* Only the deliberate rollback is swallowed: a failed DROP must fail the test. */
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    expect(dropped).toBe(true);
    const still = await ownerDb.execute(
      sql`SELECT 1 FROM pg_trigger WHERE tgname = 'businesses_plan_fields_guard'`,
    );
    expect([...still]).toHaveLength(1);
  });
});
