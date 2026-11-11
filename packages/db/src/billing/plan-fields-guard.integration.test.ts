/**
 * OD-37 (PR B item 5; migrations 0196 and 0200): `businesses.plan` and `businesses.plan_expires_at`
 * change only through purpose-specific subscription writers, enforced by the database.
 *
 * The exemption is a ROLE (`rekoda_plan_writer`, the owner of the SECURITY DEFINER writers), never a
 * setting: no session or transaction setting, and no role the application holds, reaches it. Each
 * writer accepts only what its caller is entitled to do (0200): the provider writer takes the plan
 * from a paid, unapplied charge of the business; the operator writer takes a known plan and a sane
 * date and is executable by the API credential only. The table owner keeps migrations and an
 * administrator's repair.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { billingRepo, identity, subscriptionsRepo } from '../index.js';
import { applyFixtureCycle, migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

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

interface ChargeSpec {
  plan?: string | null;
  kind?: string;
  status?: string;
  applied?: boolean;
  unapplied?: boolean;
  superseded?: boolean;
}

let chargeSeq = 0;
/** A subscription charge for the business, written as the application would (under the pin). */
async function seedCharge(businessId: string, spec: ChargeSpec = {}): Promise<string> {
  chargeSeq += 1;
  const reference = `RKD-SUB-OD37-${String(chargeSeq).padStart(6, '0')}`;
  const kind = spec.kind ?? 'first_purchase';
  const plan = spec.plan === undefined ? 'chat' : spec.plan;
  const status = spec.status ?? 'paid';
  await withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, pack_id, amount_k, status, reference, period_start, period_end,
         paid_at, applied_period_start, applied_period_end, unapplied_at, unapplied_reason,
         superseded_at)
      VALUES (${businessId}::uuid, ${kind}, ${plan},
        ${kind === 'add_on' ? 'whatsapp_500' : null}, 1000, ${status}, ${reference},
        now(), now() + interval '30 days',
        ${status === 'paid' ? sql`now()` : sql`NULL`},
        ${spec.applied ? sql`now()` : sql`NULL`}, ${spec.applied ? sql`now() + interval '30 days'` : sql`NULL`},
        ${spec.unapplied ? sql`now()` : sql`NULL`}, ${spec.unapplied ? 'cycle_ended' : null},
        ${spec.superseded ? sql`now()` : sql`NULL`})`),
  );
  return reference;
}

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
      sql`SELECT set_config('session_replication_role', 'replica', true)`,
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
      ).toMatch(/42501|permission denied/);
    }
    // Repointing the tenant pin hides the row from the update (RLS): nothing is written either.
    await withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.business_id', '00000000-0000-4000-8000-000000000000', true)`,
      );
      await tx.execute(sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`);
    });
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
  it('a provider cycle (applyCycle with its paid charge) moves the plan and the date together', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.applyCycle(tx, businessId, {
        chargeReference: reference,
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
      applyFixtureCycle(tx, businessId, {
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
    const reference = await seedCharge(a, { plan: 'complete' });
    expect(
      await outcome(
        withBusiness(appDb, b, (tx) =>
          tx.execute(
            sql`SELECT subscription_apply_paid_charge(${a}::uuid, ${reference}, ${FUTURE.toISOString()}::timestamptz)`,
          ),
        ),
      ),
    ).toMatch(/42501.*not the pinned tenant/);
    expect(
      await outcome(
        withBusiness(appDb, b, (tx) =>
          tx.execute(
            sql`SELECT subscription_operator_set_plan(${a}::uuid, 'complete', ${FUTURE.toISOString()}::timestamptz, 'operator:x')`,
          ),
        ),
      ),
    ).toMatch(/42501.*not the pinned tenant/);
    expect(
      await outcome(
        appDb.execute(sql`SELECT subscription_expire_plan(${a}::uuid, 'chat', 'grace')`),
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
      WHERE p.proname IN ('subscription_write_plan', 'subscription_apply_paid_charge',
                          'subscription_operator_set_plan', 'subscription_expire_plan',
                          'businesses_plan_fields_guard', 'businesses_plan_fields_insert_guard')
      ORDER BY p.proname`);
    expect([...procs]).toEqual([
      { proname: 'businesses_plan_fields_guard', prosecdef: false, owner: expect.any(String) },
      {
        proname: 'businesses_plan_fields_insert_guard',
        prosecdef: false,
        owner: expect.any(String),
      },
      { proname: 'subscription_apply_paid_charge', prosecdef: true, owner: 'rekoda_plan_writer' },
      { proname: 'subscription_expire_plan', prosecdef: true, owner: 'rekoda_plan_writer' },
      { proname: 'subscription_operator_set_plan', prosecdef: true, owner: 'rekoda_plan_writer' },
    ]);
    // Every writer pins its search_path.
    const paths = await ownerDb.execute<{ proname: string; config: string[] | null }>(sql`
      SELECT proname, proconfig AS config FROM pg_proc
      WHERE proname IN ('subscription_apply_paid_charge', 'subscription_operator_set_plan',
                        'subscription_expire_plan')`);
    for (const p of paths) {
      expect(p.config, p.proname).toContain('search_path=pg_catalog, public, pg_temp');
    }
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

  it("the application cannot create a function on the writers' search_path", async () => {
    expect(
      await outcome(
        appDb.execute(
          sql`CREATE FUNCTION public.plan_hijack() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        ),
      ),
    ).toMatch(/42501|permission denied/);
  });

  describe('migration 0196 refuses a credential that can become the writer role', () => {
    /** The membership check, taken from the migration itself so the test cannot drift from it. */
    const check = (() => {
      const text = readFileSync(
        new URL('../../migrations/0196_plan_fields_guard.sql', import.meta.url),
        'utf8',
      );
      const block = /DO \$\$\nDECLARE\n {2}offender text;[\s\S]*?END \$\$;/.exec(text);
      if (!block) throw new Error('0196 membership check not found');
      return block[0];
    })();

    /** Run the check inside a transaction that is always rolled back, after `setup`. */
    async function runCheck(setup: string | null): Promise<string | undefined> {
      let state: string | undefined;
      await ownerDb
        .transaction(async (tx) => {
          if (setup) await tx.execute(sql.raw(setup));
          try {
            await tx.execute(sql.raw('SAVEPOINT membership_check'));
            await tx.execute(sql.raw(check));
          } catch (error) {
            const e = error as { code?: string; cause?: { code?: string } };
            state = e.cause?.code ?? e.code ?? 'unknown';
          }
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      return state;
    }

    it('passes when neither credential is a member', async () => {
      expect(await runCheck(null)).toBeUndefined();
    });

    it.each(['rekoda_app', 'rekoda_worker'])('fails when %s is a direct member', async (role) => {
      expect(await runCheck(`GRANT rekoda_plan_writer TO ${role}`)).toBe('42501');
    });

    it('fails when a credential is a member through another role', async () => {
      expect(
        await runCheck(
          `CREATE ROLE plan_writer_hop NOLOGIN; GRANT rekoda_plan_writer TO plan_writer_hop;
           GRANT plan_writer_hop TO rekoda_app`,
        ),
      ).toBe('42501');
    });
  });
});

describe('OD-37: who may execute which writer (0200)', () => {
  it('EXECUTE is explicit: no PUBLIC, the operator writer is the API credential only, the general writer is gone', async () => {
    const acl = await ownerDb.execute<{ proname: string; grantee: string }>(sql`
      SELECT p.proname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.proname IN ('subscription_apply_paid_charge', 'subscription_operator_set_plan',
                          'subscription_expire_plan')
        AND a.privilege_type = 'EXECUTE'
      ORDER BY p.proname, 2`);
    const byName = (name: string) =>
      [...acl].filter((r) => r.proname === name).map((r) => r.grantee);
    expect(byName('subscription_apply_paid_charge')).toEqual([
      'rekoda_app',
      'rekoda_plan_writer',
      'rekoda_worker',
    ]);
    expect(byName('subscription_operator_set_plan')).toEqual(['rekoda_app', 'rekoda_plan_writer']);
    expect(byName('subscription_expire_plan')).toEqual([
      'rekoda_app',
      'rekoda_plan_writer',
      'rekoda_worker',
    ]);
    const [general] = await ownerDb.execute<{ fn: string | null }>(
      sql`SELECT to_regprocedure('public.subscription_write_plan(uuid,text,timestamptz)')::text AS fn`,
    );
    expect(general!.fn).toBeNull();
  });

  it('the worker cannot call the operator writer', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(workerDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_operator_set_plan(${businessId}::uuid, 'complete', ${FUTURE.toISOString()}::timestamptz, 'operator:x')`,
          ),
        ),
      ),
    ).toMatch(/42501|permission denied/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });
});

