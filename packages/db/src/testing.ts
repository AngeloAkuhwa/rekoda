/**
 * Integration-test harness, published at `@rekoda/db/testing`.
 *
 * It lives in this package rather than in each test suite because it is the
 * only place allowed to open a connection at all: `apps/api` deliberately does
 * not depend on `postgres`, so the fixture reset has to be offered from here or
 * the boundary would have to be broken to test it.
 *
 * Three connection strings, because production has three: migrations run as
 * the schema OWNER, the application runs as `rekoda_app`, and background work
 * runs as `rekoda_worker`. Neither of the latter two is the owner and neither
 * has BYPASSRLS. Testing through a superuser would make every RLS assertion
 * vacuously pass — which is the specific failure mode this harness exists to
 * avoid.
 */
import postgres from 'postgres';
import { encryptFacet } from '@rekoda/core/vault';
import { pricingConstantsFingerprint } from '@rekoda/core';
import { sql as drizzleSql } from 'drizzle-orm';
import { applyMigrations } from './migrate.js';
import { createDb, withBusiness, type Db } from './client.js';
import { setPlanAsFixture, type PlanChange } from './repos/billing.js';
import { setBillingEmailSealed, writeCycle, type CycleInput } from './repos/subscriptions.js';
import type { TenantDb } from './client.js';

export interface Urls {
  /** Owner — DDL and fixture teardown. */
  owner: string;
  /** `rekoda_app` — everything the application itself does. */
  app: string;
  /**
   * `rekoda_worker` — the only role allowed to claim a job it has not yet
   * pinned a tenant for (migration 0004). Kept separate from `app` here for
   * the same reason it is separate in production: a test that claimed work
   * through the application's credentials would prove the opposite of what it
   * claims to.
   */
  worker: string;
  /**
   * `rekoda_settlement` (OD-37, migration 0202) - the only non-owner role that may record a payment
   * on a charge, credit pack units, hold an add-on, or run the provider plan writer.
   */
  settlement: string;
  /** `rekoda_billing_operator` (0202) - the only role that may run the operator plan writer. */
  operator: string;
}

/**
 * Missing configuration FAILS rather than skips.
 *
 * A skipped integration suite reports the same green tick as a passing one, so
 * the day the database disappears from CI is the day the tenancy proof
 * silently stops running. Better to be loudly red.
 */
export function requireUrls(): Urls {
  const owner = process.env['DATABASE_URL'];
  const app = process.env['APP_DATABASE_URL'];
  const worker = process.env['WORKER_DATABASE_URL'];
  const settlement = process.env['SETTLEMENT_DATABASE_URL'];
  const operator = process.env['OPERATOR_DATABASE_URL'];
  if (!owner || !app || !worker || !settlement || !operator) {
    throw new Error(
      'Integration tests need DATABASE_URL (owner), APP_DATABASE_URL (rekoda_app), ' +
        'WORKER_DATABASE_URL (rekoda_worker), SETTLEMENT_DATABASE_URL (rekoda_settlement) ' +
        'and OPERATOR_DATABASE_URL (rekoda_billing_operator). ' +
        'Start one with: docker compose -f docker-compose.dev.yml up -d',
    );
  }
  return { owner, app, worker, settlement, operator };
}

const principalPools = new Map<string, { db: Db; close: () => Promise<void> }>();

/**
 * A pool for one of the OD-37 principals (migration 0202): `settlement` (`rekoda_settlement`, the
 * only role that may record a payment on a charge, credit pack units, hold an add-on or apply a paid
 * plan) or `operator` (`rekoda_billing_operator`, the only role that may run the operator plan
 * writer). Cached per URL for the test file and closed by `closePrincipalPools`, which each
 * integration config's setup file calls after every file.
 */
export function principalDb(urls: Urls, which: 'settlement' | 'operator' | 'owner'): Db {
  const url = urls[which];
  let pool = principalPools.get(url);
  if (!pool) {
    pool = createDb(url, { max: 4 });
    principalPools.set(url, pool);
  }
  return pool.db;
}

