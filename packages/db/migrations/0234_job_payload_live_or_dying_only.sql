-- Second independent review of PR #432 (R07, IMPORTANT): what `job_payload` returns, narrowed to what
-- the worker reads, and its guarantee stated exactly.
--
-- What the database enforces, and what it does not (verified by
-- `packages/db/src/ops/job-payload-isolation.integration.test.ts`, "RESIDUAL" cases):
--   * the worker holds no SELECT on `jobs.payload` (0228), so a statement naming the column, the
--     whole row or a filter on it is refused;
--   * `job_payload(job)` returns a payload only where the job's business is the tenant pinned AT THAT
--     CALL. The pin is a caller-set setting any role may change, so ONE statement can read every
--     payload of the pinned business, and a statement that re-pins per row
--     (`set_config('app.business_id', business_id, true)` in a subquery) reads every tenant's. The
--     worker credential is trusted with every tenant's jobs (it claims and runs them, ADR 0035
--     class 2); 0228 removed the plain column read, not that trust. The repository-level rule
--     (`scripts/lib/job-payload-reads.mjs`) and the statement-level test
--     (`dead-job-enrolment-pin.test.ts`) are what keep the worker's own code to one job, under
--     that job's own pin.
--
-- What 0234 adds: `job_payload` now returns a payload only for a job the worker is actually
-- handling, which are the only reads its code makes:
--   * `running` (the claim reads the payload of the job it has just moved to running; `markFailed`
--     reads it in the transaction that moves it on);
--   * `dead`, for the two kinds that leave a dead-job record (`payment.process`, `billing.process`;
--     `DEAD_JOB_EXCEPTION_KINDS`): the reclaim, `markFailed` and the cutover enrolment read the
--     dead job's payload to record its death.
-- A pending backlog and a completed job's history (`done`, and every other dead kind) are no longer
-- readable through the function by any caller, pin or not. A holder of the worker credential can
-- therefore still read jobs that are running or dying, tenant by tenant; it can no longer read the
-- history of merchants' messages and documents already processed.
--
-- Not a compatibility break: this release's worker reads only those states. Re-running is safe.

CREATE OR REPLACE FUNCTION public.job_payload(p_job uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.payload FROM public.jobs j
  WHERE j.id = p_job
    AND j.business_id = nullif(current_setting('app.business_id', true), '')::uuid
    AND (j.state = 'running'
         OR (j.state = 'dead' AND j.kind IN ('payment.process', 'billing.process')))
$$;
REVOKE ALL ON FUNCTION public.job_payload(uuid)
  FROM PUBLIC, rekoda_app, rekoda_billing_operator, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.job_payload(uuid) TO rekoda_worker;
