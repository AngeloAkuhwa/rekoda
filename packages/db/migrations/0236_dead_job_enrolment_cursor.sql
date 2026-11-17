-- Second independent review of PR #432 (R08, IMPORTANT): the cutover enrolment of unrecorded dead
-- jobs makes progress when recording a candidate's failure also fails.
--
-- 0229 made a failing candidate back off by recording the failure (`dead_job_enrolment_failed`).
-- When that write ALSO failed, the repository swallowed the error (`.catch(() => undefined)`), the
-- candidate kept no backoff and stayed at the head of the page, ordered by `updated_at, id`; a full
-- page of such candidates kept every later one from ever being reached, and the failure to record
-- was reported nowhere. Since 0236:
--   * `dead_job_unrecorded_candidates(page_size, after)` continues after the job id the previous
--     pass ended on (keyset on `updated_at, id`): the worker carries that cursor from pass to pass
--     and wraps to the beginning when a page comes back short, so every candidate is reached within
--     a bounded number of passes, whatever fails. Same grants (worker only), same id-only result.
--   * `dead_job_unrecorded_candidates(page_size)` is kept, unchanged in result, as the cursor-less
--     form (`after` NULL).
-- The repository now counts a failure-tracking failure separately and reports it by SQLSTATE
-- (`jobsRepo.enrolUnrecordedDeathsPage`); see also the reclaim change in the same commit (G2-1).
--
-- Not a compatibility break: additive (a new overload). Re-running is safe.

CREATE OR REPLACE FUNCTION public.dead_job_unrecorded_candidates(p_limit integer, p_after uuid)
 RETURNS TABLE(job_id uuid, business_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
    AND NOT EXISTS (SELECT 1 FROM public.external_events e
                     WHERE e.id::text = lower(j.payload->>'eventId') AND e.business_id = j.business_id
                       AND (e.resolved_at IS NOT NULL OR e.processed_at IS NOT NULL))
    -- 0229: not while a failed candidate waits for its next attempt, and never once dead-lettered.
    AND NOT EXISTS (SELECT 1 FROM public.dead_job_enrolment_failures f
                     WHERE f.job_id = j.id
                       AND (f.dead_lettered_at IS NOT NULL OR f.next_attempt_at > now()))
    -- 0236: continue after the last candidate the previous pass saw (keyset), so candidates whose
    -- failure could not even be recorded do not hold the head of the page for ever. A cursor whose
    -- job has gone matches nothing, and the caller starts again from the beginning.
    AND (p_after IS NULL
         OR (j.updated_at, j.id) > (SELECT a.updated_at, a.id FROM public.jobs a WHERE a.id = p_after))
  ORDER BY j.updated_at, j.id
  LIMIT p_limit;
END $function$;

REVOKE ALL ON FUNCTION public.dead_job_unrecorded_candidates(integer, uuid)
  FROM PUBLIC, rekoda_app, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_unrecorded_candidates(integer, uuid) TO rekoda_worker;

CREATE OR REPLACE FUNCTION public.dead_job_unrecorded_candidates(p_limit integer)
RETURNS TABLE (job_id uuid, business_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.job_id, c.business_id FROM public.dead_job_unrecorded_candidates(p_limit, NULL::uuid) c
$$;
REVOKE ALL ON FUNCTION public.dead_job_unrecorded_candidates(integer)
  FROM PUBLIC, rekoda_app, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_unrecorded_candidates(integer) TO rekoda_worker;
