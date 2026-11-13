-- MVP readiness review of PR #432 (13 Nov 2026): the database decides how much a business may
-- spend, and on which meter row; the caller can only ask for less.
--
-- 0216 moved every write of `usage_counters` behind `usage_reserve`, but the ceiling that function
-- enforced was still an ARGUMENT: `WHERE c.used + p_n <= p_allowance + c.bonus`. The application
-- resolves the allowance honestly (`meterAllowance` in apps/api/src/billing/plan-terms.ts), yet the
-- function is executable by `rekoda_app` and `rekoda_worker`, so a holder of either credential could
-- call it directly with any allowance (reproduced as `rekoda_app`: 5,000 AI actions granted on a
-- trial that sells 50), and with any period label (a month that has never been used, such as
-- `2099-12`, is a fresh counter row with a full allowance).
--
-- After this migration:
--
--   1. `usage_entitlement(business, unit)` computes the ceiling from state no runtime role can write:
--      the business's plan and trial expiry (guarded since 0196 and 0207: the application cannot
--      change `plan` or `plan_expires_at`), the plan catalogue's allowance for the version the
--      business is pinned to (or the version in force, exactly as `planCatalogueRepo.soldAllowanceFor`
--      resolves it), and the units its active add-on holdings grant every month (written only by
--      settlement). A trial past its expiry reads `expired`, which sells nothing. Voice is counted in
--      seconds (`UNIT_SCALE`, ADR 0028). Capacity units are not metered and get zero.
--   2. `usage_reserve` spends against `least(p_allowance, usage_entitlement(...)) + bonus`. The
--      argument is kept for compatibility and can only LOWER the ceiling (an honest caller's stricter
--      view still holds); it can never raise it.
--   3. The meter row is the database's choice. A trial's base-plan units are spent on the one trial
--      row (`TRIAL00`) and nowhere else; a paid business's units, and a standalone holding's units,
--      on a calendar month in Africa/Lagos. The caller's month is honoured when it is the current
--      month, or the month before during the first seven days of a month (a message that arrived on
--      the 31st and is processed, retried or recovered after midnight is metered on the month it
--      arrived in, which is what the inbound handlers ask for). Any other label is metered on the
--      current month. The repository mirrors the rule for the handle it returns (`meterOn` in
--      packages/db/src/repos/usage.ts); the handle's row is a label only, since a refund returns
--      the reservation to the row the database recorded on it.
--   4. A reservation that is not bound to an event's job (0218) is held only by the request that
--      made it: every honest refund of one happens within seconds (a failed send, a refused order,
--      a failed document). It is refundable for fifteen minutes and no longer. A reservation bound to
--      a job keeps the 0218 rule (refundable until the job is done) and the 45-day bound.
--
-- The review's three MINOR findings on `ece0e14` are closed here as well:
--
--   5. (residual 11) The job and event guards recognised the restricted role by NAME
--      (`current_user = 'rekoda_app'`, `current_user <> 'rekoda_worker'`), so a login role that only
--      inherits `rekoda_app` or `rekoda_worker` would skip them. They now apply to any role that holds
--      that role's privileges and is not the table owner.
--   6. (residual 10) The application's dead->pending move must clear the lease, which the only honest
--      caller (`deadJobs.startRecovery`) already does.
--   9. (found by the same review) Settlement's jobs: the application may enqueue one only as pending
--      work due now, for the Paystack event or charge its singleton key names (which must exist for
--      that business), and may requeue a dead one for an operator's recovery, but may no longer mark a
--      running one done, reschedule it, or enqueue one already finished. Settlement completes its
--      own jobs on its own credential.
--   8. (found by the same review) `rekoda_app` holds column UPDATE on `subscription_charges` for the
--      lifecycle columns it works (checkout, supersession, refunds), and the settlement guard's
--      general-role branch did not list `provider_reference`, so the application could rewrite the
--      Paystack transaction id recorded on a paid charge (a `no_charge:` prefix shows the merchant
--      a paid charge as free). The guard now refuses it; settlement still records it.
--   7. (residual 9) Replacing the job guard here gives every database the reviewed definition,
--      whatever draft of 0220 it applied; the pre-start smoke now checks the text of each guard
--      clause it relies on rather than only that the trigger exists.
--
-- What this does NOT claim (recorded in docs/REKODA_LAUNCH_READINESS.md, OD-51):
--   * The tenant pin (`app.business_id`) is a session setting any role may set. RLS stops a code
--     defect from reading another tenant; it does not stop a holder of the application credential,
--     which serves every tenant by design, from acting for any of them. What changes here is that it
--     can no longer give ANY tenant more than that tenant's plan sells.
--   * The application still decides whether an action is metered at all; a compromised application
--     can serve an action without calling `usage_reserve`, or refund an unbound reservation within
--     fifteen minutes. Neither raises a ceiling or touches another business's plan.
--
-- Compatibility: `usage_reserve` keeps its signature and result; the previous release keeps working,
-- metered by the stricter ceiling. The trigger functions are replaced in place. Re-running 0216 or
-- 0218 by hand afterwards puts their older `usage_reserve` / `usage_refund` back, so either must be
-- followed by this file again (the migration runner applies each file once, in order). Rollback: none past 0196 (OWN-86). Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 0. What the usage writer reads to decide the ceiling. Read-only, and every tenant table among
--    them is under RLS with the caller's pin.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON businesses, plan_versions, allowance_versions, business_add_ons, add_on_grants
  TO rekoda_usage_writer;

