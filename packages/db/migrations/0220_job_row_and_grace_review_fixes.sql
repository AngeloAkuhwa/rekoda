-- OD-52 and two review minors (independent security review of `4d5f1cd..5654ee2`, 12 Nov 2026;
-- owner instruction OWN-91: an OD-51 limit is closed, not accepted).
--
-- 0218 closes a usage reservation when its event's job is marked done. The review showed the
-- application credential could keep a delivered unit refundable anyway, by tampering with the job
-- row the closure keys on:
--   1. the closing trigger matched `payload->>'eventId'` against the hyphenated uuid pattern, while
--      the handlers accept any text PostgreSQL casts to a uuid (hyphenless, braced), so a job
--      written that way ran normally and closed nothing;
--   2. `rekoda_app` could rewrite the payload (drop or change `eventId`) while the job ran;
--   3. `rekoda_app` could delete the job, or move it away from `running`, before it was marked done.
--
-- After this migration:
--   * the trigger casts the id (anything that is a uuid closes; anything that is not closes nothing
--     and breaks nothing);
--   * `rekoda_app` keeps INSERT on `jobs` (it enqueues work) and may UPDATE only the columns its two
--     job writes use: `markDone` and an operator's recovery requeue (state, locked_at, locked_by,
--     run_at, max_attempts, updated_at). No DELETE, no payload, kind or business change. The worker
--     was narrowed the same way in 0210 and 0212;
--   * a guard lets the application move a job's state only from running to done (the handler's last
--     step, which closes the reservations) or from dead to pending (the recovery requeue). It cannot
--     park a running job as pending or dead, and cannot reopen a finished one.
--
-- Two minors from the same review:
--   * `subscription_start_grace` (0217) refuses a cycle that has not ended: a renewal row can be
--     open before the renewal date, and the clock started early would dun a business that is paid
--     up. The renewal sweep calls it only after the end has passed.
--
-- What remains is stated in the OD-52 row of `docs/REKODA_LAUNCH_READINESS.md`: the worker
-- credential decides that a job died, as it must; a dead job's reservation stays refundable for an
-- operator's recovery retry (nothing refunds it automatically, as before this migration).
--
-- Compatibility: BREAKING for a release older than this one only where it wrote `jobs` as the
-- application in other ways; it ships in the same stopped release as 0216 to 0218. Rollback: none
-- past 0196 (OWN-86). Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The closing trigger reads the event id by casting it.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event uuid;
BEGIN
  BEGIN
    v_event := (NEW.payload ->> 'eventId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW; -- not an event id: a job that is not about an event holds no reservation
  END;
  IF v_event IS NULL THEN
    RETURN NEW;
  END IF;
  UPDATE public.usage_reservations
  SET closed_at = now()
  WHERE business_id = NEW.business_id AND event_id = v_event AND closed_at IS NULL;
  RETURN NEW;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_usage_writer) and the revoked EXECUTE of 0218.

-- ---------------------------------------------------------------------------------------------
-- 2. The application's writes on jobs: enqueue, finish, recover. Nothing else.
-- ---------------------------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON jobs FROM rekoda_app;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT column_name
    FROM information_schema.column_privileges
    WHERE grantee = 'rekoda_app' AND table_schema = 'public' AND table_name = 'jobs'
      AND privilege_type = 'UPDATE'
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.jobs FROM rekoda_app', r.column_name);
  END LOOP;
END $$;
GRANT UPDATE (state, locked_at, locked_by, run_at, max_attempts, updated_at) ON jobs TO rekoda_app;

CREATE OR REPLACE FUNCTION rekoda_private.jobs_application_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user <> 'rekoda_app' OR OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;
  IF (OLD.state = 'running' AND NEW.state = 'done')
     OR (OLD.state = 'dead' AND NEW.state = 'pending') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a job''s state moves only from running to done, or from dead to pending, for the application (OD-52)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.jobs_application_transition_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_application_transition_guard ON jobs;
CREATE TRIGGER jobs_application_transition_guard
  BEFORE UPDATE OF state ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.jobs_application_transition_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. The grace clock starts only for a cycle that has ended. Otherwise the function of 0217.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_start_grace(
  p_business uuid,
  p_failed_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_business IS NULL OR p_failed_at IS NULL THEN
    RAISE EXCEPTION 'subscription_start_grace: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_start_grace: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, payment_failed_at INTO b
  FROM public.businesses WHERE id = p_business FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_start_grace: no such business' USING ERRCODE = '42501';
  END IF;
  IF b.payment_failed_at IS NOT NULL THEN
    RETURN false; -- already running: the seven days count from the first failure
  END IF;
  IF b.plan NOT IN ('chat', 'integrate', 'complete') OR b.plan_expires_at IS NULL THEN
    RAISE EXCEPTION 'subscription_start_grace: only a paid plan with a renewal date has a grace clock'
      USING ERRCODE = '22023';
  END IF;
  -- The cycle must have ENDED (0220): a renewal can be open before the renewal date, and a grace
  -- clock started early would put a paying business into dunning while it is still paid up. The
  -- renewal sweep only ever calls this for a cycle whose end has passed.
  IF b.plan_expires_at > v_now THEN
    RAISE EXCEPTION 'subscription_start_grace: the cycle has not ended' USING ERRCODE = '22023';
  END IF;
  -- The cycle it is for must have a renewal open: the sweep opens one only when the cycle is due.
  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_charges c
    WHERE c.business_id = p_business AND c.kind = 'renewal' AND c.status = 'pending'
      AND c.superseded_at IS NULL
      AND date_trunc('milliseconds', c.period_start) = date_trunc('milliseconds', b.plan_expires_at)
  ) THEN
    RAISE EXCEPTION 'subscription_start_grace: no renewal is open for the cycle that ended'
      USING ERRCODE = '22023';
  END IF;
  -- From the cycle's end to now (the sweep's rule: the renewal date, floored at two days ago),
  -- never before the cycle ended and never in the future.
  IF p_failed_at < b.plan_expires_at - interval '1 second'
     OR p_failed_at > v_now + interval '1 minute' THEN
    RAISE EXCEPTION 'subscription_start_grace: the grace clock starts between the end of the cycle and now'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET payment_failed_at = p_failed_at, updated_at = now()
  WHERE id = p_business;
  RETURN true;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the grants of 0217.
