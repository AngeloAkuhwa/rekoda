-- OD-51.2 and OD-51.3 (owner instruction, 12 Nov 2026, PR #432): settlement is its own principal
-- in fact, not only in name, and the general worker cannot settle.
--
-- Until now `rekoda_settlement` (0202) was a member of `rekoda_app`, so its credential carried
-- every right of the application (read and write any tenant row it pins, the outbox included), and
-- it lived in the general worker process, the one that reads provider data, renders documents and
-- talks to Meta and the model providers. A compromise of that worker was a compromise of
-- settlement (OD-51 limits 2 and 3).
--
-- After this migration:
--
--   1. `rekoda_settlement` is no longer a member of `rekoda_app`. It holds exactly what settling a
--      charge needs, listed below table by table and column by column: read the charge, its
--      attempts, its event, the business and the price catalogue; record the payment on the charge;
--      write the cycle beside the provider plan writer; mark the event processed; credit a pack
--      through `usage_credit_pack`; write the audit row; and run its own two job kinds. Nothing
--      else: no customer, sale, invoice, ledger, document, message, session or outbox row.
--   2. It no longer opens a charge. The application opens pending charges (0209) and the renewal
--      sweep now does too, as the application; settlement only ever settles one that exists.
--   3. The queue is split by kind. `rekoda_settlement` sees and writes ONLY `billing.process` and
--      `billing.apply_no_charge` jobs (a restrictive policy: whatever tenant it pins, no other
--      job). `rekoda_worker` can no longer claim, complete, fail or requeue a live job of those two
--      kinds: it may only requeue a DEAD one (an operator's recovery) or record its death. So the
--      settlement jobs are run by the settlement process (`apps/api/src/settlement-main.ts`), on
--      its own credential, and by nothing else.
--   4. The grace clock is started through `subscription_start_grace` instead of a direct write of
--      `payment_failed_at` (a guarded cycle column, 0206, which only settlement and the operator
--      could write). That is what lets the renewal sweep run without the settlement credential.
--      The function can only START the clock (from empty, for an ended paid cycle that has a
--      renewal open, at a time from that cycle's end to now); it can never clear or move it.
--
-- The application's and the worker's own rights are otherwise unchanged.
--
-- Compatibility: BREAKING for the previous release (its worker settles on a credential that loses
-- the application's rights, and its renewal sweep writes `payment_failed_at` as settlement, which
-- still works, but its settlement jobs would be claimed by a worker the database now refuses).
-- Applied with the api and worker stopped; the new `settlement` service must be started with the
-- release (docs/runbooks/deploy.md). Rollback: none past 0196 (OWN-86). Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The grace clock: started through a function, by the application or the worker.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_start_grace(
  p_business uuid,
  p_failed_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_business IS NULL OR p_failed_at IS NULL THEN
    RAISE EXCEPTION 'subscription_start_grace: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_start_grace: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, payment_failed_at INTO b
  FROM public.businesses WHERE id = p_business FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_start_grace: no such business' USING ERRCODE = '42501';
  END IF;
  IF b.payment_failed_at IS NOT NULL THEN
    RETURN false; -- already running: the seven days count from the first failure
  END IF;
  IF b.plan NOT IN ('chat', 'integrate', 'complete') OR b.plan_expires_at IS NULL THEN
    RAISE EXCEPTION 'subscription_start_grace: only a paid plan with a renewal date has a grace clock'
      USING ERRCODE = '22023';
  END IF;
  -- The cycle it is for must have a renewal open: the sweep opens one only when the cycle is due.
  IF NOT EXISTS (
    SELECT 1 FROM public.subscription_charges c
    WHERE c.business_id = p_business AND c.kind = 'renewal' AND c.status = 'pending'
      AND c.superseded_at IS NULL
      AND date_trunc('milliseconds', c.period_start) = date_trunc('milliseconds', b.plan_expires_at)
  ) THEN
    RAISE EXCEPTION 'subscription_start_grace: no renewal is open for the cycle that ended'
      USING ERRCODE = '22023';
  END IF;
  -- From the cycle's end to now (the sweep's rule: the renewal date, floored at two days ago),
  -- never before the cycle ended and never in the future.
  IF p_failed_at < b.plan_expires_at - interval '1 second'
     OR p_failed_at > greatest(v_now, b.plan_expires_at) + interval '1 minute' THEN
    RAISE EXCEPTION 'subscription_start_grace: the grace clock starts between the end of the cycle and now'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET payment_failed_at = p_failed_at, updated_at = now()
  WHERE id = p_business;
  RETURN true;
END $$;

ALTER FUNCTION public.subscription_start_grace(uuid, timestamptz) OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_start_grace(uuid, timestamptz)
  FROM PUBLIC, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.subscription_start_grace(uuid, timestamptz)
  TO rekoda_app, rekoda_worker;

-- ---------------------------------------------------------------------------------------------
-- 2. Settlement stops acting with the application's rights.
-- ---------------------------------------------------------------------------------------------
REVOKE rekoda_app FROM rekoda_settlement;

-- Whatever was granted to it directly (0202: INSERT on charges, add-on holdings) goes too; the
-- exact set is granted back below.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rekoda_settlement;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rekoda_settlement;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT table_name, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE grantee = 'rekoda_settlement' AND table_schema = 'public'
  LOOP
    EXECUTE format('REVOKE %s (%I) ON public.%I FROM rekoda_settlement',
      r.privilege_type, r.column_name, r.table_name);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM rekoda_settlement;

GRANT USAGE ON SCHEMA public TO rekoda_settlement;

-- What a settlement reads.
GRANT SELECT ON
  businesses, subscription_charges, subscription_charge_attempts, external_events,
  plan_versions, plan_prices, usage_packs, add_ons, add_on_grants, business_add_ons,
  billing_pricing_source, jobs, dead_job_exceptions
  TO rekoda_settlement;

-- The charge: the payment, the period it bought and what became of it. Never what it was opened
-- to buy (frozen by the guard), never its credit time (usage_credit_pack), never a new row.
GRANT UPDATE (status, provider_reference, failure_reason, paid_amount_k, paid_at, provider_paid_at,
              provider_settled_at, failed_at, applied_period_start, applied_period_end,
              superseded_at, abandoned_at, unapplied_at, unapplied_reason, updated_at)
  ON subscription_charges TO rekoda_settlement;
-- Which checkout session paid, and which were left behind.
GRANT UPDATE (status, updated_at) ON subscription_charge_attempts TO rekoda_settlement;
-- The cycle written beside the provider plan writer (plan and plan_expires_at are the writer's).
GRANT UPDATE (plan_version_id, cycle_started_at, renewal_anchor_day, pending_plan,
              billing_interval, pending_billing_interval, subscription_origin, payment_failed_at,
              last_grace_reminder_day, ever_paid_at, plan_decided_at, plan_decided_before_pending,
              updated_at)
  ON businesses TO rekoda_settlement;
-- The provider event the job was raised for: processed, with its outcome.
GRANT UPDATE (processed_at, error) ON external_events TO rekoda_settlement;
-- An add-on holding is a sold entitlement, recorded by settlement alone since 0202 (no production
-- path sells one yet; the right stays where that migration put it).
GRANT INSERT, UPDATE ON business_add_ons TO rekoda_settlement;
-- The audit row of a zero-priced upgrade that failed, and of a job that died.
GRANT INSERT ON audit_events TO rekoda_settlement;
-- Its own jobs: claim, renew, complete, defer, fail, reclaim (never kind, payload or business).
GRANT UPDATE (state, attempts, locked_at, locked_by, run_at, last_error, failure_category, updated_at)
  ON jobs TO rekoda_settlement;
-- A settlement job that died leaves its record, exactly as the worker's do (0194).
GRANT INSERT ON dead_job_exceptions TO rekoda_settlement;
GRANT UPDATE (status, death_count, last_died_at, attempts, failure_category, updated_at)
  ON dead_job_exceptions TO rekoda_settlement;
-- A recovery an operator requested, finished by the job that ran: the record is closed in the same
-- transaction that completes the job. The general runner does this on the application credential;
-- the settlement process has only its own, and closes only the records of the jobs it can see.
GRANT UPDATE (closed_at, closed_by, resolution) ON dead_job_exceptions TO rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.dead_job_has_record(uuid) TO rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.dead_job_is_recovering(uuid) TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- 3. The queue, split by kind.
-- ---------------------------------------------------------------------------------------------
-- Settlement reaches its own two kinds across tenants (it must read a job before it can pin its
-- tenant, exactly as the worker's claim does), and NOTHING else, whatever tenant it pins.
DROP POLICY IF EXISTS settlement_claim ON jobs;
CREATE POLICY settlement_claim ON jobs FOR ALL TO rekoda_settlement
  USING (kind IN ('billing.process', 'billing.apply_no_charge'))
  WITH CHECK (kind IN ('billing.process', 'billing.apply_no_charge'));
DROP POLICY IF EXISTS settlement_only_its_kinds ON jobs;
CREATE POLICY settlement_only_its_kinds ON jobs AS RESTRICTIVE FOR ALL TO rekoda_settlement
  USING (kind IN ('billing.process', 'billing.apply_no_charge'))
  WITH CHECK (kind IN ('billing.process', 'billing.apply_no_charge'));

-- The worker: a settlement job is not its to claim, renew, complete, fail or reclaim. It may only
-- touch one that is already DEAD (an operator's recovery requeues it; the enrolment pass locks
-- it), and may leave it dead or pending.
DROP POLICY IF EXISTS worker_leaves_settlement_jobs ON jobs;
CREATE POLICY worker_leaves_settlement_jobs ON jobs AS RESTRICTIVE FOR UPDATE TO rekoda_worker
  USING (kind NOT IN ('billing.process', 'billing.apply_no_charge') OR state = 'dead')
  WITH CHECK (kind NOT IN ('billing.process', 'billing.apply_no_charge')
              OR state IN ('dead', 'pending'));

-- ---------------------------------------------------------------------------------------------
-- 4. Membership: settlement is nobody else, and nobody else is settlement.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  offender text;
BEGIN
  SELECT format('%s is a member of %s', m.member, m.target) INTO offender
  FROM (VALUES
          ('rekoda_settlement', 'rekoda_app'), ('rekoda_settlement', 'rekoda_worker'),
          ('rekoda_settlement', 'rekoda_billing_operator'), ('rekoda_settlement', 'rekoda_plan_writer'),
          ('rekoda_settlement', 'rekoda_usage_writer'),
          ('rekoda_app', 'rekoda_settlement'), ('rekoda_worker', 'rekoda_settlement'),
          ('rekoda_billing_operator', 'rekoda_settlement')) AS m(member, target)
  WHERE pg_has_role(m.member, m.target, 'MEMBER')
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0217: % ; revoke the membership first', offender
      USING ERRCODE = '42501';
  END IF;
END $$;