/** `principalDb(requireUrls(), 'settlement')`: the settlement pool for a fixture. */
export const settlementDb = (): Db => principalDb(requireUrls(), 'settlement');
/** `principalDb(requireUrls(), 'operator')`: the billing-operator pool for a fixture. */
export const operatorDb = (): Db => principalDb(requireUrls(), 'operator');
/**
 * The table owner's pool, for fixtures that stage what only the owner may write: an explicit
 * entitlement grant (no runtime role writes `business_entitlements`, migration 0210).
 */
export const ownerDb = (): Db =>
  principalDb({ ...requireUrls(), owner: OWNER_URL_AT_LOAD ?? requireUrls().owner }, 'owner');

/* Captured when this module loads (the integration setup imports it before any test runs): several
 * API suites point DATABASE_URL at the application role before booting the app, and the owner pool
 * must stay the owner. */
const OWNER_URL_AT_LOAD = process.env['DATABASE_URL'];

export async function closePrincipalPools(): Promise<void> {
  const pools = [...principalPools.values()];
  principalPools.clear();
  await Promise.all(pools.map((p) => p.close()));
}

export async function migrate(urls: Urls): Promise<void> {
  await applyMigrations(urls.owner);
  await installTestFixtureWriter(urls.owner);
}

/**
 * A plan writer for TEST FIXTURES ONLY (OD-37, migration 0200).
 *
 * Production plan changes go through `subscription_apply_paid_charge` (a paid charge) or
 * `subscription_operator_set_plan` (validated operator input). Dozens of suites need a business on a
 * paid cycle without staging a charge for it, often with dates in the past to drive a sweep, which
 * those writers rightly refuse. This function is created by the test harness, never by a migration:
 * a production database does not have it (the staging deploy's pre-start smoke checks that), so
 * nothing outside a test can call it.
 */
