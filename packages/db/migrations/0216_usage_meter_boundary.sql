-- OD-51.4 (owner instruction, 12 Nov 2026, PR #432): the usage meter is written only through
-- database functions that check each change, never by a runtime role directly.
--
-- Until now `rekoda_app` (and `rekoda_worker`, for webhook-delivery metering) held INSERT and
-- UPDATE on `usage_counters`. Consumption was one guarded statement in the repository, but nothing
-- in the database stopped a holder of either credential from writing `used = 0` (a month's
-- allowance restored for free, the effect of a pack without a payment), or any other value. Pack
-- units (`bonus`) were already settlement's alone (0202), written by a direct UPDATE.
--
-- After this migration no runtime role can INSERT, UPDATE or DELETE a usage counter. Every change
-- goes through one of three functions, owned by a NOLOGIN role (`rekoda_usage_writer`) that holds
-- exactly the table rights they need:
--
--   usage_reserve(business, period, unit, allowance, n, refundable)   rekoda_app, rekoda_worker
--       Spends `n` units against `allowance + bonus`, in one statement, exactly as before. When
--       `refundable`, it records the spend in `usage_reservations` and returns the reservation's
--       id: the only handle a later refund can use.
--   usage_refund(business, reservation, unit, n)                      rekoda_app, rekoda_worker
--       Gives back at most what THAT reservation spent and has not already returned, to the
--       counter row it was spent on, within 45 days. The reservation must belong to the pinned
--       business and name the same unit. There is no other way to lower `used`.
--   usage_credit_pack(business, reference, period, unit, n)           rekoda_settlement
--       Credits a pack's units for ONE paid, not-set-aside, not-yet-credited pack charge and
--       stamps the charge credited in the same call, so a charge can raise `bonus` once, ever.
--       `units_credited_at` can no longer be written any other way, by settlement included.
--
-- What this does and does not claim. The application is still the code that decides a metered
-- action happened and what the plan allows: it calls `usage_reserve` with the allowance it
-- resolved, so a compromised application credential can still meter a business wrongly going
-- forward (or serve an action without metering it at all; no database rule can observe that). What
-- it can no longer do is rewrite a counter: lower `used` other than by returning a reservation it
-- holds, once and never past what was reserved; raise `bonus`; or delete a row.
--
-- In-flight reservations: a message that reserved a unit before this migration recorded only the
-- counter row on its event (`external_events.reserved_units` / `reserved_meters`). Each of those
-- records is given a reservation here and its stored handle rewritten to carry it, so a retry that
-- gives the unit back still can. No counter value is changed.
--
-- Compatibility: BREAKING for the previous release (it writes `usage_counters` directly); applied
-- with the api and worker stopped. Rollback: none past 0196 (OWN-86). Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The writer role and the reservation ledger.
-- ---------------------------------------------------------------------------------------------
DO $$ BEGIN
  CREATE ROLE rekoda_usage_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE rekoda_usage_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  offender text;
BEGIN
  SELECT r INTO offender
  FROM unnest(ARRAY['rekoda_app', 'rekoda_worker', 'rekoda_settlement', 'rekoda_billing_operator',
                    'rekoda_plan_writer']) AS r
  WHERE pg_has_role(r, 'rekoda_usage_writer', 'MEMBER')
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0216: % is a member of rekoda_usage_writer; revoke the membership first', offender
      USING ERRCODE = '42501';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  -- The counter row the units were spent on: a calendar month, or the trial row.
  period char(7) NOT NULL,
  unit text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  refunded integer NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  CHECK (refunded <= quantity)
);
CREATE INDEX IF NOT EXISTS usage_reservations_business_ix
  ON usage_reservations (business_id, created_at);

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON usage_reservations
    USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
    WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No runtime role reads or writes the ledger; the functions below are the only way in.
REVOKE ALL ON usage_reservations
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;

