-- OD-51 and the worker-privilege assessment (owner instruction, 11 Nov 2026, PR #432 closeout):
-- the worker credential keeps only the writes its jobs make, and four application-credential
-- exposures found in the same review are closed.
--
-- The worker (`rekoda_worker`, ADR 0022) was given SELECT, INSERT, UPDATE and DELETE on every table,
-- and on every future table, in 0004. Because tenant isolation keys on the caller-settable
-- `app.business_id`, a holder of that credential could write almost any tenant row: sessions and
-- users (account takeover), the migration ledger (a security migration silently skipped), the
-- merchant's books, paid entitlements and other businesses' jobs. Its jobs actually write very
-- little: the job queue, the outbox and webhook deliveries, object-deletion bookkeeping, stranger
-- replies, webhook-delivery metering, the dead-job records with their audit row and merchant
-- exception, and two columns of an external event. Job HANDLERS run on the application or
-- settlement pool, never on this one. This migration:
--
--   1. Revokes every table- and column-level INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
--      TRIGGER the worker holds in `public`, and the default privileges that would hand it the next
--      table, then grants back exactly the writes its jobs make (listed below). SELECT is kept: the
--      sweeps are cross-tenant discovery by design (OWN-57).
--   2. External events: the worker may mark an UNATTRIBUTED event processed once (with a reason for a
--      Paystack event, so an unmatched payment stays in the operators' flagged list rather than
--      disappearing), and on an ATTRIBUTED event it may only add the dead-job flag (`error` from
--      none to a value, `processed_at` left empty). It can no longer mark another business's payment
--      event processed, clear its flag or reopen an event.
--   3. `retention_delete_business` no longer trusts the caller's cutoff: the deletion only happens
--      when the business ended at least 90 days ago and was warned at least 30 days ago (core
--      `RETENTION`), whatever cutoff is passed. `retention_notified_at` can no longer be backdated
--      by a runtime role, so a warning cannot be faked into the past to shorten the notice period.
--   4. The migration ledger (`rekoda_migrations`) is read-only to every runtime role: a holder of a
--      runtime credential could have pre-recorded a future migration so it would never run.
--   5. Explicit entitlement grants (`business_entitlements`) are written by no application code
--      (they are an owner and migration act); a runtime credential could have inserted a paid
--      capability. INSERT, UPDATE and DELETE are revoked from every runtime role.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The worker's writes: only what its jobs make.
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA rekoda_private FROM rekoda_worker;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT table_schema, table_name, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE grantee = 'rekoda_worker' AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
      AND table_schema IN ('public', 'rekoda_private')
  LOOP
    EXECUTE format('REVOKE %s (%I) ON %I.%I FROM rekoda_worker',
      r.privilege_type, r.column_name, r.table_schema, r.table_name);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM rekoda_worker;

-- The queue: claim, touch, defer, fail, reclaim and record a death (no insert, no delete).
GRANT UPDATE ON jobs TO rekoda_worker;
-- The outbox claim and its webhook fan-out.
GRANT UPDATE ON outbox_events TO rekoda_worker;
GRANT INSERT, UPDATE ON webhook_deliveries TO rekoda_worker;
GRANT UPDATE (consecutive_failures, last_success_at, updated_at) ON webhook_endpoints TO rekoda_worker;
-- Object-store deletion bookkeeping (the retention sweep's second pass).
GRANT UPDATE, DELETE ON pending_object_deletions TO rekoda_worker;
-- The stranger reply throttle.
GRANT INSERT, UPDATE ON stranger_contacts TO rekoda_worker;
-- Webhook-delivery metering and the release of a dead job's reserved meters.
GRANT INSERT, UPDATE ON usage_counters TO rekoda_worker;
-- A dead job's record (OWN-73, OWN-76), its audit row and its merchant exception.
GRANT INSERT ON dead_job_exceptions TO rekoda_worker;
GRANT UPDATE (status, death_count, last_died_at, attempts, failure_category, updated_at)
  ON dead_job_exceptions TO rekoda_worker;
GRANT INSERT ON audit_events TO rekoda_worker;
GRANT INSERT ON reconciliations TO rekoda_worker;
-- External events: the two columns, narrowed further by the trigger below (0204 kept SELECT).
GRANT UPDATE (processed_at, error) ON external_events TO rekoda_worker;

-- ---------------------------------------------------------------------------------------------
-- 2. What the worker may do to an external event.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.external_events_worker_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user <> 'rekoda_worker' THEN
    RETURN NEW;
  END IF;
  IF NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at
     AND NEW.error IS NOT DISTINCT FROM OLD.error THEN
    RETURN NEW;  -- a no-op (the dead-job flag is COALESCEd onto an already-flagged event)
  END IF;
  IF OLD.business_id IS NOT NULL THEN
    -- Attributed: only the dead-job flag, on an event nobody has processed or resolved.
    IF OLD.processed_at IS NULL AND NEW.processed_at IS NULL AND OLD.resolved_at IS NULL
       AND OLD.error IS NULL AND NEW.error IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the worker may only flag an attributed event, never process, clear or reopen it (OD-51)'
      USING ERRCODE = '42501';
  END IF;
  -- Unattributed: processed once, never reopened; a Paystack event only with a reason.
  IF OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL
     AND (OLD.provider IS DISTINCT FROM 'paystack' OR NEW.error IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the worker marks an unattributed event processed once, with a reason for a payment event (OD-51)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.external_events_worker_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS external_events_worker_guard ON external_events;
CREATE TRIGGER external_events_worker_guard
  BEFORE UPDATE OF processed_at, error ON external_events
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.external_events_worker_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. Retention: the policy is the function's, not the caller's.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.retention_delete_business_unchecked(uuid,timestamptz)') IS NULL THEN
    ALTER FUNCTION public.retention_delete_business(uuid, timestamptz)
      RENAME TO retention_delete_business_unchecked;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.retention_delete_business_unchecked(uuid, timestamptz)
  FROM PUBLIC, rekoda_app, rekoda_worker;

CREATE OR REPLACE FUNCTION public.retention_delete_business(
  target uuid,
  cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- core RETENTION (packages/core/src/retention.ts): abandonedTrialDays 90, noticeDays 30.
  v_ended_by timestamptz := now() - interval '90 days';
  v_warned_by timestamptz := now() - interval '30 days';
  v_warned boolean;
BEGIN
  SELECT (b.retention_notified_at IS NOT NULL AND b.retention_notified_at <= v_warned_by)
    INTO v_warned
  FROM public.businesses b WHERE b.id = target;
  IF v_warned IS NOT TRUE THEN
    RETURN -1;
  END IF;
  RETURN public.retention_delete_business_unchecked(target, least(cutoff, v_ended_by));
END $$;

REVOKE ALL ON FUNCTION public.retention_delete_business(uuid, timestamptz) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION public.retention_delete_business(uuid, timestamptz) TO rekoda_worker;

CREATE OR REPLACE FUNCTION rekoda_private.businesses_retention_notice_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  -- Cleared (a merchant who came back) or stamped now; never a time in the past.
  IF NEW.retention_notified_at IS NULL
     OR NEW.retention_notified_at >= clock_timestamp() - interval '1 minute' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a retention notice is recorded when it is sent, never backdated (OD-51)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.businesses_retention_notice_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_retention_notice_guard ON businesses;
CREATE TRIGGER businesses_retention_notice_guard
  BEFORE UPDATE OF retention_notified_at ON businesses
  FOR EACH ROW
  WHEN (OLD.retention_notified_at IS DISTINCT FROM NEW.retention_notified_at)
  EXECUTE FUNCTION rekoda_private.businesses_retention_notice_guard();

-- ---------------------------------------------------------------------------------------------
-- 4 and 5. The migration ledger and explicit entitlement grants: no runtime role writes them.
-- ---------------------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON rekoda_migrations FROM rekoda_app, rekoda_worker;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON business_entitlements FROM rekoda_app, rekoda_worker;