async function installTestFixtureWriter(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    /* Every suite starts on the seeded pricing source (0215): one that ran on the constant path
     * (`setPricingSource`) must not leave the next suite's processes refusing to boot. */
    await client.unsafe(`
      DELETE FROM billing_pricing_source_history;
      UPDATE billing_pricing_source SET mode = 'catalogue', constants_fingerprint = NULL,
        set_by = 'migration:0215', reason = 'seeded with the default source'
      WHERE mode <> 'catalogue' OR set_by <> 'migration:0215';
    `);
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION public.test_fixture_set_plan(
        p_business uuid, p_plan text, p_expires timestamptz
      ) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        UPDATE public.businesses SET plan = p_plan, plan_expires_at = p_expires WHERE id = p_business;
      END $$;
      ALTER FUNCTION public.test_fixture_set_plan(uuid, text, timestamptz) OWNER TO rekoda_plan_writer;
      REVOKE ALL ON FUNCTION public.test_fixture_set_plan(uuid, text, timestamptz) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.test_fixture_set_plan(uuid, text, timestamptz)
        TO rekoda_app, rekoda_worker;
    `);
  } finally {
    await client.end();
  }
}

/**
 * A test fixture's plan move: the same state an operator move writes (G-62 cycle rules, origin
 * `operator` for a paid plan), written through the harness-only fixture writer with none of the
 * production duration rules or the operator principal, so a suite can stage an open-ended paid
 * plan or a trial that ended long ago. `db` is the application pool. Suites that test the operator
 * path itself call `billingRepo.setPlan` with the billing-operator pool instead.
 */
export async function setPlanForTest(db: Db, change: PlanChange): Promise<boolean> {
  return setPlanAsFixture(db, change);
}

/** Put a business on a paid cycle for a test, without a charge (see `installTestFixtureWriter`). */
export async function applyFixtureCycle(
  tx: TenantDb,
  businessId: string,
  cycle: CycleInput,
): Promise<void> {
  await writeCycle(tx, businessId, cycle, { kind: 'fixture' });
}

/**
 * Tables the migrations own and seed. Reference data, not fixture: the plan
 * catalogue, the entitlement keys, the provider rate cards. A test reads them
 * and none should have to recreate them, so teardown leaves them alone.
 *
 * This list is the exact set the previous `TRUNCATE ... CASCADE` preserved,
 * measured against a freshly migrated database rather than reasoned about.
 * `seedSurvivesTeardown` in testing.integration.test.ts pins it, so a typo
 * here fails loudly instead of quietly emptying a catalogue every test reads.
 */
const SEEDED_TABLES = [
  'rekoda_migrations',
  'entitlements',
  'plan_versions',
  'plan_prices',
  'plan_version_entitlements',
  'allowance_versions',
  'add_ons',
  'add_on_grants',
  'usage_packs',
  'provider_capabilities',
  'provider_cost_schedules',
  /* The pricing source in force (0215): one seeded row, put back to `catalogue` by `truncateAll`. */
  'billing_pricing_source',
] as const;

/**
 * Wipe tenant and identity fixtures between tests, as the owner.
 *
 * DELETE rather than TRUNCATE, and the reason is measured. `TRUNCATE` gives
 * every table and index a NEW relfilenode, so emptying ~100 already-empty
 * tables created a few hundred files that the next checkpoint had to fsync.
 * One CI checkpoint was seen writing 257 buffers — two megabytes — in 41.9
 * seconds because it was syncing 73,527 files. The suite was bound by file
 * churn, not by data: 183.5 ms per call against 1.5 ms for the same work
 * done with DELETE.
 *
 * `session_replication_role = replica` is not a shortcut around the schema's
 * own rules, it is what makes teardown possible at all. TRUNCATE bypasses row
 * triggers; DELETE does not, and three triggers exist specifically to refuse
 * deletion — `journal_draft_lock`, `journal_draft_lines_lock` and
 * `accounts_mandatory_role_guard`. Those guards protect a merchant's books,
 * not a fixture, and a test that left a posted draft behind would otherwise
 * make teardown fail. Replica mode also suspends foreign keys, so the order
 * tables are emptied in stops mattering — which is why this reads the table
 * list from the catalogue instead of maintaining one by hand. The previous
 * list had to be extended whenever a table was added, and a table nobody
 * remembered to add was simply never cleaned between tests.
 *
 * Requires the owner to be a superuser, which it is in development and in CI.
 * If it ever is not, `SET session_replication_role` raises rather than
 * silently leaving the guards on: a loud failure, not a quiet half-teardown.
 */
export async function truncateAll(urls: Urls): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND NOT (tablename = ANY(${[...SEEDED_TABLES]}::text[]))
       ORDER BY tablename
    `;
    if (rows.length === 0) return;
    const deletes = rows.map((r) => `DELETE FROM "${r.tablename}";`).join('\n');
    /* The pricing source goes back to the seeded default, so a suite that ran on the constant path
     * (`setPricingSource`) cannot leave the next one there. */
    await sql.unsafe(
      `SET session_replication_role = replica;\n${deletes}\n` +
        `UPDATE billing_pricing_source SET mode = 'catalogue', constants_fingerprint = NULL, ` +
        `set_by = 'migration:0215', reason = 'seeded with the default source' ` +
        `WHERE mode <> 'catalogue' OR set_by <> 'migration:0215';\n` +
        `SET session_replication_role = origin;`,
    );
  } finally {
    await sql.end();
  }
}

/**
 * Switch the pricing source in force for a test (OD-51.6, migration 0215), as the owner, through
 * the same function a deployment uses. `truncateAll` puts it back to `catalogue`, so a suite that
 * prices from the compiled constants calls this after it in `beforeEach`.
 */
