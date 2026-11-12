/**
 * OD-37 (migrations 0200, 0202, 0203; owner review of PR #432, 11 Nov 2026): WHO may record a payment, apply a paid
 * plan or make an operator plan change (the principals); what each writer accepts is pinned in
 * plan-writer-boundary.integration.test.ts.
 *
 *   rekoda_settlement        the only non-owner role that records a payment on a charge, credits
 *                            pack units, holds an add-on, or runs `subscription_apply_paid_charge`;
 *   rekoda_billing_operator  the only role that runs `subscription_operator_set_plan`;
 *   rekoda_app, rekoda_worker neither: a holder of the general credentials cannot forge a paid
 *                            charge, credit units, or make an operator plan change.
 *
 * Every assertion is made on a live connection AS that principal (the CI database authenticates by
 * trust, so each URL is its own role), never through the owner. The writers enforce Rekoda's real
 * durations: a monthly plan ends within one calendar month, an annual plan within twelve, a trial
 * within 14 days of the business's own trial start, `expired` at or before now; the database's copy
 * of the length rule is pinned to `@rekoda/core` here. The plan-field role boundary itself is pinned
 * in plan-fields-guard.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { bootChecks, subscriptionsRepo, usageRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  seedCharge,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
  type Principal,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

describe('OD-37: who may run which writer, and who may become whom (0202)', () => {
  it('EXECUTE is exactly one principal per reserved writer; the general writers are gone', async () => {
    const acl = await ownerDb.execute<{ proname: string; grantee: string }>(sql`
      SELECT p.proname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.proname IN ('subscription_apply_paid_charge', 'subscription_operator_set_plan',
                          'subscription_expire_plan')
        AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
      ORDER BY p.proname, 2`);
    const byName = (name: string) =>
      [...acl].filter((r) => r.proname === name).map((r) => r.grantee);
    expect(byName('subscription_apply_paid_charge')).toEqual(['rekoda_settlement']);
    expect(byName('subscription_operator_set_plan')).toEqual(['rekoda_billing_operator']);
    expect(byName('subscription_expire_plan')).toEqual(['rekoda_app', 'rekoda_worker']);
    const [gone] = await ownerDb.execute<{
      general: string | null;
      old_operator: string | null;
    }>(sql`
      SELECT to_regprocedure('public.subscription_write_plan(uuid,text,timestamptz)')::text AS general,
             to_regprocedure('public.subscription_operator_set_plan(uuid,text,timestamptz,text)')::text
               AS old_operator`);
    expect(gone).toEqual({ general: null, old_operator: null });
  });

  it.each([
    ['app', false, false],
    ['worker', false, false],
    ['settlement', true, false],
    ['operator', false, true],
  ] as const)(
    '%s, on its own live connection: provider writer %s, operator writer %s',
    async (who: Principal, provider, operator) => {
      const [facts] = await PRINCIPALS[who]().execute<{ provider: boolean; operator: boolean }>(sql`
        SELECT has_function_privilege('public.subscription_apply_paid_charge(uuid,text,timestamptz)', 'EXECUTE') AS provider,
               has_function_privilege('public.subscription_operator_set_plan(uuid,text,timestamptz,text,text)', 'EXECUTE') AS operator`);
      expect(facts).toEqual({ provider, operator });
    },
  );

  it('no principal can become another, the worker or the plan writer; settlement acts with the application rights, the operator with none (0211)', async () => {
    const [m] = await ownerDb.execute<Record<string, boolean>>(sql`
      SELECT
        pg_has_role('rekoda_app', 'rekoda_settlement', 'MEMBER') AS app_settlement,
        pg_has_role('rekoda_worker', 'rekoda_settlement', 'MEMBER') AS worker_settlement,
        pg_has_role('rekoda_app', 'rekoda_billing_operator', 'MEMBER') AS app_operator,
        pg_has_role('rekoda_worker', 'rekoda_billing_operator', 'MEMBER') AS worker_operator,
        pg_has_role('rekoda_settlement', 'rekoda_billing_operator', 'MEMBER') AS settlement_operator,
        pg_has_role('rekoda_billing_operator', 'rekoda_settlement', 'MEMBER') AS operator_settlement,
        pg_has_role('rekoda_settlement', 'rekoda_worker', 'MEMBER') AS settlement_worker,
        pg_has_role('rekoda_billing_operator', 'rekoda_worker', 'MEMBER') AS operator_worker,
        pg_has_role('rekoda_settlement', 'rekoda_plan_writer', 'MEMBER') AS settlement_writer,
        pg_has_role('rekoda_billing_operator', 'rekoda_plan_writer', 'MEMBER') AS operator_writer,
        pg_has_role('rekoda_settlement', 'rekoda_app', 'USAGE') AS settlement_inherits_app,
        pg_has_role('rekoda_billing_operator', 'rekoda_app', 'USAGE') AS operator_inherits_app,
        (SELECT bool_or(rolsuper OR rolbypassrls) FROM pg_roles
          WHERE rolname IN ('rekoda_settlement', 'rekoda_billing_operator')) AS any_bypass`);
    expect(m).toEqual({
      app_settlement: false,
      worker_settlement: false,
      app_operator: false,
      worker_operator: false,
      settlement_operator: false,
      operator_settlement: false,
      settlement_worker: false,
      operator_worker: false,
      settlement_writer: false,
      operator_writer: false,
      settlement_inherits_app: false, // since 0217 (OD-51.3): its own exact grants
      operator_inherits_app: false,
      any_bypass: false,
    });
    // SET ROLE is refused too, whatever a connection asks for.
    for (const [db, role] of [
      [appDb, 'rekoda_settlement'],
      [workerDb, 'rekoda_billing_operator'],
      [settlementDb, 'rekoda_billing_operator'],
      [operatorDb, 'rekoda_settlement'],
      [settlementDb, 'rekoda_app'],
    ] as const) {
      expect(
        await outcome(db.transaction((tx) => tx.execute(sql.raw(`SET LOCAL ROLE ${role}`)))),
      ).toMatch(/42501|permission denied/);
    }
  });

  it('the boot checks refuse a database whose guard triggers are disabled', async () => {
    await ownerDb.execute(
      sql`ALTER TABLE subscription_charges DISABLE TRIGGER subscription_charges_settlement_guard`,
    );
    try {
      await expect(
        bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application'),
      ).rejects.toThrow(/guard triggers are missing or disabled/);
      await expect(
        bootChecks.assertDatabasePrincipal(settlementDb, 'settlement', 'rekoda_settlement'),
      ).rejects.toThrow(/guard triggers are missing or disabled/);
    } finally {
      await ownerDb.execute(
        sql`ALTER TABLE subscription_charges ENABLE TRIGGER subscription_charges_settlement_guard`,
      );
    }
    await bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application');
  });

  it('the boot checks refuse the cycle-input guard disabled, a table-owner credential, and the test fixture writer', async () => {
    await ownerDb.execute(
      sql`ALTER TABLE businesses DISABLE TRIGGER businesses_cycle_fields_guard`,
    );
    try {
      await expect(
        bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application'),
      ).rejects.toThrow(/guard triggers are missing or disabled/);
    } finally {
      await ownerDb.execute(
        sql`ALTER TABLE businesses ENABLE TRIGGER businesses_cycle_fields_guard`,
      );
    }
    await expect(
      bootChecks.assertRoleHoldsNoReservedWriter(ownerDb, 'application'),
    ).rejects.toThrow(/can act as the owner of the guarded tables/);
    // A runtime role that could create a function in public could switch the cycle guard off (0206).
    await ownerDb.execute(sql`GRANT CREATE ON SCHEMA public TO rekoda_app`);
    try {
      await expect(
        bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application'),
      ).rejects.toThrow(/can create objects in schema public/);
    } finally {
      await ownerDb.execute(sql`REVOKE CREATE ON SCHEMA public FROM rekoda_app`);
    }
    // This harness installs the fixture writer, as every test database does; a served one never has it.
    await expect(bootChecks.assertNoTestFixtureWriter(appDb)).rejects.toThrow(/test-only fixture/);
  });

  it('the boot checks pass for the real principals and refuse the general credentials in their place', async () => {
    await bootChecks.assertDatabasePrincipal(settlementDb, 'settlement', 'rekoda_settlement');
    await bootChecks.assertDatabasePrincipal(operatorDb, 'operator', 'rekoda_billing_operator');
    await bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application');
    await bootChecks.assertRoleHoldsNoReservedWriter(workerDb, 'worker');
    // A settlement URL that points at the application role (the silent fallback) refuses to boot.
    await expect(
      bootChecks.assertDatabasePrincipal(appDb, 'settlement', 'rekoda_settlement'),
    ).rejects.toThrow(/logs in as "rekoda_app", not rekoda_settlement/);
    await expect(
      bootChecks.assertDatabasePrincipal(settlementDb, 'operator', 'rekoda_billing_operator'),
    ).rejects.toThrow(/not rekoda_billing_operator/);
    // The principals themselves would fail the general check (they hold a reserved writer).
    await expect(
      bootChecks.assertRoleHoldsNoReservedWriter(settlementDb, 'application'),
    ).rejects.toThrow(/can run public\.subscription_apply_paid_charge/);
    // A grant that widens the application role is caught on the next boot.
    await ownerDb.execute(
      sql`GRANT EXECUTE ON FUNCTION subscription_apply_paid_charge(uuid,text,timestamptz) TO rekoda_app`,
    );
    try {
      await expect(
        bootChecks.assertRoleHoldsNoReservedWriter(appDb, 'application'),
      ).rejects.toThrow(/can run public\.subscription_apply_paid_charge/);
      // ...and settlement inherits rekoda_app, which a grant to it widens too; the operator does
      // not inherit it since 0211, so the same grant does not reach the operator.
      await expect(
        bootChecks.assertDatabasePrincipal(operatorDb, 'operator', 'rekoda_billing_operator'),
      ).resolves.toBeUndefined();
    } finally {
      await ownerDb.execute(
        sql`REVOKE EXECUTE ON FUNCTION subscription_apply_paid_charge(uuid,text,timestamptz) FROM rekoda_app`,
      );
    }
  });

  it('the boot check refuses an operator given the application rights back (0211)', async () => {
    await ownerDb.execute(sql`GRANT rekoda_app TO rekoda_billing_operator`);
    try {
      await expect(
        bootChecks.assertDatabasePrincipal(operatorDb, 'operator', 'rekoda_billing_operator'),
      ).rejects.toThrow(/acts with rekoda_app's rights/);
    } finally {
      await ownerDb.execute(sql`REVOKE rekoda_app FROM rekoda_billing_operator`);
    }
  });
});

describe('OD-37: only settlement records a payment (0202)', () => {
  it.each(['app', 'worker', 'operator'] as const)(
    '%s cannot open a charge already paid, settle a pending one, or write payment evidence',
    async (who) => {
      const db = PRINCIPALS[who]();
      const businessId = await seedBusiness();
      const pending = await seedCharge(businessId, { status: 'pending' });
      const insertPaid = withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO subscription_charges
            (business_id, kind, plan, amount_k, status, reference, period_start, period_end, paid_at)
          VALUES (${businessId}::uuid, 'first_purchase', 'complete', 1000, 'paid', ${`FORGED-${who}`},
                  now(), now() + interval '30 days', now())`),
      );
      // The worker has no tenant write path at all on a pinned insert beyond RLS; any refusal is a
      // refusal, but the application roles must be refused by the guard itself.
      const forged = await outcome(insertPaid);
      expect(forged).toMatch(/42501/);
      // Since 0209 the application roles may open only a pristine pending charge (settlement
      // re-prices it); the worker (0210) and the operator (0211) may not insert one at all.
      expect(forged).toMatch(
        who !== 'app'
          ? /permission denied for table subscription_charges/
          : /the application opens only a new pending charge/,
      );
      const settled = await outcome(
        withBusiness(db, businessId, (tx) =>
          subscriptionsRepo.settleCharge(tx, {
            reference: pending,
            status: 'paid',
            paidAmountK: 1000,
            when: new Date(),
          }),
        ),
      );
      expect(settled).toMatch(/42501/);
      const [row] = await ownerDb.execute<{ status: string; paid_at: string | null }>(
        sql`SELECT status, paid_at FROM subscription_charges WHERE reference = ${pending}`,
      );
      expect(row).toEqual({ status: 'pending', paid_at: null });
      const [forgedRow] = await ownerDb.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM subscription_charges WHERE reference = ${`FORGED-${who}`}`,
      );
      expect(forgedRow!.n).toBe(0);
    },
  );

  it('the application cannot relabel a paid charge, move it to another business, or rewrite its evidence', async () => {
    const businessId = await seedBusiness();
    const pack = await seedCharge(businessId, { kind: 'add_on', plan: null });
    for (const change of [
      sql`kind = 'renewal', plan = 'complete', pack_id = NULL`,
      sql`amount_k = 1`,
      sql`paid_at = now() - interval '1 day'`,
      sql`paid_amount_k = 999999`,
      sql`units_credited_at = now()`,
      sql`period_end = now() + interval '10 years'`,
      sql`billing_interval = 'annual'`,
    ]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET ${change} WHERE reference = ${pack}`),
          ),
        ),
      ).toMatch(
        /^42501 (what a charge buys is set when it is opened|only settlement records a payment)/,
      );
    }
  });

  it('settlement records a payment exactly once; the application may still refund and work the lifecycle', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { status: 'pending' });
    const settle = () =>
      withBusiness(settlementDb, businessId, (tx) =>
        subscriptionsRepo.settleCharge(tx, {
          reference,
          status: 'paid',
          paidAmountK: 1000,
          when: new Date(),
        }),
      );
    expect((await settle())?.status).toBe('paid');
    expect(await settle()).toBeNull();
    // Refunds take entitlement away and stay with the application (the ops refund route).
    const refunded = await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.refundCharge(tx, reference, 1000, new Date()),
    );
    expect(refunded?.status).toBe('refunded');
    // ...and a refunded charge cannot be made paid again by it.
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`UPDATE subscription_charges SET status = 'paid' WHERE reference = ${reference}`,
          ),
        ),
      ),
    ).toMatch(/^42501 only settlement moves a charge's status/);
  });
});

describe('OD-37: what a charge buys is frozen from its opening to its end (0205, 0209)', () => {
  it.each(['app', 'worker', 'operator'] as const)(
    '%s opens at most a pristine pending charge, whose price settlement checks before applying it (0209)',
    async (who) => {
      const businessId = await seedBusiness();
      const opened = await outcome(
        withBusiness(PRINCIPALS[who](), businessId, (tx) =>
          subscriptionsRepo.openCharge(tx, {
            businessId,
            kind: 'first_purchase',
            plan: 'complete',
            amountK: 100,
            reference: `CHEAP-${who}`,
            periodStart: new Date(),
            periodEnd: new Date(Date.now() + 365 * 86_400_000),
          }),
        ),
      );
      // The worker (0210) and the operator (0211) hold no write on charges at all.
      if (who !== 'app') {
        expect(opened).toMatch(/^42501 .*permission denied for table subscription_charges/);
        return;
      }
      // Opened, but only as an unpaid charge; that 100 kobo does not buy a year of Complete is
      // settlement's check (apps/api settlement-verifies-price.integration.test.ts).
      expect(opened).toBe('allowed');
      const [row] = await ownerDb.execute<{ status: string; paid: boolean }>(
        sql`SELECT status, paid_at IS NOT NULL AS paid FROM subscription_charges WHERE reference = ${`CHEAP-${who}`}`,
      );
      expect(row).toEqual({ status: 'pending', paid: false });
    },
  );

  it('the application cannot reprice, relabel or stretch a PENDING charge before it is paid', async () => {
    const businessId = await seedBusiness();
    const pending = await seedCharge(businessId, { status: 'pending' });
    for (const change of [
      sql`amount_k = 1`,
      sql`billing_interval = 'annual'`,
      sql`plan = 'complete'`,
      sql`kind = 'renewal'`,
      sql`quantity = 50`,
      sql`pack_id = 'whatsapp_500'`,
      sql`period_end = now() + interval '10 years'`,
      sql`created_at = now() + interval '1 day'`,
    ]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET ${change} WHERE reference = ${pending}`),
          ),
        ),
        String(change.queryChunks[0]),
      ).toMatch(/^42501 what a charge buys is set when it is opened/);
    }
  });

  it.each([
    ['paid', 'pending'],
    ['paid', 'failed'],
    ['refunded', 'pending'],
    ['refunded', 'paid'],
    ['pending', 'failed'],
  ] as const)(
    'the application cannot move a %s charge to %s (a verified payment is settled once)',
    async (from, to) => {
      const businessId = await seedBusiness();
      const reference = await seedCharge(businessId, {
        status: from === 'refunded' ? 'paid' : from,
      });
      if (from === 'refunded') {
        await withBusiness(appDb, businessId, (tx) =>
          subscriptionsRepo.refundCharge(tx, reference, 1000, new Date()),
        );
      }
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(
              sql`UPDATE subscription_charges SET status = ${to} WHERE reference = ${reference}`,
            ),
          ),
        ),
      ).toMatch(/^42501/);
    },
  );

  it('the application cannot reopen a paid charge that was set aside (unapplied or superseded)', async () => {
    const businessId = await seedBusiness();
    const aside = await seedCharge(businessId, { unapplied: true, superseded: true });
    for (const change of [sql`unapplied_at = NULL`, sql`superseded_at = NULL`]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET ${change} WHERE reference = ${aside}`),
          ),
        ),
      ).toMatch(/^42501/);
    }
  });

  it('the application still works the lifecycle around a charge: supersede, checkout link, block, refund, review', async () => {
    const businessId = await seedBusiness();
    const pending = await seedCharge(businessId, { status: 'pending', kind: 'renewal' });
    for (const change of [
      sql`superseded_at = now(), abandoned_at = now()`,
      sql`superseded_at = NULL, abandoned_at = NULL`,
      sql`checkout_url = 'https://checkout.paystack.com/x', checkout_started_at = now()`,
      sql`blocked_at = now(), blocked_reason = 'awaiting_platform_confirmation'`,
      sql`blocked_resolved_at = now(), blocked_resolved_by = 'system:gate_open', blocked_resolution = 'open'`,
    ]) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(sql`UPDATE subscription_charges SET ${change} WHERE reference = ${pending}`),
          ),
        ),
      ).toBe('allowed');
    }
    const aside = await seedCharge(businessId, { unapplied: true });
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          subscriptionsRepo.resolveUnapplied(tx, aside, 'refunded by hand', 'operator:ada'),
        ),
      ),
    ).toBe('allowed');
    const paid = await seedCharge(businessId);
    expect(
      (
        await withBusiness(appDb, businessId, (tx) =>
          subscriptionsRepo.refundCharge(tx, paid, 1000, new Date()),
        )
      )?.status,
    ).toBe('refunded');
  });
});

describe('OD-37: only settlement credits pack units or records an add-on holding (0202)', () => {
  /* Since 0216 (OD-51.4) a ceiling is raised only by usage_credit_pack, for one paid pack charge;
   * the whole boundary is pinned in usage-meter-boundary.integration.test.ts. */
  it.each(['app', 'worker', 'operator'] as const)(
    '%s cannot raise a meter ceiling',
    async (who) => {
      const businessId = await seedBusiness();
      const reference = await seedCharge(businessId, { kind: 'add_on', plan: null });
      const credit = await outcome(
        withBusiness(PRINCIPALS[who](), businessId, (tx) =>
          usageRepo.creditPack(tx, businessId, reference, '2026-11', 'AI_ACTIONS', 500),
        ),
      );
      expect(credit).toMatch(/^42501 permission denied for function usage_credit_pack/);
    },
  );

  it("consumption stays the application's; settlement credits a paid pack charge", async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        usageRepo.consumeUnit(tx, businessId, '2026-11', 'AI_ACTIONS', 50),
      ),
    ).toBe(true);
    const reference = await seedCharge(businessId, { kind: 'add_on', plan: null });
    expect(
      await withBusiness(settlementDb, businessId, (tx) =>
        usageRepo.creditPack(tx, businessId, reference, '2026-11', 'AI_ACTIONS', 7),
      ),
    ).toBe(true);
    const [row] = await ownerDb.execute<{ bonus: number }>(
      sql`SELECT bonus FROM usage_counters WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS'`,
    );
    expect(row!.bonus).toBe(7);
  });

  it('the application can no longer insert or change an add-on holding; settlement can', async () => {
    const [facts] = await ownerDb.execute<Record<string, boolean>>(sql`
      SELECT has_table_privilege('rekoda_app', 'business_add_ons', 'INSERT') AS app_insert,
             has_table_privilege('rekoda_app', 'business_add_ons', 'UPDATE') AS app_update,
             has_table_privilege('rekoda_billing_operator', 'business_add_ons', 'INSERT') AS operator_insert,
             has_table_privilege('rekoda_settlement', 'business_add_ons', 'INSERT') AS settlement_insert,
             has_table_privilege('rekoda_settlement', 'business_add_ons', 'UPDATE') AS settlement_update`);
    expect(facts).toEqual({
      app_insert: false,
      app_update: false,
      operator_insert: false,
      settlement_insert: true,
      settlement_update: true,
    });
  });
});
