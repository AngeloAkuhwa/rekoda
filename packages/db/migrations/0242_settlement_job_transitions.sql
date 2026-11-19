-- S-1 (owner instruction, 18 Nov 2026): the settlement credential moves its jobs only through the
-- settlement runner's own transitions.
--
-- Settlement claims, renews, completes, retries, defers, reclaims and kills the two settlement kinds
-- (`billing.process`, `billing.apply_no_charge`; 0217). 0238 and 0241 bound the worker's moves, but
-- no guard applied to settlement: the final closeout review reproduced `done -> pending` and
-- `dead -> pending` by the settlement credential (S-1). That re-runs a finished settlement job, or
-- revives a dead one outside the operator recovery OWN-73 and OWN-76 make the only way back from
-- dead (`deadJobsRepo.beginRecovery`: on the application credential, audited, after the reference is
-- verified with Paystack, with exactly one more attempt, enforced by the application guard of 0223).
-- Settlement also holds UPDATE on `attempts` and `run_at`, so it could hand a failing job its retry
-- budget back, or park it far in the future: the job would then never die, and its dead-job record
-- (the operator's work item) would never be written.
--
-- The guard applies to any role that holds rekoda_settlement's privileges (rekoda_settlement itself,
-- or a role that inherits it) and is not the table owner: the 0222 / 0241 privilege pattern, never
-- a role-name comparison. Settlement may only:
--   pending -> running                 the claim: exactly one attempt counted
--   running -> running                 the lease renewal: no attempt change
--   running -> pending                 a retry or reclaim (attempts unchanged), or a deferral (the
--                                      claim's attempt handed back: attempts - 1)
--   running -> done | dead             completion, death (attempts unchanged)
-- and it never moves a job's run time later than ten minutes from now (the runner's longest retry
-- backoff is five minutes, `jobsRepo.backoffMs`). Every other change of state or attempts is
-- refused, including any move out of done or dead. The settlement job-kind restrictions (0217) and
-- the operator's recovery path are unchanged.
--
-- Not a compatibility break: a new trigger, and the previous release's settlement runner makes only
-- these transitions. Re-running is safe.

CREATE OR REPLACE FUNCTION rekoda_private.jobs_settlement_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'rekoda_settlement', 'USAGE')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.run_at IS DISTINCT FROM OLD.run_at AND NEW.run_at > now() + interval '10 minutes' THEN
    RAISE EXCEPTION 'settlement moves a job only through its own transitions (0242): a run time more than ten minutes ahead is refused'
      USING ERRCODE = '42501';
  END IF;
  IF (OLD.state = 'pending' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts + 1)
     OR (OLD.state = 'running' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts)
     OR (OLD.state = 'running' AND NEW.state = 'pending'
         AND NEW.attempts IN (OLD.attempts, OLD.attempts - 1))
     OR (OLD.state = 'running' AND NEW.state IN ('done', 'dead') AND NEW.attempts = OLD.attempts) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement moves a job only through its own transitions (0242): % to % (attempts % to %) is refused',
    OLD.state, NEW.state, OLD.attempts, NEW.attempts USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.jobs_settlement_transition_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_settlement_transition_guard ON jobs;
CREATE TRIGGER jobs_settlement_transition_guard BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_settlement_transition_guard();