GRANT USAGE ON SCHEMA public TO rekoda_usage_writer;
GRANT USAGE ON SCHEMA rekoda_private TO rekoda_usage_writer;
GRANT SELECT, INSERT, UPDATE ON usage_counters TO rekoda_usage_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_reservations TO rekoda_usage_writer;
GRANT SELECT ON subscription_charges TO rekoda_usage_writer;
GRANT UPDATE (units_credited_at, updated_at) ON subscription_charges TO rekoda_usage_writer;

-- ---------------------------------------------------------------------------------------------
-- 2. Spend.
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
BEGIN
  IF p_business IS NULL OR p_unit IS NULL OR p_refundable IS NULL
     OR p_period IS NULL OR p_period !~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'
     OR p_allowance IS NULL OR p_allowance < 0 OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_reserve: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_reserve: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  -- One statement carries the ceiling, as the repository's always did: the SELECT's WHERE guards
  -- the fresh row (an allowance of zero refuses the very first unit), the EXISTS sends an existing
  -- row to the conflict arm, whose WHERE re-checks against `allowance + bonus`. Two concurrent
  -- spenders cannot both take the last unit: the database picks the winner.
  INSERT INTO public.usage_counters AS c (business_id, period, unit, used)
  SELECT p_business, p_period::char(7), p_unit, p_n
  WHERE p_n <= p_allowance
     OR EXISTS (SELECT 1 FROM public.usage_counters e
                WHERE e.business_id = p_business AND e.period = p_period::char(7) AND e.unit = p_unit)
  ON CONFLICT (business_id, period, unit) DO UPDATE
    SET used = c.used + p_n, updated_at = now()
    WHERE c.used + p_n <= p_allowance + c.bonus
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
  VALUES (p_business, p_period::char(7), p_unit, p_n)
  RETURNING id INTO v_id;
  -- Reservations past any refund are of no further use: a few of this business's oldest go with
  -- each new one, so the ledger stays the size of the last three months.
  DELETE FROM public.usage_reservations
  WHERE id IN (SELECT r.id FROM public.usage_reservations r
               WHERE r.business_id = p_business AND r.created_at < now() - interval '90 days'
               ORDER BY r.created_at LIMIT 20);
  RETURN QUERY SELECT true, v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Give back: only what one reservation spent, once, to the row it was spent on.
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
  SELECT id, period, unit, quantity, refunded, created_at INTO r
  FROM public.usage_reservations
  WHERE id = p_reservation AND business_id = p_business
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0; -- the spend never committed (its transaction rolled back), or is long past
  END IF;
  IF r.unit <> p_unit THEN
    RAISE EXCEPTION 'usage_refund: the reservation is for another unit' USING ERRCODE = '22023';
  END IF;
  IF r.created_at < now() - interval '45 days' THEN
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

-- ---------------------------------------------------------------------------------------------
-- 4. Pack units: once per paid pack charge, stamped in the same call.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_credit_pack(
  p_business uuid,
  p_reference text,
  p_period text,
  p_unit text,
  p_n integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR p_unit IS NULL
     OR p_period IS NULL OR p_period !~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'
     OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_credit_pack: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_credit_pack: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id, kind, status, units_credited_at, unapplied_at INTO c
  FROM public.subscription_charges
  WHERE business_id = p_business AND reference = p_reference
  FOR UPDATE;
  IF NOT FOUND OR c.kind IS DISTINCT FROM 'add_on' OR c.status IS DISTINCT FROM 'paid'
     OR c.unapplied_at IS NOT NULL THEN
    RAISE EXCEPTION 'usage_credit_pack: not a paid pack charge that may be credited'
      USING ERRCODE = '42501';
  END IF;
  IF c.units_credited_at IS NOT NULL THEN
    RETURN false; -- credited already: a charge raises the ceiling once
  END IF;
  INSERT INTO public.usage_counters AS u (business_id, period, unit, bonus)
  VALUES (p_business, p_period::char(7), p_unit, p_n)
  ON CONFLICT (business_id, period, unit) DO UPDATE
    SET bonus = u.bonus + p_n, updated_at = now();
  UPDATE public.subscription_charges
  SET units_credited_at = clock_timestamp(), updated_at = now()
  WHERE id = c.id;
  RETURN true;
END $$;

ALTER FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean)
  OWNER TO rekoda_usage_writer;
