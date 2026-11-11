/**
 * OD-37 / OWN-88 (migration 0200): each plan writer accepts only what its caller is entitled to do.
 *
 * The provider writer takes the plan from a paid, unapplied plan charge of the
 * business and applies a charge at most once; the operator writer takes a known plan, a sane date
 * for a paid plan and a named actor, and only the API credential may call it; the general writer is
 * gone; a new business starts on its trial. The role boundary itself is pinned in
 * plan-fields-guard.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
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
  ] as const)('refuses %s', async (_label, spec) => {
    const businessId = await seedBusiness();
    const reference =
      'exists' in spec ? 'RKD-SUB-NOPE-000001' : await seedCharge(businessId, spec as ChargeSpec);
    // The writer's own refusal, not some other 42501 (RLS, a missing grant).
    expect(await apply(businessId, reference)).toMatch(
      /^42501 subscription_apply_paid_charge: (no such charge for this business|the charge is not a paid, unapplied plan charge)/,
    );
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it("refuses another business's paid charge, even with the pin repointed", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const reference = await seedCharge(a, { plan: 'complete' });
    expect(await apply(b, reference)).toMatch(
      /^42501 subscription_apply_paid_charge: no such charge for this business/,
    );
    expect((await planOf(b))?.plan).toBe('trial');
  });

  it('applies a paid charge that was superseded as the payable link (it still buys its cycle, G-104)', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat', superseded: true });
    expect(await apply(businessId, reference)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('chat');
  });

  it('applies one paid charge at most once: the writer claims the charge itself', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference)).toBe('allowed');
    // No markChargeApplied in between: a second call for the same charge is refused by the writer.
    expect(await apply(businessId, reference, new Date(Date.now() + 300 * 86_400_000))).toMatch(
      /42501.*not a paid, unapplied plan charge/,
    );
    const [row] = await ownerDb.execute<{ end: string | null }>(
      sql`SELECT applied_period_end AS end FROM subscription_charges WHERE reference = ${reference}`,
    );
    expect(new Date(row!.end!).toISOString()).toBe(FUTURE.toISOString());
  });

  it('an applied charge cannot be un-applied by the application to buy a second cycle', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference)).toBe('allowed');
    for (const column of ['applied_period_end', 'applied_period_start']) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(
              sql`UPDATE subscription_charges SET ${sql.raw(column)} = NULL WHERE reference = ${reference}`,
            ),
          ),
        ),
      ).toMatch(/^42501 a charge's applied period cannot be cleared/);
    }
    expect(await apply(businessId, reference)).toMatch(/42501.*not a paid, unapplied plan charge/);
    // Re-recording the period it bought (markChargeApplied after the writer) is still allowed.
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          subscriptionsRepo.markChargeApplied(tx, reference, new Date(), FUTURE),
        ),
      ),
    ).toBe('allowed');
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

  it('refuses an unknown plan, a paid plan dated outside the accepted window, and a missing or system actor', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'platinum', FUTURE)).toMatch(/22023/);
    expect(await set(businessId, 'chat', new Date(Date.now() - 500 * 86_400_000))).toMatch(
      /22023.*outside the accepted window/,
    );
    expect(await set(businessId, 'chat', new Date('2099-01-01T00:00:00Z'))).toMatch(
      /22023.*outside the accepted window/,
    );
    // The actor must be the operator-plane subject the route passes, `operator:<subject>`.
    for (const actor of [
      '',
      'system:grace-sweep',
      'user:ada',
      'operator:',
      'operator:a b',
      'ops',
    ]) {
      expect(await set(businessId, 'chat', FUTURE, actor)).toMatch(/^22023 .*invalid input/);
    }
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('records its own audit row in the same transaction: no operator plan change without one', async () => {
    const businessId = await seedBusiness();
    const before = await planOf(businessId);
    expect(await set(businessId, 'complete', FUTURE, 'operator:alice')).toBe('allowed');
    const rows = await ownerDb.execute<{
      actor: string;
      action: string;
      source_type: string;
      old_value: { plan: string; expiresAt: string | null };
      new_value: { plan: string; expiresAt: string | null };
    }>(sql`
      SELECT actor, action, source_type, old_value, new_value FROM audit_events
      WHERE business_id = ${businessId}::uuid AND entity = 'business' AND action = 'plan_changed'`);
    expect([...rows]).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'operator:alice',
      source_type: 'operator',
      old_value: { plan: 'trial', expiresAt: new Date(before!.plan_expires_at!).toISOString() },
      new_value: { plan: 'complete', expiresAt: FUTURE.toISOString() },
    });
    // A refused call leaves no row.
    expect(await set(businessId, 'platinum', FUTURE)).toMatch(/22023/);
    const [count] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'`,
    );
    expect(count!.n).toBe(1);
  });

  it('accepts a known plan with a future or open-ended date, and a lapse to expired with any date', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'complete', null)).toBe('allowed');
    expect(await set(businessId, 'chat', FUTURE)).toBe('allowed');
    expect(await set(businessId, 'expired', new Date(Date.now() - 86_400_000))).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('expired');
    // An OIDC subject may be up to 255 characters: the longest is accepted, one more is refused.
    expect(await set(businessId, 'chat', FUTURE, `operator:${'s'.repeat(255)}`)).toBe('allowed');
    expect(await set(businessId, 'chat', FUTURE, `operator:${'s'.repeat(256)}`)).toMatch(/^22023/);
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
  it('the application cannot insert a business on a paid plan, with a long trial or an ended one', async () => {
    const user = await identity.upsertUserByPhone(appDb, '+2348060009901');
    /* Under a real tenant pin, the path signup uses (createBusinessWithOwner): without the pin RLS
     * refuses first, which would prove nothing about the guard. The guard's own message is
     * matched, not just the SQLSTATE RLS shares. */
    const insertAs = (plan: string, days: number | null) => {
      const id = randomUUID();
      return withBusiness(appDb, id, (tx) =>
        tx.execute(sql`
          INSERT INTO businesses (id, name, owner_user_id, plan, plan_expires_at)
          VALUES (${id}::uuid, 'Forged', ${user.id}::uuid, ${plan},
                  ${days === null ? sql`NULL` : sql`now() + make_interval(days => ${days})`})`),
      );
    };
    for (const [plan, days] of [
      ['complete', 30],
      ['trial', 90],
      ['trial', null],
      // A trial that has already ended reads as expired the moment it is created (Qodo, PR #432).
      ['trial', -1],
      ['trial', 0],
    ] as const) {
      expect(await outcome(insertAs(plan, days))).toMatch(
        /^42501 a new business starts on its trial/,
      );
    }
    // Control: the same pinned insert with an ordinary 14-day trial is allowed.
    expect(await outcome(insertAs('trial', 14))).toBe('allowed');
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
