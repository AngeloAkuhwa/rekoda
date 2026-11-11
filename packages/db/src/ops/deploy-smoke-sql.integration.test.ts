/**
 * The staging pre-start database smoke (scripts/deploy-staging.sh, SMOKE_0196_SQL; OWN-86, OD-37),
 * RUN against a real migrated database rather than matched as text: it prints `t` for the boundary
 * this release migrates to, and `f` for each way that boundary can be wrong (owner review of #432,
 * item 4.3, and the independent review's request to execute it).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { createDb, type Db } from '../client.js';
import { migrate, requireUrls } from '../testing.js';

const script = readFileSync(
  new URL('../../../../scripts/deploy-staging.sh', import.meta.url),
  'utf8',
);
const SMOKE = /^SMOKE_0196_SQL="([\s\S]*?)"$/m.exec(script)?.[1];

let ownerDb: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  const urls = requireUrls();
  await migrate(urls);
  ({ db: ownerDb, close } = createDb(urls.owner, { max: 1 }));
});
afterAll(async () => {
  await close?.();
});

/** The smoke's answer after `tamper`, inside a transaction that is always rolled back. The
 * harness-only fixture writer (never in a deployed database) is dropped first, as on staging. */
async function smokeAfter(tamper: string): Promise<string> {
  let answer = '';
  await ownerDb
    .transaction(async (tx) => {
      await tx.execute(
        sql.raw('DROP FUNCTION IF EXISTS public.test_fixture_set_plan(uuid, text, timestamptz)'),
      );
      if (tamper) await tx.execute(sql.raw(tamper));
      const [row] = await tx.execute<{ ok: boolean }>(
        sql.raw(`SELECT (${SMOKE!.replace(/^SELECT/, '')}) AS ok`),
      );
      answer = row?.ok ? 't' : 'f';
      tx.rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  return answer;
}

describe('the pre-start database smoke, executed', () => {
  it('is found in the script', () => {
    expect(SMOKE).toBeTruthy();
    expect(SMOKE).toMatch(/^SELECT/);
  });

  it('prints t for the migrated boundary', async () => {
    expect(await smokeAfter('')).toBe('t');
  });

  it.each([
    [
      'a widened provider-writer grant',
      'GRANT EXECUTE ON FUNCTION subscription_apply_paid_charge(uuid,text,timestamptz) TO rekoda_app',
    ],
    [
      'PUBLIC on the operator writer',
      'GRANT EXECUTE ON FUNCTION subscription_operator_set_plan(uuid,text,timestamptz,text,text) TO PUBLIC',
    ],
    [
      'a writer with the wrong owner',
      'ALTER FUNCTION subscription_expire_plan(uuid,text,text) OWNER TO CURRENT_USER',
    ],
    [
      'an unexpected function owned by the writer role',
      "CREATE FUNCTION public.extra_writer() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'select 1'; ALTER FUNCTION public.extra_writer() OWNER TO rekoda_plan_writer",
    ],
    [
      'a missing writer',
      'DROP FUNCTION subscription_operator_set_plan(uuid,text,timestamptz,text,text)',
    ],
    [
      'a writer without its pinned search_path',
      'ALTER FUNCTION subscription_apply_paid_charge(uuid,text,timestamptz) RESET search_path',
    ],
    [
      'a disabled settlement guard',
      'ALTER TABLE subscription_charges DISABLE TRIGGER subscription_charges_settlement_guard',
    ],
    ['a runtime role able to create in public', 'GRANT CREATE ON SCHEMA public TO rekoda_app'],
    [
      'a disabled cycle-input guard',
      'ALTER TABLE businesses DISABLE TRIGGER businesses_cycle_fields_guard',
    ],
    [
      'a provider writer that no longer binds a charge to its cycle',
      "CREATE OR REPLACE FUNCTION public.subscription_apply_paid_charge(p_business uuid, p_reference text, p_expires timestamptz) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 'chat'; END $$",
    ],
    [
      'a disabled pack-credit guard',
      'ALTER TABLE usage_counters DISABLE TRIGGER usage_counters_bonus_guard',
    ],
    ['the worker able to become settlement', 'GRANT rekoda_settlement TO rekoda_worker'],
    ['the worker writing events again', 'GRANT UPDATE ON external_events TO rekoda_worker'],
    // 0209: the application may open a pending charge, but only through the guard that keeps it
    // pristine; a guard replaced by a permissive one is caught.
    [
      'the charge guard replaced so the application could open a paid charge',
      "CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
    ],
    ['the worker able to open charges', 'GRANT INSERT ON subscription_charges TO rekoda_worker'],
    // 0210: the worker's writes, the ledger, the grants and the retention policy.
    ['the worker writing sessions again', 'GRANT INSERT ON sessions TO rekoda_worker'],
    ['the worker writing the books again', 'GRANT INSERT ON ledger_entries TO rekoda_worker'],
    [
      'the application writing the migration ledger',
      'GRANT INSERT ON rekoda_migrations TO rekoda_app',
    ],
    [
      'the application writing entitlement grants',
      'GRANT INSERT ON business_entitlements TO rekoda_app',
    ],
    [
      'the unchecked retention deletion open to the worker',
      'GRANT EXECUTE ON FUNCTION retention_delete_business_unchecked(uuid, timestamptz) TO rekoda_worker',
    ],
    [
      'the trial-start guard disabled',
      'ALTER TABLE businesses DISABLE TRIGGER businesses_trial_start_guard',
    ],
    [
      "the worker's event guard disabled",
      'ALTER TABLE external_events DISABLE TRIGGER external_events_worker_guard',
    ],
    // 0212: the worker coordinates the queue but cannot rewrite what a job runs or forge a webhook.
    ['the worker able to rewrite a job kind', 'GRANT UPDATE (kind) ON jobs TO rekoda_worker'],
    [
      'the worker writing webhook deliveries directly',
      'GRANT INSERT ON webhook_deliveries TO rekoda_worker',
    ],
    [
      'a column-level write on sessions for the worker',
      'GRANT UPDATE (token_hash) ON sessions TO rekoda_worker',
    ],
    [
      'a default privilege handing the worker the next table',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO rekoda_worker',
    ],
    // 0211: the operator holds only what a plan change needs.
    ['the operator acting as the application again', 'GRANT rekoda_app TO rekoda_billing_operator'],
    // 0213 (OD-50): the support-review resolution is the billing operator's alone.
    [
      'the support-review resolution granted to the application',
      'GRANT EXECUTE ON FUNCTION subscription_operator_resolve_review(uuid,text,text,text) TO rekoda_app',
    ],
    [
      'the support-review request granted to the operator',
      'GRANT EXECUTE ON FUNCTION subscription_request_plan_review(uuid,text) TO rekoda_billing_operator',
    ],
    [
      'a runtime role writing reviews directly',
      'GRANT INSERT ON plan_change_reviews TO rekoda_app',
    ],
    [
      'a review column writable by the operator',
      'GRANT UPDATE (paid_through) ON plan_change_reviews TO rekoda_billing_operator',
    ],
    // 0214 (OD-51.7): one credit per pack purchase.
    [
      'the purchase guard disabled',
      'ALTER TABLE subscription_charges DISABLE TRIGGER subscription_charges_purchase_guard',
    ],
    [
      'the one-credit-per-purchase index dropped',
      'DROP INDEX subscription_charges_one_credit_per_purchase_ux',
    ],
    [
      'the test-only fixture writer present',
      "CREATE FUNCTION public.test_fixture_set_plan(p uuid, q text, r timestamptz) RETURNS void LANGUAGE sql AS ''",
    ],
  ])('prints f for %s', async (_label, tamper) => {
    expect(await smokeAfter(tamper)).toBe('f');
  });
});