-- ---------------------------------------------------------------------------------------------
-- 1. The ceiling, from the database's own record of what the business was sold.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_entitlement(
  p_business uuid,
  p_unit text
) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  v_plan text;
  v_sold integer;
  v_granted integer;
  v_scale integer;
BEGIN
  IF p_business IS NULL OR p_unit IS NULL THEN
    RAISE EXCEPTION 'usage_entitlement: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_entitlement: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  -- Capacity units are held, not spent (UNIT_KIND in @rekoda/core): never through the meter.
  IF p_unit IN ('PAYMENT_CONNECTIONS', 'FINANCIAL_ACCOUNT_CONNECTIONS', 'ACCOUNTANT_USERS',
                'API_APPLICATIONS') THEN
    RETURN 0;
  END IF;
  SELECT plan, plan_expires_at, plan_version_id INTO b
  FROM public.businesses WHERE id = p_business;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  -- `usageRepo.planFor`: only a trial expires by its date; a lapsed paid plan is stored `expired`.
  v_plan := CASE WHEN b.plan = 'trial' AND b.plan_expires_at IS NOT NULL
                      AND b.plan_expires_at <= now() THEN 'expired'
                 ELSE b.plan END;
  -- `planCatalogueRepo.soldAllowanceFor`: the pinned version when it is a version of this plan,
  -- otherwise the version in force now. No version, or no row for the unit, sells nothing.
  SELECT av.allowance INTO v_sold
  FROM public.allowance_versions av
  WHERE av.unit = p_unit
    AND av.plan_version_id = COALESCE(
      (SELECT pv.id FROM public.plan_versions pv
        WHERE pv.id = b.plan_version_id AND pv.plan_id = v_plan),
      (SELECT pv.id FROM public.plan_versions pv
        WHERE pv.plan_id = v_plan AND pv.effective_from <= now()
          AND (pv.effective_to IS NULL OR pv.effective_to > now())
        ORDER BY pv.version DESC LIMIT 1));
  -- `addOnsRepo.grantedUnits(..., 'MONTHLY_UNITS', ...)`: what a held add-on grants every month.
  SELECT coalesce(sum(g.quantity), 0)::integer INTO v_granted
  FROM public.business_add_ons h
  JOIN public.add_on_grants g ON g.add_on_id = h.add_on_id AND g.version = h.version
  WHERE h.business_id = p_business
    AND h.started_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now())
    AND g.grant_kind = 'MONTHLY_UNITS' AND g.unit = p_unit;
  -- `UNIT_SCALE`: voice is sold in minutes and counted in seconds (ADR 0028).
  v_scale := CASE WHEN p_unit = 'VOICE_MINUTES' THEN 60 ELSE 1 END;
  RETURN (coalesce(v_sold, 0) + v_granted) * v_scale;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The meter row, chosen by the database.