export async function setPricingSource(
  urls: Urls,
  mode: 'catalogue' | 'constants',
  constantsFingerprint: string = pricingConstantsFingerprint(),
): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT rekoda_private.set_pricing_source(
      ${mode}, ${mode === 'constants' ? constantsFingerprint : null}, 'test:harness', 'test fixture')`;
  } finally {
    await sql.end();
  }
}

/**
 * Restore the plan catalogue to its seeded version-1 state, as the owner.
 *
 * The catalogue is deliberately NOT in `truncateAll`: it is reference data
 * migration 0105 seeds once, like the entitlements catalogue. A test that
 * publishes a successor version or repricess therefore puts the catalogue
 * back with this - successor versions go, appended price rows go, every
 * seed row reopens - so the next test file starts from version 1 exactly
 * as a fresh database would.
 */
export async function resetPlanCatalogue(urls: Urls): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      UPDATE businesses SET plan_version_id = NULL
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_version_entitlements
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM allowance_versions
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_prices
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_versions WHERE version > 1;
      DELETE FROM plan_prices p USING plan_versions v
        WHERE v.id = p.plan_version_id AND p.effective_from <> v.effective_from;
      UPDATE plan_prices SET effective_to = NULL WHERE effective_to IS NOT NULL;
      UPDATE plan_versions SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM usage_packs WHERE version > 1;
      UPDATE usage_packs SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM add_ons WHERE version > 1;
      UPDATE add_ons SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM add_on_grants WHERE add_on_id LIKE 'test_%';
      DELETE FROM add_ons WHERE add_on_id LIKE 'test_%';
    `);
  } finally {
    await sql.end();
  }
}

/**
 * Give a business standing capacity of a unit, the way production does
 * (PR-116).
 *
 * A CAPACITY unit is HELD, never spent, so there is no counter to credit:
 * the ceiling comes from an add-on the business holds. Suites that need
 * "this merchant may hold three applications" ask for it here rather than
 * crediting a monthly bonus, which is the exact confusion `check-boundaries`
 * refuses in source and this helper makes unnecessary in tests.
 *
 * The add-on is seeded as owner, because the catalogue is never written by
 * the application, and one add-on per quantity: a business holds a given
 * add-on once, which is what the live-holding index enforces.
 */
