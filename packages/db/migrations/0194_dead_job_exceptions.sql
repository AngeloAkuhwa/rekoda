-- OWN-73 and OWN-76 (PR B items 2 and 3): a payment or billing job that dies leaves a record.
--
-- When a `payment.process` or `billing.process` job reaches `dead` (its handler failed on the
-- last attempt, `jobsRepo.markFailed`, or its worker kept dying, `jobsRepo.reclaimStalled`),
-- the same transaction writes one row here, keyed on the job. It is the operations work item
-- (listed only to authorised operators) and the anchor for the merchant's view: a reconciliation
-- exception for a payment job, a billing notice for a billing job (never the merchant's
-- reconciliation, OWN-76). A job's later death after an operator's recovery reopens the SAME row.
--
-- What the row never holds: the job's error text, the event payload, a credential, a provider
-- response. `summary` is fixed text per kind; `failure_category` is the job's sanitised category
-- (migration 0190). `reference` and `recovery_reference` are Rekoda's own payment references
-- (the latter the one an operator's recovery verified with Paystack), not personal data.
--
-- Nothing is booked by this table or by the code that writes it: no payment, intent, invoice,
-- ledger row, charge or plan changes when a job dies.
--
-- Rollback: a normal release rollback (docs/runbooks/deploy.md) keeps this table; the older code
-- ignores it. Its rows are the only record of which payment jobs died, so a manual rollback does
-- not drop it.

CREATE TABLE IF NOT EXISTS dead_job_exceptions (
  job_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('payment.process', 'billing.process')),
  -- The job payload's `eventId` when it named a valid one; null for a job that had none.
  event_id uuid,
  -- Rekoda's own payment or subscription reference from the job payload (RKD-PAY-..., RKD-SUB-...,
  -- RKD-PACK-...), when the payload carried one in that shape; null for older jobs. Shown to the
  -- operator; a recovery still verifies the reference read from the signed event, never this one.
  reference text CHECK (reference IS NULL OR reference ~ '^RKD-(PAY|SUB|PACK)-[0-9]{8}-[0-9A-Z]{6}(-R[0-9]{1,2})?$'),
  -- open: waiting for an operator. recovering: an operator verified the reference with Paystack
  -- and requeued one bounded attempt. recovered: that attempt finished. resolved: an operator
  -- closed it without a recovery.
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'recovering', 'recovered', 'resolved')),
  failure_category text
    CHECK (failure_category IS NULL
           OR failure_category IN ('handler_error', 'lease_expired', 'lease_expired_after_handler_error')),
  summary text NOT NULL,
  attempts integer NOT NULL,
  death_count integer NOT NULL DEFAULT 1 CHECK (death_count >= 1),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_died_at timestamptz NOT NULL DEFAULT now(),
  recovery_requested_at timestamptz,
  recovery_requested_by text,
  recovery_reason text,
  recovery_reference text,
  -- A sanitised summary of what Paystack's verify said (found, status), never its response.
  recovery_verification text,
  closed_at timestamptz,
  closed_by text,
  resolution text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dead_job_exceptions_open_ix
  ON dead_job_exceptions (opened_at) WHERE status IN ('open', 'recovering');
