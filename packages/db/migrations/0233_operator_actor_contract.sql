-- Second independent review of PR #432 (R05, IMPORTANT): operator identities in 0229 follow the
-- shared operator-actor contract.
--
-- The contract (`apps/api/src/auth/operator-actor.ts`, `apps/api/src/operator-plane/authenticate.ts`
-- `auditActorOf`) records a verified operator as `operator:<subject>`, where the subject is 1 to 255
-- printable ASCII characters with no space (`^[!-~]{1,255}$`), so an actor is up to 264 characters.
-- 0207, 0208, 0213 and 0219 check exactly `^operator:[!-~]{1,255}$`. 0229 instead accepted any
-- non-blank actor of at most 200 characters, in `dead_job_enrolment_requeue` and in the
-- `requeued_by` column: a valid operator whose subject is 192 to 255 characters was refused
-- (HTTP 500 on the requeue route), and a malformed actor (`alice`, `operator:`, one with a space or
-- a newline) was accepted into the audit trail.
--
-- Since 0233 both follow the contract exactly. (The refund function, 0230, is aligned in 0235,
-- which re-creates it.) The remaining owner-run function `rekoda_private.set_pricing_source`
-- (0215) is called by the owner with a written actor, not by the operator plane, and keeps its own
-- rule; see the OD-41 row.
--
-- No rows exist outside test databases (PR #432 is not deployed); a row that does not meet the
-- contract would make the constraint fail to validate, which is the intended refusal.
-- Not a compatibility break. Re-running is safe.

ALTER TABLE dead_job_enrolment_failures
  DROP CONSTRAINT IF EXISTS dead_job_enrolment_failures_requeued_by_check;
ALTER TABLE dead_job_enrolment_failures
  DROP CONSTRAINT IF EXISTS dead_job_enrolment_failures_requeued_by_operator;
ALTER TABLE dead_job_enrolment_failures
  ADD CONSTRAINT dead_job_enrolment_failures_requeued_by_operator
  CHECK (requeued_by IS NULL OR requeued_by ~ '^operator:[!-~]{1,255}$');

CREATE OR REPLACE FUNCTION public.dead_job_enrolment_requeue(p_business uuid, p_job uuid, p_actor text, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_found boolean;
BEGIN
  IF p_business IS NULL OR p_job IS NULL OR p_actor IS NULL
     OR p_actor !~ '^operator:[!-~]{1,255}$' OR p_reason IS NULL OR length(btrim(p_reason)) < 4
     OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'dead_job_enrolment_requeue: an operator:<subject> actor and a reason of 4 to 500 characters are required'
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
END $function$;