ALTER FUNCTION public.usage_refund(uuid, uuid, text, integer) OWNER TO rekoda_usage_writer;
ALTER FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.usage_refund(uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.usage_reserve(uuid, text, text, integer, integer, boolean)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_refund(uuid, uuid, text, integer)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- 5. No runtime role writes a counter directly.
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON usage_counters
  FROM rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'usage_counters'
      AND grantee IN ('rekoda_app', 'rekoda_worker', 'rekoda_settlement', 'rekoda_billing_operator')
      AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE %s (%I) ON public.usage_counters FROM %I',
      r.privilege_type, r.column_name, r.grantee);
  END LOOP;
END $$;

-- The pack-credit guard (0202): `bonus` rises only inside usage_credit_pack (or as the table
-- owner). Settlement's own credential no longer raises it directly.
CREATE OR REPLACE FUNCTION rekoda_private.usage_counters_bonus_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_usage_writer'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.bonus > 0)
     OR (TG_OP = 'UPDATE' AND NEW.bonus > OLD.bonus) THEN
    RAISE EXCEPTION 'pack units are credited only through usage_credit_pack (OD-51)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.usage_counters_bonus_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 6. A charge's credit time is written by usage_credit_pack alone.
-- ---------------------------------------------------------------------------------------------
-- The settlement guard of 0212, unchanged except for `units_credited_at`: the usage writer may
-- stamp it once on a paid pack charge (and touch nothing else), and no other runtime role, the
-- settlement principal included, may write it at all.
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
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
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
          OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 7. Reservations already recorded on messages keep their way back.
-- ---------------------------------------------------------------------------------------------
-- An entry of `reserved_units` is a unit name, optionally with its quantity ("VOICE_MINUTES:5");
-- `reserved_meters` maps the unit name to the counter row it was spent on (absent before 0175: the
-- unit was spent in the month the message arrived). Each entry gets a reservation, and the stored
-- handle becomes `<row>#<reservation id>`, the form the repository now writes.
DO $$
DECLARE
  e record;
  u text;
  v_unit text;
  v_qty integer;
  v_row text;
  v_id uuid;
  v_meters jsonb;
BEGIN
  FOR e IN
    SELECT id, business_id, reserved_units, reserved_meters, created_at
    FROM public.external_events
    WHERE business_id IS NOT NULL AND cardinality(reserved_units) > 0
  LOOP
    v_meters := e.reserved_meters;
    FOREACH u IN ARRAY e.reserved_units LOOP
      v_unit := split_part(u, ':', 1);
      v_row := v_meters ->> v_unit;
      CONTINUE WHEN v_row LIKE '%#%'; -- already carries a reservation (a re-run)
      v_qty := CASE WHEN split_part(u, ':', 2) ~ '^[0-9]{1,9}$'
                    THEN greatest(split_part(u, ':', 2)::integer, 1) ELSE 1 END;
      v_row := coalesce(nullif(v_row, ''),
                        to_char(e.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM'));
      CONTINUE WHEN v_row !~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$';
      INSERT INTO public.usage_reservations (business_id, period, unit, quantity, created_at)
      VALUES (e.business_id, v_row::char(7), v_unit, v_qty, now())
      RETURNING id INTO v_id;
      v_meters := v_meters || jsonb_build_object(v_unit, v_row || '#' || v_id::text);
    END LOOP;
    IF v_meters IS DISTINCT FROM e.reserved_meters THEN
      UPDATE public.external_events SET reserved_meters = v_meters WHERE id = e.id;
    END IF;
  END LOOP;
END $$;
