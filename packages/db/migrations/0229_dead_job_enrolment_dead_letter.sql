-- Final remediation of PR #432 (owner brief, 15 Nov 2026: implement dead-letter handling for poison
-- enrolment candidates).
--
-- The cutover enrolment (`jobsRepo.enrolUnrecordedDeaths`, 0225) pages its candidates by
-- `updated_at, id`, at most 100 a pass. A candidate whose record can never be written (a poison
-- candidate) stayed first in that order for ever, so 100 or more of them kept every later candidate
-- from being reached (independent review MINOR (xx)). Since 0229 every failure is recorded against
-- its job, retried with backoff, and dead-lettered once its attempts are spent:
--
--   * `dead_job_enrolment_failures`: one row per failing candidate, tenant-scoped (FORCE RLS, the
--     canonical tenant policy). It records the attempt count, the time and SQLSTATE of the last
--     failure (a five-character code, never an error message, which may quote a row), when the next
--     attempt is due, when it was dead-lettered, and every operator requeue (who, why, how often).
--   * The retry policy, defined here and nowhere else (engineering policy, recorded in
--     docs/REKODA_LAUNCH_READINESS.md OD-41 (xx); no owner ruling sets these numbers):
--       ENROLMENT_MAX_ATTEMPTS = 5; after failure n (1 to 4) the next attempt is due
--       5 minutes x 2^(n-1) later (5, 10, 20, 40 minutes); the fifth failure dead-letters it.
--   * `dead_job_enrolment_failed(business, job, sqlstate)`: the worker records a failure under the
--     job's own tenant pin; the function applies the policy. Worker only.
--   * `dead_job_unrecorded_candidates` (0225) skips a candidate whose next attempt is not due yet or
--     that is dead-lettered, so poison candidates leave the page and healthy ones are reached.
--   * `dead_job_enrolment_dead_letters(page_size, job)`: the operator work list (ADR 0035
--     Amendment 2 shape, recorded in Amendment 6): worker-only, read-only, fixed columns, 1 to 200
--     rows, optionally one job.
--   * `dead_job_enrolment_requeue(business, job, actor, reason)`: an operator requeue, under the
--     job's own business pin, for a dead-lettered candidate only. It resets the attempts, records
--     who and why, and writes an audit event; a second call finds nothing dead-lettered and changes
--     nothing. Requeueing never duplicates a record: enrolment is insert-only per job and skips a
--     job that already has one (0225).
--
-- Compatibility: additive (one table, four functions, one function replaced with the same
-- signature, result and grants). The previous release never calls any of them. Not
-- compatibility-breaking. Rollback: drop the four functions and the table, re-run 0225's function.

