-- OD-37 (PR B item 5): a business's plan and paid-to date change only through the subscription
-- writers, enforced by the database.
--
-- The G-62 static guard (packages/db/src/billing/plan-expiry-files.test.ts) pins which files may
-- write `businesses.plan` and `businesses.plan_expires_at`. This adds the database half: a BEFORE
-- UPDATE trigger refuses any change to either column unless it is made inside one of two SECURITY
-- DEFINER functions owned by a dedicated NOLOGIN role:
--
--   subscription_write_plan(business, plan, expires)            subscriptionsRepo.writeSubscriptionState
--   subscription_expire_plan(business, previous, reason) -> bool subscriptionsRepo.expireSubscription
--
-- The authority is the ROLE, never a setting: inside the function `current_user` is
-- `rekoda_plan_writer`, which nothing can log in as and no application role is a member of. No
-- session or transaction setting, GUC or flag reaches the exemption. The trigger function itself is
-- NOT security definer, so it sees the caller's identity. The only other exemption is the table's
-- owner (and a superuser), which is how migrations and an administrator's audited repair work.
--
-- The trial is an INSERT (identity.createBusinessWithOwner), which a BEFORE UPDATE trigger never
-- sees. Both functions refuse a business other than the pinned tenant, and RLS still applies to the
-- definer role (it does not bypass RLS). Audit events (`plan_changed`, `subscription_expired`) stay
-- where they were, in the repository.
--
-- Rollback (owner ruling OD-48): none. This migration is a deliberate compatibility break: the
-- previous release writes the two columns directly and the trigger refuses it, so the previous
-- release must not be restarted against a database that holds 0196, and the guard is not removed as
-- a rollback shortcut. Deploy it with the api and worker stopped, and fix forward (see
-- docs/runbooks/deploy.md, "Deploy a release carrying 0196").

DO $$ BEGIN
  CREATE ROLE rekoda_plan_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A role that already existed (made by hand) is held to the same shape: no login, no RLS bypass.
ALTER ROLE rekoda_plan_writer NOLOGIN NOBYPASSRLS;

-- The authority is the role, so nothing that connects may be able to become it. A membership of
-- the writer role held (directly or through another role) by the application or worker credential
-- would let a connection `SET ROLE rekoda_plan_writer` and update a pinned business's plan fields
-- outside the two functions. Refuse to migrate rather than preserve such a membership.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT r.rolname INTO offender
  FROM pg_roles r
  WHERE r.rolname IN ('rekoda_app', 'rekoda_worker')
    AND pg_has_role(r.rolname, 'rekoda_plan_writer', 'MEMBER')
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0196: % is a member of rekoda_plan_writer; revoke it first '
      '(REVOKE rekoda_plan_writer FROM %)', offender, offender
      USING ERRCODE = '42501';
  END IF;
END $$;

-- What the writer role touches: the two guarded columns and the bookkeeping that moves with an
-- expiry. It reads the row to check the expiry condition. Nothing else.
GRANT SELECT ON businesses TO rekoda_plan_writer;
GRANT UPDATE (plan, plan_expires_at, pending_plan, plan_decided_at, updated_at)
  ON businesses TO rekoda_plan_writer;
-- A business leaving its trial fires `release_trial_month_rows` (0176/0178) AFTER the plan UPDATE,
-- and a trigger runs as the current user: inside the writer that is this role. It needs exactly what
-- that trigger does, still under RLS and the tenant pin: name the trial meter on reserved events,
-- and drop the trial's calendar-month counters.
GRANT SELECT, UPDATE (reserved_meters) ON external_events TO rekoda_plan_writer;
GRANT SELECT, DELETE ON usage_counters TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.subscription_write_plan(
  p_business uuid,
  p_plan text,
  p_expires timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- `public` stays on the path (after pg_catalog, before nothing writable by others): a trigger fired
-- by the writer's UPDATE (release_trial_month_rows, 0176) names its tables unqualified and runs with
-- this path. Every table this function names is schema-qualified; PUBLIC holds no CREATE on public.
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_write_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.businesses SET plan = p_plan, plan_expires_at = p_expires
  WHERE id = p_business;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_expire_plan(
  p_business uuid,
  p_previous text,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
-- `public` stays on the path (after pg_catalog, before nothing writable by others): a trigger fired
-- by the writer's UPDATE (release_trial_month_rows, 0176) names its tables unqualified and runs with
-- this path. Every table this function names is schema-qualified; PUBLIC holds no CREATE on public.
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_expire_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('grace', 'cancelled') OR p_previous IN ('trial', 'expired') THEN
    RETURN false;
  END IF;
  -- The same race-safe condition as before: somebody who paid, or undid the cancel, between the
  -- caller's read and this write keeps their plan.
  UPDATE public.businesses
  SET plan = 'expired', pending_plan = NULL, plan_decided_at = clock_timestamp(), updated_at = now()
  WHERE id = p_business AND plan = p_previous
    AND CASE WHEN p_reason = 'grace' THEN payment_failed_at IS NOT NULL
             ELSE pending_plan = 'expired' END;
  RETURN FOUND;
END $$;

ALTER FUNCTION public.subscription_write_plan(uuid, text, timestamptz) OWNER TO rekoda_plan_writer;
ALTER FUNCTION public.subscription_expire_plan(uuid, text, text) OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_write_plan(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_expire_plan(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscription_write_plan(uuid, text, timestamptz)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.subscription_expire_plan(uuid, text, text)
  TO rekoda_app, rekoda_worker;

CREATE SCHEMA IF NOT EXISTS rekoda_private;

CREATE OR REPLACE FUNCTION rekoda_private.businesses_plan_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_plan_writer' THEN
    RETURN NEW;
  END IF;
  -- The table's owner (and a superuser): migrations and an administrator's repair.
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'businesses.plan and businesses.plan_expires_at change only through the subscription writers (OD-37)'
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS businesses_plan_fields_guard ON businesses;
CREATE TRIGGER businesses_plan_fields_guard
  BEFORE UPDATE OF plan, plan_expires_at ON businesses
  FOR EACH ROW
  WHEN (OLD.plan IS DISTINCT FROM NEW.plan
        OR OLD.plan_expires_at IS DISTINCT FROM NEW.plan_expires_at)
  EXECUTE FUNCTION rekoda_private.businesses_plan_fields_guard();