describe('OD-37: the provider writer moves a plan only for a paid, unapplied charge (0200)', () => {
  const apply = (businessId: string, reference: string, expires = FUTURE) =>
    outcome(
      withBusiness(appDb, businessId, (tx) =>
        tx.execute(
          sql`SELECT subscription_apply_paid_charge(${businessId}::uuid, ${reference}, ${expires.toISOString()}::timestamptz)`,
        ),
      ),
    );

  it('takes the plan from the charge, not from the caller', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'integrate' });
    expect(await apply(businessId, reference)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('integrate');
    // applyCycle refuses a cycle whose plan disagrees with the charge it names.
    const other = await seedBusiness();
    const chat = await seedCharge(other, { plan: 'chat' });
    await expect(
      withBusiness(appDb, other, (tx) =>
        subscriptionsRepo.applyCycle(tx, other, {
          chargeReference: chat,
          plan: 'complete',
          cycleStartedAt: new Date(),
          renewsAt: FUTURE,
          anchorDay: 1,
        }),
      ),
    ).rejects.toThrow(/different plan/);
    expect((await planOf(other))?.plan).toBe('trial');
  });

  it.each([
    ['no such charge', { exists: false }],
    ['a pending charge', { status: 'pending' }],
    ['a failed charge', { status: 'failed' }],
    ['an add-on charge', { kind: 'add_on', plan: null }],
    ['a charge already applied', { applied: true }],
    ['a charge marked unapplied', { unapplied: true }],
    ['a superseded charge', { superseded: true }],
  ] as const)('refuses %s', async (_label, spec) => {
    const businessId = await seedBusiness();
    const reference =
      'exists' in spec ? 'RKD-SUB-NOPE-000001' : await seedCharge(businessId, spec as ChargeSpec);
    expect(await apply(businessId, reference)).toMatch(/42501/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it("refuses another business's paid charge, even with the pin repointed", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const reference = await seedCharge(a, { plan: 'complete' });
    expect(await apply(b, reference)).toMatch(/42501/);
    expect((await planOf(b))?.plan).toBe('trial');
  });

  it('applies one paid charge at most once', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference)).toBe('allowed');
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.markChargeApplied(tx, reference, new Date(), FUTURE),
    );
    expect(await apply(businessId, reference)).toMatch(/42501.*not a paid, unapplied plan charge/);
  });

  it("refuses a renewal date far outside the charge's cycle, and empty inputs", async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference, new Date('2099-01-01T00:00:00Z'))).toMatch(/22023/);
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_apply_paid_charge(${businessId}::uuid, ${reference}, NULL)`,
          ),
        ),
      ),
    ).toMatch(/22023/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });
});

describe('OD-37: the operator writer validates its inputs (0200)', () => {
  const set = (businessId: string, plan: string, expires: Date | null, actor = 'operator:alice') =>
    outcome(
      withBusiness(appDb, businessId, (tx) =>
        tx.execute(
          sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan}, ${expires?.toISOString() ?? null}::timestamptz, ${actor})`,
        ),
      ),
    );

  it('refuses an unknown plan, a paid plan already past its date, and a missing or system actor', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'platinum', FUTURE)).toMatch(/22023/);
    expect(await set(businessId, 'chat', new Date(Date.now() - 86_400_000))).toMatch(
      /22023.*expiry in the future/,
    );
    expect(await set(businessId, 'chat', FUTURE, '')).toMatch(/22023/);
    expect(await set(businessId, 'chat', FUTURE, 'system:grace-sweep')).toMatch(/22023/);
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('accepts a known plan with a future or open-ended date, and a lapse to expired with any date', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'complete', null)).toBe('allowed');
    expect(await set(businessId, 'chat', FUTURE)).toBe('allowed');
    expect(await set(businessId, 'expired', new Date(Date.now() - 86_400_000))).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('expired');
  });

  it('the expiry writer refuses an unknown previous plan', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_expire_plan(${businessId}::uuid, 'platinum', 'grace')`,
          ),
        ),
      ),
    ).toMatch(/22023/);
  });
});

describe('OD-37: no other path writes the plan fields (0200)', () => {
  it('the application cannot insert a business on a paid plan or with a long trial', async () => {
    const user = await identity.upsertUserByPhone(appDb, '+2348060009901');
    for (const [plan, days] of [
      ['complete', 30],
      ['trial', 90],
    ] as const) {
      expect(
        await outcome(
          appDb.execute(sql`
            INSERT INTO businesses (name, owner_user_id, plan, plan_expires_at)
            VALUES ('Forged', ${user.id}::uuid, ${plan}, now() + make_interval(days => ${days}))`),
        ),
      ).toMatch(/42501/);
    }
    // The ordinary trial still starts.
    const businessId = await seedBusiness();
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('the migration re-runs cleanly as the owner (the repair path)', async () => {
    const text = readFileSync(
      new URL('../../migrations/0200_plan_writer_boundary.sql', import.meta.url),
      'utf8',
    );
    await ownerDb
      .transaction(async (tx) => {
        await tx.execute(sql.raw(text));
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    const [fn] = await ownerDb.execute<{ fn: string | null }>(
      sql`SELECT to_regprocedure('public.subscription_apply_paid_charge(uuid,text,timestamptz)')::text AS fn`,
    );
    expect(fn!.fn).not.toBeNull();
  });
});
