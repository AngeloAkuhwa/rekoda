-- OD-37 (owner review of PR #432, 11 Nov 2026): settlement and operator plan changes run under
-- their OWN database principals, so the general application and worker credentials can no longer
-- forge a paid charge or make an operator plan change.
--
-- Before this migration (0200, STATED LIMIT): `rekoda_app` and `rekoda_worker` could INSERT and
-- UPDATE `subscription_charges` (0020), so a holder of either credential could write a `paid`
-- charge and apply it with `subscription_apply_paid_charge` (EXECUTE to both), credit pack units
-- straight into `usage_counters.bonus`, insert an add-on holding, and `rekoda_app` could call the
-- operator writer `subscription_operator_set_plan` for any business it pinned. (`app.business_id`
-- is an ordinary setting every session may set, so the tenant pin was never an authority.)
--
-- Two new LOGIN roles, each with no password in this file (`packages/db/src/provision.ts` sets it
-- from the deployment's `.env`, as for `rekoda_app` and `rekoda_worker`):
--
--   rekoda_settlement        SETTLEMENT_DATABASE_URL. The ONLY non-owner role that may move a
--                            charge to `paid`, write its payment evidence (paid_at, paid_amount_k,
--                            provider_paid_at, provider_settled_at, units_credited_at), raise `usage_counters.bonus`,
--                            write an add-on holding, or EXECUTE `subscription_apply_paid_charge`.
--                            Used by the `billing.process` job (the Paystack-verified settlement,
--                            including operator dead-job recovery, which reruns that job) and by
--                            the owner's plan change (`POST /v1/billing/plan`), which settles a
--                            zero-priced upgrade in the same transaction.
--   rekoda_billing_operator  OPERATOR_DATABASE_URL. The ONLY role that may EXECUTE
--                            `subscription_operator_set_plan`. Used by `POST /v1/businesses/plan`
--                            (operator plane, `ops:billing`) and nothing else.
--
-- Both inherit `rekoda_app` (INHERIT TRUE, SET FALSE): the settlement and operator transactions
-- also write the ordinary tenant rows the application writes (the business's cycle columns, job
-- completion, attempts, events, audit), under the same RLS. What they hold BEYOND `rekoda_app` is
-- exactly the grants below. Neither is a member of `rekoda_worker`, `rekoda_plan_writer` or the
-- other; neither can bypass RLS. Membership in the other direction (the application or worker
-- credential able to become either) is refused here and at every boot.
--
-- Authority is the ROLE (`current_user`), never a setting, exactly as in 0196.
--
-- What stays possible for a holder of a stolen general credential, and is recorded in
-- docs/REKODA_LAUNCH_READINESS.md (OD-37): ordinary application writes inside a business it pins
-- (the application credential writes tenant data by design), including its own usage counters'
-- `used`; refunding (paid -> refunded only removes entitlement); and a process that holds every
-- secret holds the new credentials too.
--
-- Rollback: none. Like 0196 and 0200 this is a deliberate compatibility break (the previous release
-- settles on `rekoda_app`, which loses the right): applied with the api and worker stopped, after
-- the two new credentials are in `.env` (docs/runbooks/deploy.md). Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The roles.
-- ---------------------------------------------------------------------------------------------
DO $$ BEGIN
  CREATE ROLE rekoda_settlement LOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE rekoda_billing_operator LOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A role that already existed (made by hand) is held to the same shape.
ALTER ROLE rekoda_settlement LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE rekoda_billing_operator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT rekoda_app TO rekoda_settlement WITH INHERIT TRUE, SET FALSE;
GRANT rekoda_app TO rekoda_billing_operator WITH INHERIT TRUE, SET FALSE;

-- Nothing that connects for another purpose may be able to become either role, and neither may
-- become the other, the worker or the plan writer. Refuse to migrate rather than keep such a
-- membership.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT format('%s is a member of %s', m.member, m.target) INTO offender
  FROM (VALUES
          ('rekoda_app', 'rekoda_settlement'), ('rekoda_worker', 'rekoda_settlement'),
          ('rekoda_app', 'rekoda_billing_operator'), ('rekoda_worker', 'rekoda_billing_operator'),
          ('rekoda_settlement', 'rekoda_billing_operator'),
          ('rekoda_billing_operator', 'rekoda_settlement'),
          ('rekoda_settlement', 'rekoda_worker'), ('rekoda_billing_operator', 'rekoda_worker'),
          ('rekoda_settlement', 'rekoda_plan_writer'),
          ('rekoda_billing_operator', 'rekoda_plan_writer')) AS m(member, target)
  WHERE pg_has_role(m.member, m.target, 'MEMBER')
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0202: % ; revoke the membership first', offender
      USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The provider writer belongs to settlement; the operator writer to the billing operator.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.subscription_apply_paid_charge(uuid, text, timestamptz)
  FROM PUBLIC, rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.subscription_apply_paid_charge(uuid, text, timestamptz)
  TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- 3. Only settlement makes a charge paid, or writes its payment evidence.
-- ---------------------------------------------------------------------------------------------
-- `rekoda_app` keeps INSERT and UPDATE on the table: it opens pending charges and records the
-- lifecycle around them (supersession, checkout links, blocks, refunds, unapplied review). The
-- trigger refuses, for any role but `rekoda_settlement` and the table owner:
--   * a charge INSERTED in any state but `pending`, or carrying payment evidence;
--   * a move INTO `paid` (from pending, failed or refunded);
--   * any change to the payment evidence (paid_at, paid_amount_k, provider_paid_at,
--     provider_settled_at, units_credited_at);
--   * any change to what a paid or refunded charge bought (business, kind, plan, amount, interval,
--     pack, quantity, period), so a paid pack cannot be relabelled as a plan, nor a paid charge
--     moved to another business.
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.paid_at IS NOT NULL OR NEW.paid_amount_k IS NOT NULL
       OR NEW.provider_paid_at IS NOT NULL OR NEW.provider_settled_at IS NOT NULL
       OR NEW.units_credited_at IS NOT NULL THEN
      RAISE EXCEPTION
        'a charge is opened pending; only settlement records a payment (OD-37)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
     OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.paid_amount_k IS DISTINCT FROM OLD.paid_amount_k
     OR NEW.provider_paid_at IS DISTINCT FROM OLD.provider_paid_at
     OR NEW.provider_settled_at IS DISTINCT FROM OLD.provider_settled_at
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND (NEW.business_id IS DISTINCT FROM OLD.business_id
          OR NEW.reference IS DISTINCT FROM OLD.reference
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.plan IS DISTINCT FROM OLD.plan
          OR NEW.amount_k IS DISTINCT FROM OLD.amount_k
          OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
          OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
          OR NEW.quantity IS DISTINCT FROM OLD.quantity
          OR NEW.period_start IS DISTINCT FROM OLD.period_start
          OR NEW.period_end IS DISTINCT FROM OLD.period_end) THEN
    RAISE EXCEPTION 'what a paid charge bought cannot be changed (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS subscription_charges_settlement_guard ON subscription_charges;
CREATE TRIGGER subscription_charges_settlement_guard
  BEFORE INSERT OR UPDATE ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_settlement_guard();

-- ---------------------------------------------------------------------------------------------
-- 4. Pack units are credited only by settlement.
-- ---------------------------------------------------------------------------------------------
-- `usage_counters.bonus` raises a meter's ceiling and is written by exactly one function
-- (`creditBonus`), inside the settlement of a paid pack. Consumption (`used`) stays the
-- application's: it is what every metered action writes.
CREATE OR REPLACE FUNCTION rekoda_private.usage_counters_bonus_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.bonus > 0)
     OR (TG_OP = 'UPDATE' AND NEW.bonus > OLD.bonus) THEN
    RAISE EXCEPTION 'pack units are credited only by settlement (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS usage_counters_bonus_guard ON usage_counters;
CREATE TRIGGER usage_counters_bonus_guard
  BEFORE INSERT OR UPDATE ON usage_counters
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.usage_counters_bonus_guard();

-- ---------------------------------------------------------------------------------------------
-- 5. Add-on holdings: what a business was sold. No production path sells one yet; the right to
--    record one moves from the application to settlement.
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON business_add_ons FROM rekoda_app;
GRANT INSERT, UPDATE ON business_add_ons TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- 6. The schema the guards live in: the trigger functions run as the caller, who needs USAGE to
--    resolve them; nothing in rekoda_private is executable by a caller beyond what it already was.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.usage_counters_bonus_guard() FROM PUBLIC;
