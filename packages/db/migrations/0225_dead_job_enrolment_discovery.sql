-- Final review of PR #432 (14 Nov 2026): the cutover enrolment of unrecorded dead jobs crosses
-- tenants only to discover ids.
--
-- `jobsRepo.enrolUnrecordedDeaths` (OWN-73, OWN-76 cutover) gives a dead `payment.process` or
-- `billing.process` job that has no dead-job record (it died before 0194, or under an old worker
-- mid-rollout) the record a death writes now. Until this migration it did so with one unpinned
-- query on the worker credential that read every tenant's dead jobs, payload included, through the
-- queue policy (`worker_claim`, 0004), and the cross-tenant event estate (`worker_reads_the_estate`,
-- 0204), then wrote every record in one transaction, so one business's failure rolled back every
-- other business's enrolment. The rls-exemption register filed it under ADR 0035 Amendment 2's
-- definer functions, which it was not.
--
-- After this migration the cross-tenant step is this function, ADR 0035 Amendment 1, class 2 (ID-only
-- scheduling discovery), for one named operation (the cutover enrolment):
--
--   * SECURITY DEFINER, `search_path` pinned, owned by the migrating role (which bypasses RLS, like
--     the other discovery functions), EXECUTE for `rekoda_worker` only. Settlement does not run the
--     pass: Amendment 5 has the worker record the deaths of the settlement kinds as well.
--   * Input: a page size only, 1 to 200 (anything else is refused, 22023). No merchant input.
--   * Output: the job id and its business id, nothing else: never a payload, an event, a reference
--     or an error.
--   * Each candidate is then re-read, re-checked and recorded by `jobsRepo.enrolDeath` in its own
--     transaction under `withBusiness()` for that job's business, reading the job only where its
--     business is the pinned one; a failure there rolls back that job alone.
--
-- What the database does NOT enforce: the worker's queue policy still lets its credential read any
-- job row (it claims across tenants), so "the payload is read only under the job's pin" is an
-- application-level property of the repository, proved statement by statement in
-- `src/ops/dead-job-enrolment-pin.test.ts` and held by the boundary check (`scripts/check-boundaries.mjs`,
-- "cross-tenant job payload read").
--
-- Compatibility: additive (one function). The previous release never calls it and its own enrolment
-- query is unchanged by it. Not compatibility-breaking. Rollback: drop the function after rolling the
-- code back. Re-running is safe.

CREATE OR REPLACE FUNCTION public.dead_job_unrecorded_candidates(p_limit integer)
RETURNS TABLE (job_id uuid, business_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'dead_job_unrecorded_candidates: the page size is 1 to 200'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT j.id, j.business_id
  FROM public.jobs j
  WHERE j.state = 'dead' AND j.kind IN ('payment.process', 'billing.process')
    AND j.business_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.dead_job_exceptions d WHERE d.job_id = j.id)
    -- Work already settled another way (its event processed or resolved) is not a candidate, so it
    -- cannot fill every page. The id is compared as lower-cased text and never cast, so a malformed
    -- payload value matches nothing and cannot throw. Evaluated here, inside the function; the
    -- caller never sees the payload.
    AND NOT EXISTS (SELECT 1 FROM public.external_events e
                     WHERE e.id::text = lower(j.payload->>'eventId') AND e.business_id = j.business_id
                       AND (e.resolved_at IS NOT NULL OR e.processed_at IS NOT NULL))
  ORDER BY j.updated_at, j.id
  LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION public.dead_job_unrecorded_candidates(integer)
  FROM PUBLIC, rekoda_app, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_unrecorded_candidates(integer) TO rekoda_worker;