-- ---------------------------------------------------------------------------------------------
-- The rule, at an explicit instant (so it can be tested on any day of the month).
CREATE OR REPLACE FUNCTION rekoda_private.usage_meter_row_at(
  p_business uuid,
  p_period text,
  p_unit text,
  p_at timestamptz
) RETURNS char(7)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_plan text;
  v_lagos timestamp := p_at AT TIME ZONE 'Africa/Lagos';
  v_month text := to_char(p_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM');
  v_previous text := to_char((date_trunc('month', p_at AT TIME ZONE 'Africa/Lagos')
                              - interval '1 month'), 'YYYY-MM');
BEGIN
  SELECT plan INTO v_plan FROM public.businesses WHERE id = p_business;
  -- `meterOn` in packages/db/src/repos/usage.ts: a trial meters its base-plan units on one row;
  -- the units a standalone holding sells follow the calendar month whatever the plan.
  IF (v_plan IS NULL OR v_plan = 'trial')
     AND p_unit NOT IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES') THEN
    RETURN 'TRIAL00';
  END IF;
  IF p_period = v_month THEN
    RETURN v_month;
  END IF;
  -- Last month, in the first seven days of this one, and only on a row that month already
  -- opened: a late message is metered where its month's budget is, but no new row (a fresh
  -- allowance, for a business that was on the trial or lapsed last month) can be opened there.
  IF p_period = v_previous AND extract(day FROM v_lagos) <= 7
     AND EXISTS (SELECT 1 FROM public.usage_counters c
                 WHERE c.business_id = p_business AND c.period = v_previous AND c.unit = p_unit) THEN
    RETURN v_previous;
  END IF;
  RETURN v_month;
END $$;