export async function grantCapacityAddOn(
  urls: Urls,
  businessId: string,
  unit: string,
  quantity: number,
): Promise<string> {
  const addOnId = `test_capacity_${unit.toLowerCase()}_${quantity}`;
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      INSERT INTO add_ons
        (add_on_id, version, name, billing_interval, price_minor, currency, effective_from)
      VALUES (${addOnId}, 1, ${`${quantity} x ${unit}`}, 'monthly',
              500000, 'NGN', '2026-01-01T00:00:00Z')
      ON CONFLICT (add_on_id, version) DO NOTHING
    `;
    await sql`
      INSERT INTO add_on_grants (add_on_id, version, grant_kind, unit, quantity)
      SELECT ${addOnId}, 1, 'CAPACITY', ${unit}, ${quantity}
      WHERE NOT EXISTS (
        SELECT 1 FROM add_on_grants
         WHERE add_on_id = ${addOnId} AND version = 1 AND unit = ${unit}
      )
    `;
    await sql`
      INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
      VALUES (${businessId}::uuid, ${addOnId}, 1, now())
      ON CONFLICT DO NOTHING
    `;
  } finally {
    await sql.end();
  }
  return addOnId;
}

/**
 * A business ready to remind on every channel (OWN-83): on the Complete plan, with its own email
 * sealed as the billing-email service seals it and marked verified, as an opened confirmation link
 * would. That verified email is the Reply-To of its reminder emails; without it none is sent.
 * Through the application role, under the business's own RLS scope.
 */
export async function readyToRemind(
  db: Db,
  vaultKey: string,
  businessId: string,
  address = 'accounts@adaeze.example.ng',
): Promise<void> {
  await setPlanForTest(db, {
    businessId,
    plan: 'complete',
    expiresAt: null,
    actor: 'operator:test',
  });
  await withBusiness(db, businessId, async (tx) => {
    await setBillingEmailSealed(
      tx,
      businessId,
      encryptFacet(address, vaultKey, `billing-email:${businessId}`),
      new Date(),
    );
    await tx.execute(
      drizzleSql`UPDATE businesses SET billing_email_verified_at = now() WHERE id = ${businessId}::uuid`,
    );
  });
}

/**
 * Make a business hold a REAL catalogue add-on, as the owner.
 *
 * `grantCapacityAddOn` invents an add-on to prove a mechanism; this one
 * sells what the catalogue actually offers, which is what a suite wants
 * when the thing under test is the product rather than the plumbing. The
 * version is whichever is open now, exactly as a purchase would pin it.
 */
export async function holdAddOn(
  urls: Urls,
  businessId: string,
  addOnId: string,
  startedAt: Date = new Date(),
): Promise<number> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    const open = await sql<{ version: number }[]>`
      SELECT version FROM add_ons
       WHERE add_on_id = ${addOnId} AND effective_to IS NULL
       ORDER BY version DESC LIMIT 1
    `;
    const version = open[0]?.version;
    if (version === undefined) throw new Error(`no open version of add-on ${addOnId}`);
    await sql`
      INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
      VALUES (${businessId}::uuid, ${addOnId}, ${version}, ${startedAt.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING
    `;
    return version;
  } finally {
    await sql.end();
  }
}

/**
 * Time-travel for Pay-with-Transfer tests: age every live intent of one
 * business past its expiry, as the owner. The suites cannot reach the tables
 * directly (apps/api deliberately owns no SQL), and "the account lapsed" is
 * a state only the clock normally produces.
 */
export async function lapseTransferIntents(urls: Urls, businessId: string): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE payment_intents
      SET expires_at = now() - interval '1 minute',
          transfer_expires_at = now() - interval '1 minute'
      WHERE business_id = ${businessId}::uuid
        AND status NOT IN ('succeeded', 'failed', 'expired', 'cancelled')
    `;
  } finally {
    await sql.end();
  }
}

/**
 * More time-travel: make a business's intents look untouched for `seconds`,
 * so a verify-throttle window (fix-plan 7, H7b) that gates on `updated_at`
 * can be tested without sleeping through it.
 */
export async function agePaymentIntents(
  urls: Urls,
  businessId: string,
  seconds: number,
): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE payment_intents
      SET updated_at = now() - make_interval(secs => ${seconds})
      WHERE business_id = ${businessId}::uuid
    `;
  } finally {
    await sql.end();
  }
}

/**
 * The id of an event a fixture has just stored.
 *
 * `recordEvent` returns an id only on the branch that stored something: a
 * provider retry conflicts and gets no id back, because no ingress caller
 * reads one. A fixture, though, almost always wants the id, and a duplicate
 * where it expected a fresh row is a bug in the test rather than a case to
 * handle. This narrows the union and says so.
 */
export function storedEventId(recorded: { isNew: true; id: string } | { isNew: false }): string {
  if (!recorded.isNew) throw new Error('fixture recorded a duplicate event');
  return recorded.id;
}

/**
 * OD-37 (migration 0196): put a business on a plan and/or a paid-to date directly, AS THE OWNER.
 *
 * The plan fields change only through the subscription writers; the table owner is the one
 * exemption (migrations and an administrator's repair), and this helper is a test using it. A
 * fixture that needs a business "on Complete" without walking a paid cycle calls this; the
 * application and worker roles cannot do it, and production code never does. A field left out
 * keeps its value.
 */
export async function setPlanAsOwner(
  urls: Urls,
  businessId: string,
  fields: { plan?: string; planExpiresAt?: Date | null },
): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    const expires =
      fields.planExpiresAt === undefined
        ? sql`plan_expires_at`
        : sql`${fields.planExpiresAt ? fields.planExpiresAt.toISOString() : null}::timestamptz`;
    await sql`
      UPDATE businesses
      SET plan = COALESCE(${fields.plan ?? null}::text, plan), plan_expires_at = ${expires},
          updated_at = now()
      WHERE id = ${businessId}::uuid
    `;
  } finally {
    await sql.end();
  }
}
