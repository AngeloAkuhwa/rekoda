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
-- (migration 0190). `recovery_reference` is the Paystack reference an operator's recovery
-- verified, which is a payment reference, not personal data.
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

-- The operations queue spans tenants by nature, exactly as the event exception queue and the
-- unapplied-charge queue do: the worker credential reads every row (an id-and-category work
-- list, no payload), and only through an `ops:read` operator route.
CREATE POLICY ops_read_dead_job_exceptions ON dead_job_exceptions
  FOR SELECT TO rekoda_worker USING (true);

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