CREATE OR REPLACE FUNCTION rekoda_private.usage_meter_row(
  p_business uuid,
  p_period text,
  p_unit text
) RETURNS char(7)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT rekoda_private.usage_meter_row_at(p_business, p_period, p_unit, now()) $$;
REVOKE ALL ON FUNCTION rekoda_private.usage_meter_row_at(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.usage_meter_row(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rekoda_private.usage_meter_row(uuid, text, text) TO rekoda_usage_writer;

-- ---------------------------------------------------------------------------------------------
-- 3. Spend: against the database's ceiling, on the database's row.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_reserve(
  p_business uuid,
  p_period text,
  p_unit text,
  p_allowance integer,
  p_n integer,
  p_refundable boolean
) RETURNS TABLE (granted boolean, reservation uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_used integer;
  v_id uuid;
  v_row char(7);
  v_ceiling integer;
BEGIN
  IF p_business IS NULL OR p_unit IS NULL OR p_refundable IS NULL
     OR p_period IS NULL OR p_period !~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'
     OR p_allowance IS NULL OR p_allowance < 0 OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_reserve: invalid input' USING ERRCODE = '22023';
  END IF;
  -- The vocabulary (spec 4.2, `usage_counters_unit_check`): a name outside it is an error, as the
  -- CHECK made it before the ceiling was computed here, never a quiet "exhausted".
  IF p_unit <> ALL (ARRAY['AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENT_GENERATION',
        'DOCUMENTS_UNDERSTOOD', 'SERVICE_MESSAGE', 'UTILITY_TEMPLATE', 'AUTH_TEMPLATE',
        'AUTH_INTL_TEMPLATE', 'MARKETING_TEMPLATE', 'CATALOGUE_ORDERS', 'PAYMENT_CONNECTIONS',
        'FINANCIAL_ACCOUNT_CONNECTIONS', 'ACCOUNTANT_USERS', 'REPORT_EXPORTS', 'API_REQUEST_UNITS',
        'API_APPLICATIONS', 'WEBHOOK_DELIVERIES']) THEN
    RAISE EXCEPTION 'usage_reserve: % is not a metered unit', p_unit USING ERRCODE = '23514';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_reserve: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  v_row := rekoda_private.usage_meter_row(p_business, p_period, p_unit);
  -- The caller's allowance may only lower the ceiling the database computes.
  v_ceiling := least(p_allowance, public.usage_entitlement(p_business, p_unit));
  -- One statement carries the ceiling (0216): the SELECT's WHERE guards a fresh row, the EXISTS
  -- sends an existing row to the conflict arm, whose WHERE re-checks against `ceiling + bonus`.
  INSERT INTO public.usage_counters AS c (business_id, period, unit, used)
  SELECT p_business, v_row, p_unit, p_n
  WHERE p_n <= v_ceiling
     OR EXISTS (SELECT 1 FROM public.usage_counters e
                WHERE e.business_id = p_business AND e.period = v_row AND e.unit = p_unit)
  ON CONFLICT (business_id, period, unit) DO UPDATE
    SET used = c.used + p_n, updated_at = now()
    WHERE c.used + p_n <= v_ceiling + c.bonus
  RETURNING c.used INTO v_used;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;
  IF NOT p_refundable THEN
    RETURN QUERY SELECT true, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO public.usage_reservations (business_id, period, unit, quantity)
  VALUES (p_business, v_row, p_unit, p_n)
  RETURNING id INTO v_id;
  DELETE FROM public.usage_reservations
  WHERE id IN (SELECT r.id FROM public.usage_reservations r
               WHERE r.business_id = p_business AND r.created_at < now() - interval '90 days'
               ORDER BY r.created_at LIMIT 20);
  RETURN QUERY SELECT true, v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Give back: an unbound reservation only while the request that made it can still be running.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_refund(
  p_business uuid,
  p_reservation uuid,
  p_unit text,
  p_n integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  v_back integer;
BEGIN
  IF p_business IS NULL OR p_reservation IS NULL OR p_unit IS NULL OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_refund: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_refund: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id, period, unit, quantity, refunded, created_at, closed_at, event_id INTO r
  FROM public.usage_reservations
  WHERE id = p_reservation AND business_id = p_business
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0; -- the spend never committed (its transaction rolled back), or is long past
  END IF;
  IF r.unit <> p_unit THEN
    RAISE EXCEPTION 'usage_refund: the reservation is for another unit' USING ERRCODE = '22023';
  END IF;
  IF r.closed_at IS NOT NULL THEN
    RETURN 0; -- the work it paid for is finished: the unit was used (0218)
  END IF;
  IF r.created_at < now() - interval '45 days' THEN
    RETURN 0;
  END IF;
  -- Held by a request, not by a job: its refund is part of that request (0222).
  IF r.event_id IS NULL AND r.created_at < now() - interval '15 minutes' THEN
    RETURN 0;
  END IF;
  v_back := least(p_n, r.quantity - r.refunded);
  IF v_back <= 0 THEN
    RETURN 0; -- already given back
  END IF;
  UPDATE public.usage_counters
  SET used = greatest(used - v_back, 0), updated_at = now()
  WHERE business_id = p_business AND period = r.period AND unit = r.unit;
  UPDATE public.usage_reservations
  SET refunded = refunded + v_back, refunded_at = now()
  WHERE id = r.id;
  RETURN v_back;
END $$;

ALTER FUNCTION public.usage_entitlement(uuid, text) OWNER TO rekoda_usage_writer;
ALTER FUNCTION rekoda_private.usage_meter_row_at(uuid, text, text, timestamptz)
  OWNER TO rekoda_usage_writer;
ALTER FUNCTION rekoda_private.usage_meter_row(uuid, text, text) OWNER TO rekoda_usage_writer;
ALTER FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean)
  OWNER TO rekoda_usage_writer;
ALTER FUNCTION public.usage_refund(uuid, uuid, text, integer) OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION public.usage_entitlement(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.usage_refund(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_entitlement(uuid, text) TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_refund(uuid, uuid, text, integer)
  TO rekoda_app, rekoda_worker;

-- The two row functions run inside `usage_reserve`, as the writer; they are SECURITY DEFINER too so
-- the smoke's rule (every writer-owned function is SECURITY DEFINER with a pinned search_path)
-- holds. They read only the business's plan and its own counter rows, under the caller's pin.
ALTER FUNCTION rekoda_private.usage_meter_row_at(uuid, text, text, timestamptz) SECURITY DEFINER;
ALTER FUNCTION rekoda_private.usage_meter_row(uuid, text, text) SECURITY DEFINER;

-- ---------------------------------------------------------------------------------------------
-- 5 and 6. The job guard applies to whoever acts with the application's rights.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.jobs_application_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Any role holding rekoda_app's privileges (rekoda_app itself, or a login role that inherits it),
  -- except the table owner (migrations, the integration harness). Matching the role NAME let an
  -- inheriting login skip the guard (review of `ece0e14`, residual 11).
  IF NOT pg_has_role(current_user, 'rekoda_app', 'USAGE')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  -- Settlement's jobs (0217): the application enqueues them (the Paystack pump, a no-charge upgrade)
  -- and an operator may requeue a dead one, but only settlement runs, completes or reschedules them.
  -- A holder of the application credential could otherwise withhold a verified payment by marking
  -- its job done, by pushing its run time out, or by enqueueing it already finished (review, 0222).
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind IN ('billing.process', 'billing.apply_no_charge')
       AND (NEW.state IS DISTINCT FROM 'pending' OR NEW.locked_by IS NOT NULL
            OR NEW.locked_at IS NOT NULL OR NEW.attempts <> 0
            OR NEW.run_at > now() + interval '1 minute') THEN
      RAISE EXCEPTION 'the application enqueues a settlement job only as pending work due now (0222)'
        USING ERRCODE = '42501';
    END IF;
    -- And only for the thing its singleton key names, which must exist for this business: a job
    -- squatting an event's key with a payload naming something else would make the pump treat the
    -- verified payment as queued while settlement settles nothing (review of `10ef5c9`).
    IF NEW.kind = 'billing.process'
       AND (NEW.singleton_key IS DISTINCT FROM 'billevent:' || (NEW.payload ->> 'eventId')
            OR NOT EXISTS (SELECT 1 FROM public.external_events e
                           WHERE e.id::text = NEW.payload ->> 'eventId'
                             AND e.business_id = NEW.business_id AND e.provider = 'paystack')) THEN
      RAISE EXCEPTION 'a settlement job names the Paystack event of its singleton key, for its business (0222)'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.kind = 'billing.apply_no_charge'
       AND (NEW.singleton_key IS DISTINCT FROM 'no-charge:' || (NEW.payload ->> 'reference')
            OR NOT EXISTS (SELECT 1 FROM public.subscription_charges c
                           WHERE c.reference = NEW.payload ->> 'reference'
                             AND c.business_id = NEW.business_id)) THEN
      RAISE EXCEPTION 'a settlement job names the charge of its singleton key, for its business (0222)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind IN ('billing.process', 'billing.apply_no_charge')
     AND NOT (OLD.state = 'dead' AND NEW.state = 'pending') THEN
    RAISE EXCEPTION 'only settlement runs, completes or reschedules a settlement job; the application may requeue a dead one (0222)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
    -- The lease decides whether the handler's fenced completion still matches its row, and when
    -- the worker's reclaim takes the job back (OD-52, 0220).
    IF NEW.locked_by IS DISTINCT FROM OLD.locked_by
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'a job''s lease changes only as it moves from running to done, or from dead to pending, for the application (OD-52)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'done' THEN
    RETURN NEW;
  END IF;
  -- A recovered dead job goes back to the queue with no lease, as `deadJobs.startRecovery` writes
  -- it; the worker's claim takes it from there (residual 10).
  IF OLD.state = 'dead' AND NEW.state = 'pending'
     AND NEW.locked_by IS NULL AND NEW.locked_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a job''s state moves only from running to done, or from dead to pending with no lease, for the application (OD-52)'
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.jobs_application_transition_guard() FROM PUBLIC;
-- The guard now also sees the application's inserts (same trigger name: the boot check and the
-- smoke count it once).
DROP TRIGGER IF EXISTS jobs_application_transition_guard ON jobs;
CREATE TRIGGER jobs_application_transition_guard
  BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_application_transition_guard();

CREATE OR REPLACE FUNCTION rekoda_private.external_events_worker_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Any role holding rekoda_worker's privileges, except the table owner (residual 11).
  IF NOT pg_has_role(current_user, 'rekoda_worker', 'USAGE')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at
     AND NEW.error IS NOT DISTINCT FROM OLD.error THEN
    RETURN NEW;  -- a no-op (the dead-job flag is COALESCEd onto an already-flagged event)
  END IF;
  IF OLD.business_id IS NOT NULL THEN
    -- Attributed: only the dead-job flag, on an event nobody has processed or resolved.
    IF OLD.processed_at IS NULL AND NEW.processed_at IS NULL AND OLD.resolved_at IS NULL
       AND OLD.error IS NULL AND NEW.error IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the worker may only flag an attributed event, never process, clear or reopen it (OD-51)'
      USING ERRCODE = '42501';
  END IF;
  -- Unattributed: processed once, never reopened; a Paystack event only with a reason.
  IF OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL
     AND (OLD.provider IS DISTINCT FROM 'paystack' OR NEW.error IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the worker marks an unattributed event processed once, with a reason for a payment event (OD-51)'
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.external_events_worker_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 8. The provider's transaction id on a charge is settlement's to write.
-- ---------------------------------------------------------------------------------------------
-- The 0216 definition, unchanged except that the general role may not change `provider_reference`.
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RETURN NEW;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.priced_at := coalesce(NEW.priced_at, NEW.created_at);
    IF NEW.priced_at > NEW.created_at + interval '1 minute'
       OR NEW.priced_at < NEW.created_at - interval '5 minutes' THEN
      RAISE EXCEPTION 'a charge is priced at most five minutes before it is opened (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    IF current_user = 'rekoda_settlement' THEN
      IF NEW.units_credited_at IS NOT NULL THEN
        RAISE EXCEPTION 'a pack is credited only through usage_credit_pack (OD-51)'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.paid_at IS NOT NULL OR NEW.paid_amount_k IS NOT NULL
       OR NEW.provider_reference IS NOT NULL OR NEW.provider_paid_at IS NOT NULL
       OR NEW.provider_settled_at IS NOT NULL OR NEW.units_credited_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL
       OR NEW.refunded_at IS NOT NULL OR coalesce(NEW.refunded_amount_k, 0) <> 0
       OR NEW.applied_period_start IS NOT NULL OR NEW.applied_period_end IS NOT NULL
       OR NEW.checkout_url IS NOT NULL OR NEW.checkout_started_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL
       OR NEW.unapplied_at IS NOT NULL OR NEW.unapplied_reason IS NOT NULL
       OR NEW.unapplied_resolved_at IS NOT NULL OR NEW.unapplied_resolution IS NOT NULL
       OR NEW.unapplied_resolved_by IS NOT NULL
       OR NEW.blocked_resolved_by IS NOT NULL OR NEW.blocked_resolution IS NOT NULL
       OR NEW.blocked_at IS NOT NULL OR NEW.blocked_reason IS NOT NULL
       OR NEW.blocked_resolved_at IS NOT NULL OR NEW.blocked_close_failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the application opens only a new pending charge; settlement records the rest (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- usage_credit_pack (0216) runs as rekoda_usage_writer: it may stamp the credit time of a paid
  -- pack charge, once, and change nothing else on the row.
  IF current_user = 'rekoda_usage_writer' THEN
    IF OLD.kind = 'add_on' AND OLD.status = 'paid' AND OLD.unapplied_at IS NULL
       AND OLD.units_credited_at IS NULL AND NEW.units_credited_at IS NOT NULL
       AND (to_jsonb(NEW) - 'units_credited_at' - 'updated_at')
           = (to_jsonb(OLD) - 'units_credited_at' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the usage writer records only the credit time of a paid pack charge (OD-51)'
      USING ERRCODE = '42501';
  END IF;

  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    IF NEW.priced_at IS DISTINCT FROM OLD.priced_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)' USING ERRCODE = '42501';
    END IF;
    -- The credit time is written by usage_credit_pack alone, in the call that raises the ceiling.
    IF NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a pack is credited only through usage_credit_pack (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.amount_k IS DISTINCT FROM OLD.amount_k
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.priced_at IS DISTINCT FROM OLD.priced_at THEN
    RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
    RAISE EXCEPTION 'only settlement moves a charge''s status, apart from a refund (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.paid_amount_k IS DISTINCT FROM OLD.paid_amount_k
     OR NEW.provider_paid_at IS DISTINCT FROM OLD.provider_paid_at
     OR NEW.provider_settled_at IS DISTINCT FROM OLD.provider_settled_at
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at
     -- The provider's transaction id is payment evidence, written by settlement (MVP readiness
     -- review, 0222): the application holds the column grant for the lifecycle columns beside it.
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
          OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;
