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
      await tx.execute(
        sql.raw(
          'DROP FUNCTION IF EXISTS public.test_fixture_credit_bonus(uuid, text, text, integer)',
        ),
      );
      await tx.execute(
        sql.raw('DROP FUNCTION IF EXISTS public.test_fixture_start_grace(uuid, timestamptz)'),
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
    // 0215 (OD-51.6): one pricing source, switched only by the owner.
    [
      'the pricing source writable by the application',
      'GRANT UPDATE ON billing_pricing_source TO rekoda_app',
    ],
    [
      'the pricing-source switch runnable by settlement',
      'GRANT USAGE ON SCHEMA rekoda_private TO rekoda_settlement; GRANT EXECUTE ON FUNCTION rekoda_private.set_pricing_source(text,text,text,text) TO rekoda_settlement',
    ],
    [
      'the pricing-source guard disabled',
      'ALTER TABLE subscription_charges DISABLE TRIGGER subscription_charges_pricing_source_guard',
    ],
    ['no pricing source row', 'DELETE FROM billing_pricing_source'],
    // 0216 (OD-51.4): the usage meter is written only through its functions.
    ['the application writing a counter directly', 'GRANT UPDATE ON usage_counters TO rekoda_app'],
    ['the worker writing a counter directly', 'GRANT INSERT ON usage_counters TO rekoda_worker'],
    [
      'one counter column writable by settlement',
      'GRANT UPDATE (bonus) ON usage_counters TO rekoda_settlement',
    ],
    [
      'the reservation ledger writable by the application',
      'GRANT UPDATE ON usage_reservations TO rekoda_app',
    ],
    [
      'the pack-credit function granted to the application',
      'GRANT EXECUTE ON FUNCTION usage_credit_pack(uuid,text,text,text,integer) TO rekoda_app',
    ],
    [
      'the refund function granted to settlement',
      'GRANT EXECUTE ON FUNCTION usage_refund(uuid,uuid,text,integer) TO rekoda_settlement',
    ],
    [
      'a usage function with the wrong owner',
      'ALTER FUNCTION usage_reserve(uuid,text,text,integer,integer,boolean) OWNER TO CURRENT_USER',
    ],
    [
      'an extra function owned by the usage writer',
      "CREATE FUNCTION public.usage_reset(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS ''; ALTER FUNCTION public.usage_reset(uuid) OWNER TO rekoda_usage_writer",
    ],
    ['the application able to become the usage writer', 'GRANT rekoda_usage_writer TO rekoda_app'],
    ['the usage writer able to log in', 'ALTER ROLE rekoda_usage_writer LOGIN'],
    [
      'the test-only pack-credit writer present',
      "CREATE FUNCTION public.test_fixture_credit_bonus(a uuid, b text, c text, d integer) RETURNS void LANGUAGE sql AS ''",
    ],
    // 0221 (OD-51): the operator writes only through its functions.
    [
      'the operator able to write a cycle column directly',
      'GRANT UPDATE (payment_failed_at) ON businesses TO rekoda_billing_operator',
    ],
    [
      'the worker able to requeue a dead settlement job',
      "DROP POLICY worker_leaves_settlement_jobs ON jobs; CREATE POLICY worker_leaves_settlement_jobs ON jobs AS RESTRICTIVE FOR UPDATE TO rekoda_worker USING (kind NOT IN ('billing.process', 'billing.apply_no_charge') OR state = 'dead') WITH CHECK (kind NOT IN ('billing.process', 'billing.apply_no_charge') OR state IN ('dead', 'pending'))",
    ],
    [
      'the 0220 closing trigger, blind outside the session pin, put back',
      "CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$ DECLARE v_event uuid; BEGIN BEGIN v_event := (NEW.payload ->> 'eventId')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END; IF v_event IS NULL THEN RETURN NEW; END IF; UPDATE public.usage_reservations SET closed_at = now() WHERE business_id = NEW.business_id AND event_id = v_event AND closed_at IS NULL; RETURN NEW; END $f$",
    ],
    [
      'a closing trigger that pins the job’s business and never restores the caller’s pin',
      "CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$ DECLARE v_event uuid; BEGIN BEGIN v_event := (NEW.payload ->> 'eventId')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END; IF v_event IS NULL THEN RETURN NEW; END IF; PERFORM set_config('app.business_id', NEW.business_id::text, true); UPDATE public.usage_reservations SET closed_at = now() WHERE business_id = NEW.business_id AND event_id = v_event AND closed_at IS NULL; RETURN NEW; END $f$",
    ],
    [
      'reservations readable by a role across tenants',
      'CREATE POLICY widened ON usage_reservations FOR ALL TO rekoda_usage_writer USING (true)',
    ],
    [
      'the 0218 pattern-matching closing trigger put back',
      "CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$ DECLARE v_event text := NEW.payload ->> 'eventId'; BEGIN IF v_event IS NULL OR v_event !~ '^[0-9a-fA-F-]{36}$' THEN RETURN NEW; END IF; UPDATE public.usage_reservations SET closed_at = now() WHERE business_id = NEW.business_id AND event_id = v_event::uuid AND closed_at IS NULL; RETURN NEW; END $f$",
    ],
    // 0220 (OD-52 and review minors): the job row the closure keys on is the application's to
    // finish, never to rewrite, delete or park; the grace clock starts only after the cycle ended.
    ['the application able to delete a job', 'GRANT DELETE ON jobs TO rekoda_app'],
    ['the application able to rewrite a payload', 'GRANT UPDATE (payload) ON jobs TO rekoda_app'],
    ['the transition guard dropped', 'DROP TRIGGER jobs_application_transition_guard ON jobs'],
    [
      'the transition guard disabled',
      'ALTER TABLE jobs DISABLE TRIGGER jobs_application_transition_guard',
    ],
    [
      'the grace clock startable before the cycle ends',
      "CREATE OR REPLACE FUNCTION public.subscription_start_grace(p_business uuid, p_failed_at timestamptz) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT true'",
    ],
    // 0219 (OD-50): the resolution refuses after a later merchant schedule.
    [
      'the support-review resolution without the later-schedule refusal',
      "CREATE OR REPLACE FUNCTION public.subscription_operator_resolve_review(p_business uuid, p_plan text, p_actor text, p_reason text) RETURNS TABLE (review_id uuid, previous_plan text, expires_at timestamptz, changed boolean) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT NULL::uuid, NULL::text, NULL::timestamptz, false'",
    ],
    // 0218 (OD-51.4): a finished job closes its event's usage reservations.
    ['the closing trigger dropped', 'DROP TRIGGER jobs_close_event_reservations ON jobs'],
    [
      'the closing trigger disabled',
      'ALTER TABLE jobs DISABLE TRIGGER jobs_close_event_reservations',
    ],
    [
      'a refund that ignores a closed reservation',
      "CREATE OR REPLACE FUNCTION public.usage_refund(p_business uuid, p_reservation uuid, p_unit text, p_n integer) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1'",
    ],
    [
      'the bind function granted to settlement',
      'GRANT EXECUTE ON FUNCTION usage_bind_event(uuid,uuid,uuid) TO rekoda_settlement',
    ],
    [
      'the closing function callable by the application',
      'GRANT EXECUTE ON FUNCTION rekoda_private.jobs_close_event_reservations() TO rekoda_app',
    ],
    // 0217 (OD-51.2, OD-51.3): settlement is its own principal with exact grants.
    ['settlement acting as the application again', 'GRANT rekoda_app TO rekoda_settlement'],
    ['settlement opening a charge', 'GRANT INSERT ON subscription_charges TO rekoda_settlement'],
    [
      'settlement writing a column it does not need',
      'GRANT UPDATE (amount_k) ON subscription_charges TO rekoda_settlement',
    ],
    [
      'settlement writing the plan directly',
      'GRANT UPDATE (plan) ON businesses TO rekoda_settlement',
    ],
    ['settlement reading tenant data', 'GRANT SELECT ON invoices TO rekoda_settlement'],
    ['settlement writing the outbox', 'GRANT INSERT ON outbox_events TO rekoda_settlement'],
    ['settlement rewriting a job', 'GRANT UPDATE (payload) ON jobs TO rekoda_settlement'],
    [
      'settlement given the next table by default',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO rekoda_settlement',
    ],
    ['the settlement queue restriction dropped', 'DROP POLICY settlement_only_its_kinds ON jobs'],
    ['the worker free to run settlement jobs', 'DROP POLICY worker_leaves_settlement_jobs ON jobs'],
    [
      'the worker restriction made permissive',
      'DROP POLICY worker_leaves_settlement_jobs ON jobs; CREATE POLICY worker_leaves_settlement_jobs ON jobs FOR UPDATE TO rekoda_worker USING (true)',
    ],
    [
      'the grace-clock function granted to settlement',
      'GRANT EXECUTE ON FUNCTION subscription_start_grace(uuid,timestamptz) TO rekoda_settlement',
    ],
    [
      'the test-only grace-clock writer present',
      "CREATE FUNCTION public.test_fixture_start_grace(a uuid, b timestamptz) RETURNS void LANGUAGE sql AS ''",
    ],
    [
      'the test-only fixture writer present',
      "CREATE FUNCTION public.test_fixture_set_plan(p uuid, q text, r timestamptz) RETURNS void LANGUAGE sql AS ''",
    ],
    // 0222: the database decides the ceiling and the meter row; the guards follow inheritance.
    [
      'a reserve that trusts the caller’s allowance again',
      "CREATE OR REPLACE FUNCTION public.usage_reserve(p_business uuid, p_period text, p_unit text, p_allowance integer, p_n integer, p_refundable boolean) RETURNS TABLE (granted boolean, reservation uuid) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS 'SELECT true, NULL::uuid'",
    ],
    [
      'a refund with no window for an unbound reservation',
      'CREATE OR REPLACE FUNCTION public.usage_refund(p_business uuid, p_reservation uuid, p_unit text, p_n integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $f$ BEGIN IF false AND closed_at IS NOT NULL THEN RETURN 0; END IF; RETURN 1; END $f$',
    ],
    [
      'the entitlement readable by settlement',
      'GRANT EXECUTE ON FUNCTION usage_entitlement(uuid,text) TO rekoda_settlement',
    ],
    [
      'the job guard matching the role name again',
      "CREATE OR REPLACE FUNCTION rekoda_private.jobs_application_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$ BEGIN IF current_user <> 'rekoda_app' THEN RETURN NEW; END IF; IF NEW.locked_by IS DISTINCT FROM OLD.locked_by THEN RAISE EXCEPTION 'x'; END IF; IF OLD.state = 'dead' AND NEW.state = 'pending' THEN RETURN NEW; END IF; RETURN NEW; END $f$",
    ],
    [
      'the job guard blind to the application’s inserts',
      'DROP TRIGGER jobs_application_transition_guard ON jobs; CREATE TRIGGER jobs_application_transition_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_application_transition_guard()',
    ],
    [
      'the application free to rewrite a charge’s provider reference',
      'CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$ BEGIN RETURN NEW; END $f$',
    ],
    [
      'the event guard matching the role name again',
      "CREATE OR REPLACE FUNCTION rekoda_private.external_events_worker_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$ BEGIN IF current_user <> 'rekoda_worker' THEN RETURN NEW; END IF; RETURN NEW; END $f$",
    ],
  ])('prints f for %s', async (_label, tamper) => {
    expect(await smokeAfter(tamper)).toBe('f');
  });
});