CREATE INDEX IF NOT EXISTS dead_job_exceptions_event_ix
  ON dead_job_exceptions (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dead_job_exceptions_business_ix
  ON dead_job_exceptions (business_id, status);

ALTER TABLE dead_job_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_job_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dead_job_exceptions
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The operations queue spans tenants by nature (owner ruling OD-47, ADR 0035 Amendment 2), but the
-- table itself does NOT: there is no cross-tenant policy on it. An operator discovers dead jobs
-- only through the SECURITY DEFINER functions below, each returning a fixed set of
-- operational columns (never the job's payload, an error, a phone, a name or a credential),
-- bounded in size, with EXECUTE granted to rekoda_worker alone. Reading a row here never
-- authorises changing it: every mutation runs under the business's own pin
-- (`withBusiness()`) and its own operator scope.

-- The open and recovering dead jobs, oldest first, with the current payment and plan state
-- (OWN-76). `p_job_ids` narrows to exactly those jobs; `p_eventless` keeps the records that have
-- no event. At most 200 rows.
CREATE OR REPLACE FUNCTION dead_job_ops_queue(
  p_limit integer,
  p_job_ids uuid[],
  p_eventless boolean
) RETURNS TABLE (
  job_id uuid,
  business_id uuid,
  kind text,
  event_id uuid,
  reference text,
  status text,
  failure_category text,
  summary text,
  attempts integer,
  death_count integer,
  opened_at timestamptz,
  last_died_at timestamptz,
  recovery_requested_at timestamptz,
  recovery_reference text,
  payment_state text,
  current_plan text,
  current_plan_expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.job_id, d.business_id, d.kind, d.event_id, d.reference, d.status,
         d.failure_category, d.summary, d.attempts, d.death_count, d.opened_at,
         d.last_died_at, d.recovery_requested_at, d.recovery_reference,
         CASE WHEN d.kind = 'billing.process' THEN
                (SELECT c.status FROM public.subscription_charges c
                  WHERE c.business_id = d.business_id
                    AND c.reference = regexp_replace(d.reference, '-R[0-9]+$', ''))
              ELSE
                (SELECT i.status FROM public.payment_intents i
                  WHERE i.business_id = d.business_id AND i.reference = d.reference)
         END,
         CASE WHEN d.kind = 'billing.process' THEN b.plan::text END,
         CASE WHEN d.kind = 'billing.process' THEN b.plan_expires_at END
  FROM public.dead_job_exceptions d
  JOIN public.businesses b ON b.id = d.business_id
  WHERE d.status IN ('open', 'recovering')
    AND (p_job_ids IS NULL OR d.job_id = ANY(p_job_ids))
    AND (NOT p_eventless OR d.event_id IS NULL)
  ORDER BY d.opened_at, d.job_id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- The open (or recovering) dead job bound to one event, by event id (and, when given, the
-- event's own business): the job id only.
CREATE OR REPLACE FUNCTION dead_job_open_for_event(p_event_id uuid, p_business_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.job_id FROM public.dead_job_exceptions d
  WHERE d.event_id = p_event_id AND d.status IN ('open', 'recovering')
    AND (p_business_id IS NULL OR d.business_id = p_business_id)
  ORDER BY d.opened_at DESC
  LIMIT 1
$$;

-- Two yes/no answers the worker's cross-tenant passes need (the job reclaim and the enrolment of
-- jobs that died before this table existed): is this job's record being recovered, and does a
-- record exist for it at all. Booleans only.
CREATE OR REPLACE FUNCTION dead_job_is_recovering(p_job_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.dead_job_exceptions d
                  WHERE d.job_id = p_job_id AND d.status = 'recovering')
$$;

CREATE OR REPLACE FUNCTION dead_job_has_record(p_job_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.dead_job_exceptions d WHERE d.job_id = p_job_id)
$$;

-- One record by job id for the operator routes: the record's own columns, nothing joined.
CREATE OR REPLACE FUNCTION dead_job_find_for_ops(p_job_id uuid) RETURNS TABLE (
  job_id uuid,
  business_id uuid,
  kind text,
  event_id uuid,
  reference text,
  status text,
  failure_category text,
  summary text,
  attempts integer,
  death_count integer,
  opened_at timestamptz,
  last_died_at timestamptz,
  recovery_requested_at timestamptz,
  recovery_reference text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.job_id, d.business_id, d.kind, d.event_id, d.reference, d.status,
         d.failure_category, d.summary, d.attempts, d.death_count, d.opened_at,
         d.last_died_at, d.recovery_requested_at, d.recovery_reference
  FROM public.dead_job_exceptions d
  WHERE d.job_id = p_job_id
$$;

REVOKE ALL ON FUNCTION dead_job_ops_queue(integer, uuid[], boolean) FROM PUBLIC, rekoda_app;
REVOKE ALL ON FUNCTION dead_job_open_for_event(uuid, uuid) FROM PUBLIC, rekoda_app;
REVOKE ALL ON FUNCTION dead_job_is_recovering(uuid) FROM PUBLIC, rekoda_app;
REVOKE ALL ON FUNCTION dead_job_has_record(uuid) FROM PUBLIC, rekoda_app;
REVOKE ALL ON FUNCTION dead_job_find_for_ops(uuid) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION dead_job_ops_queue(integer, uuid[], boolean) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION dead_job_open_for_event(uuid, uuid) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION dead_job_is_recovering(uuid) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION dead_job_has_record(uuid) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION dead_job_find_for_ops(uuid) TO rekoda_worker;

-- The worker writes the row at the job's death (under the job's tenant pin); the application
-- role moves it through recovery (under the tenant pin). Nobody deletes a row; retention removes
-- a whole tenant through its own definer function.
REVOKE ALL ON dead_job_exceptions FROM rekoda_app, rekoda_worker;
GRANT SELECT, INSERT ON dead_job_exceptions TO rekoda_worker;
GRANT UPDATE (status, failure_category, attempts, death_count, last_died_at, updated_at)
  ON dead_job_exceptions TO rekoda_worker;
GRANT SELECT ON dead_job_exceptions TO rekoda_app;
GRANT UPDATE (status, recovery_requested_at, recovery_requested_by, recovery_reason,
              recovery_reference, recovery_verification, closed_at, closed_by, resolution,
              updated_at)
  ON dead_job_exceptions TO rekoda_app;
