-- Final independent review of PR #432 (head 0b4956a): two guards that tested less than they claimed.
--
-- 1. (IMPORTANT, security) The worker transition guard recognises the worker by privilege, not by
--    name. 0238 refused the worker any change of `jobs.state` outside its own transitions, but it
--    tested `current_user <> 'rekoda_worker'`. A role that only INHERITS rekoda_worker holds every
--    worker grant and policy (`worker_claim`, EXECUTE on `job_payload`) yet skipped the guard, so it
--    could move a done job back to running, pin its business and read the payload: the B-1 attack
--    0238 closed. 0222 (residual 11) already fixed exactly this for the application and event
--    guards; 0238 reintroduced the name check. The guard now applies to any role that holds the
--    worker's privileges and is not the table owner, the 0222 pattern. Its transitions are unchanged:
--      pending -> running                 the claim
--      running -> done | pending | dead   completion, retry, deferral, reclaim, death
--
-- 2. (financial truth) A trial's expiry is an allowance change. `usage_entitlement` (0222) reads a
--    trial's `plan_expires_at`: a trial past it reads `expired`, which sells nothing. 0240 recorded
--    only changes of `plan` and `plan_version_id`, and its header held that a date-based drop is safe
--    because a lower allowance fails the equality check. That holds only while the allowance stays
--    lower: an expiry moved past and back with `plan` unchanged (the staging date tool, 0197, or a
--    trial re-posted over a legacy row whose stored expiry was short) left no history row, and a
--    pack whose units paid for the consumption while the trial read expired was refunded in full as
--    unused. A change of `plan_expires_at` on a row that is, or was, a trial is now recorded as well.
--    A paid plan's expiry is not recorded: a paid lapse and its renewal are plan writes (0200), and
--    recording every renewal would send every later pack refund to the owner for no reason.
--    The history time also no longer moves backwards when two writers of one business's holdings
--    overlap: the later of the two times is kept.
--
-- Not a compatibility break: both functions are replaced in place, the jobs trigger is unchanged, and
-- the previous release's worker makes only these transitions. Re-running 0238 or 0240 by hand
-- afterwards puts their weaker definitions back, so either must be followed by this file again (the
-- migration runner applies each file once, in order; the pre-start smoke checks this text).
-- Re-running is safe.

CREATE OR REPLACE FUNCTION rekoda_private.jobs_worker_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'rekoda_worker', 'USAGE')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
     OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF (OLD.state = 'pending' AND NEW.state = 'running')
     OR (OLD.state = 'running' AND NEW.state IN ('done', 'pending', 'dead')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the worker moves a job only through its own transitions (0238, 0241): % to % is refused',
    OLD.state, NEW.state USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.jobs_worker_transition_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION rekoda_private.note_allowance_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_business uuid;
  v_pin text := current_setting('app.business_id', true);
BEGIN
  IF TG_TABLE_NAME = 'businesses' THEN
    v_business := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
  ELSE
    v_business := NEW.business_id;
  END IF;
  PERFORM set_config('app.business_id', v_business::text, true);
  INSERT INTO public.business_allowance_changes AS a (business_id, changed_at)
  VALUES (v_business, clock_timestamp())
  ON CONFLICT (business_id) DO UPDATE SET changed_at = greatest(a.changed_at, excluded.changed_at);
  PERFORM set_config('app.business_id', coalesce(v_pin, ''), true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.note_allowance_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_note_allowance_change ON businesses;
CREATE TRIGGER businesses_note_allowance_change
  AFTER UPDATE OF plan, plan_version_id, plan_expires_at ON businesses
  FOR EACH ROW
  WHEN (OLD.plan IS DISTINCT FROM NEW.plan
        OR OLD.plan_version_id IS DISTINCT FROM NEW.plan_version_id
        OR ((OLD.plan = 'trial' OR NEW.plan = 'trial')
            AND OLD.plan_expires_at IS DISTINCT FROM NEW.plan_expires_at))
  EXECUTE FUNCTION rekoda_private.note_allowance_change();