CREATE TABLE IF NOT EXISTS dead_job_enrolment_failures (
  job_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 5),
  last_sqlstate char(5) CHECK (last_sqlstate IS NULL OR last_sqlstate ~ '^[0-9A-Z]{5}$'),
  last_failed_at timestamptz,
  next_attempt_at timestamptz,
  dead_lettered_at timestamptz,
  requeue_count integer NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  requeued_at timestamptz,
  requeued_by text CHECK (requeued_by IS NULL OR length(requeued_by) BETWEEN 1 AND 200),
  requeue_reason text CHECK (requeue_reason IS NULL OR length(requeue_reason) BETWEEN 4 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dead_job_enrolment_failures_dead_ix
  ON dead_job_enrolment_failures (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;

ALTER TABLE dead_job_enrolment_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_job_enrolment_failures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dead_job_enrolment_failures;
CREATE POLICY tenant_isolation ON dead_job_enrolment_failures
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- Written only through the functions below; a business-scoped reader may see its own rows.
REVOKE ALL ON dead_job_enrolment_failures FROM PUBLIC, rekoda_app, rekoda_worker,
  rekoda_settlement, rekoda_billing_operator;
GRANT SELECT ON dead_job_enrolment_failures TO rekoda_app;

CREATE OR REPLACE FUNCTION public.dead_job_enrolment_failed(
  p_business uuid,
  p_job uuid,
  p_sqlstate text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  IF p_business IS NULL OR p_job IS NULL THEN
    RAISE EXCEPTION 'dead_job_enrolment_failed: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'dead_job_enrolment_failed: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  -- Only a real candidate of this business: a dead payment or billing job with no record.
  IF NOT EXISTS (SELECT 1 FROM public.jobs j
                 WHERE j.id = p_job AND j.business_id = p_business AND j.state = 'dead'
                   AND j.kind IN ('payment.process', 'billing.process'))
     OR EXISTS (SELECT 1 FROM public.dead_job_exceptions d WHERE d.job_id = p_job) THEN
    RETURN;
  END IF;
  INSERT INTO public.dead_job_enrolment_failures AS f (job_id, business_id, attempts)
  VALUES (p_job, p_business, 0)
  ON CONFLICT (job_id) DO NOTHING;
  SELECT attempts + 1 INTO v_attempts FROM public.dead_job_enrolment_failures
  WHERE job_id = p_job FOR UPDATE;
  IF v_attempts > 5 THEN
    RETURN; -- dead-lettered already: nothing more to count
  END IF;
  UPDATE public.dead_job_enrolment_failures SET
    attempts = v_attempts,
    last_sqlstate = CASE WHEN p_sqlstate ~ '^[0-9A-Z]{5}$' THEN p_sqlstate END,
    last_failed_at = now(),
    next_attempt_at = CASE WHEN v_attempts < 5
                           THEN now() + make_interval(mins => 5 * (2 ^ (v_attempts - 1))::integer) END,
    dead_lettered_at = CASE WHEN v_attempts >= 5 THEN now() END,
    updated_at = now()
  WHERE job_id = p_job;
END $$;
REVOKE ALL ON FUNCTION public.dead_job_enrolment_failed(uuid, uuid, text)
  FROM PUBLIC, rekoda_app, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_enrolment_failed(uuid, uuid, text) TO rekoda_worker;

-- 0225's discovery, now skipping a candidate in backoff or dead-lettered.
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
    AND NOT EXISTS (SELECT 1 FROM public.external_events e
                     WHERE e.id::text = lower(j.payload->>'eventId') AND e.business_id = j.business_id
                       AND (e.resolved_at IS NOT NULL OR e.processed_at IS NOT NULL))
    -- 0229: not while a failed candidate waits for its next attempt, and never once dead-lettered.
    AND NOT EXISTS (SELECT 1 FROM public.dead_job_enrolment_failures f
                     WHERE f.job_id = j.id
                       AND (f.dead_lettered_at IS NOT NULL OR f.next_attempt_at > now()))
  ORDER BY j.updated_at, j.id
  LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION public.dead_job_enrolment_dead_letters(p_limit integer, p_job uuid DEFAULT NULL)
RETURNS TABLE (job_id uuid, business_id uuid, kind text, attempts integer, last_sqlstate text,
               last_failed_at timestamptz, dead_lettered_at timestamptz, requeue_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'dead_job_enrolment_dead_letters: the page size is 1 to 200'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT f.job_id, f.business_id, j.kind, f.attempts, f.last_sqlstate::text, f.last_failed_at,
         f.dead_lettered_at, f.requeue_count
  FROM public.dead_job_enrolment_failures f
  JOIN public.jobs j ON j.id = f.job_id
  WHERE f.dead_lettered_at IS NOT NULL AND (p_job IS NULL OR f.job_id = p_job)
  ORDER BY f.dead_lettered_at, f.job_id
  LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.dead_job_enrolment_dead_letters(integer, uuid)
  FROM PUBLIC, rekoda_app, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_enrolment_dead_letters(integer, uuid) TO rekoda_worker;

CREATE OR REPLACE FUNCTION public.dead_job_enrolment_requeue(
  p_business uuid,
  p_job uuid,
  p_actor text,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_found boolean;
BEGIN
  IF p_business IS NULL OR p_job IS NULL OR p_actor IS NULL OR length(btrim(p_actor)) < 1
     OR length(p_actor) > 200 OR p_reason IS NULL OR length(btrim(p_reason)) < 4
     OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'dead_job_enrolment_requeue: an actor and a reason of 4 to 500 characters are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'dead_job_enrolment_requeue: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.dead_job_enrolment_failures SET
    attempts = 0,
    next_attempt_at = NULL,
    dead_lettered_at = NULL,
    requeue_count = requeue_count + 1,
    requeued_at = now(),
    requeued_by = p_actor,
    requeue_reason = btrim(p_reason),
    updated_at = now()
  WHERE job_id = p_job AND business_id = p_business AND dead_lettered_at IS NOT NULL;
  v_found := FOUND;
  IF v_found THEN
    INSERT INTO public.audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (p_business, p_actor, 'dead_job_enrolment', p_job::text, 'enrolment_requeued',
            jsonb_build_object('reason', btrim(p_reason)), 'operator');
  END IF;
  RETURN v_found;
END $$;
REVOKE ALL ON FUNCTION public.dead_job_enrolment_requeue(uuid, uuid, text, text)
  FROM PUBLIC, rekoda_worker, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.dead_job_enrolment_requeue(uuid, uuid, text, text) TO rekoda_app;
