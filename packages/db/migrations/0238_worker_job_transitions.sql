-- Independent review of the PR #432 remediation (B-1, IMPORTANT): the worker moves a job only through
-- the transitions its own code makes, so it cannot revive a job to read its payload.
--
-- 0234 made `job_payload` return a payload only for a running job or a dying payment or billing
-- job. But the worker credential holds UPDATE on `jobs.state` (0212), its claim policy is
-- unconditional (0004) and the transition guard (0220, 0227) applies to the application only. A
-- holder of the worker credential could therefore, in one transaction, set a finished
-- `inbound.message` job back to `running`, pin its business, read its payload and roll back,
-- leaving no trace: 0234's "a completed job's history is not readable" did not hold.
--
-- Since 0238 a BEFORE UPDATE trigger refuses the worker any change of `state` other than:
--   pending -> running                 the claim
--   running -> done | pending | dead   completion, retry, deferral, reclaim, death
-- (An operator's recovery requeues a dead job on the APPLICATION credential, under its own pin,
-- `deadJobsRepo.beginRecovery`; the worker never moves a dead job.) A completed or dead job can
-- no longer be moved by the worker at all, so a holder of its credential can neither read such a
-- job's payload nor re-run a dead payment job without an operator,
-- so their payloads stay unreadable to it. What remains (stated in ADR 0035 Amendment 6): the
-- worker can still claim a PENDING job of any tenant and read its payload, because running every
-- tenant's pending work is its job.
--
-- Not a compatibility break: this release's worker makes only these transitions. Re-running is safe.

CREATE OR REPLACE FUNCTION rekoda_private.jobs_worker_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user <> 'rekoda_worker' OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF (OLD.state = 'pending' AND NEW.state = 'running')
     OR (OLD.state = 'running' AND NEW.state IN ('done', 'pending', 'dead')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the worker moves a job only through its own transitions (0238): % to % is refused',
    OLD.state, NEW.state USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.jobs_worker_transition_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_worker_transition_guard ON jobs;
CREATE TRIGGER jobs_worker_transition_guard BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_worker_transition_guard();
