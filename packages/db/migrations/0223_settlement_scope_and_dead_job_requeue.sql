-- Independent review of PR #432 at `75a8002` (13 Nov 2026): settlement reaches only what its own
-- jobs name, and every application requeue of a dead job is bounded.
--
-- 0217 took settlement out of the application role and granted it, table by table, what settling
-- needs. Two of those grants were bounded only by the tenant pin, which any session sets:
--
--   * SELECT and UPDATE (processed_at, error) on `external_events`. The settlement process holds the
--     vault key that opens sealed webhook payloads, so a compromised settlement credential (the
--     threat OD-51.2 and OD-51.3 contain) could pin any business and read its WhatsApp message
--     events and its customers' Paystack events, and mark them processed, silently dropping an
--     inbound message or a customer payment before its pump ran. Settling reads exactly one event:
--     the Paystack event its own `billing.process` job names (`events.eventForBusiness`,
--     `events.markProcessed`, `deadJobs.recordDeath`).
--   * INSERT and UPDATE on `dead_job_exceptions`. Settlement could close the record of a merchant's
--     customer-payment job, or insert a closed one ahead of its death so `recordDeath`'s
--     `ON CONFLICT DO NOTHING` wrote no merchant exception and no operator item. Settlement's jobs
--     that die are `billing.process`.
--
-- And the application's job guard (0222) bounded the dead-to-pending requeue only for settlement's
-- kinds, and let it enqueue a settlement job with any retry budget.
--
-- After this migration:
--
--   1. A RESTRICTIVE policy: settlement sees and updates a Paystack event only when a
--      `billing.process` job of the same business names it (`payload.eventId`).
--   2. A RESTRICTIVE policy: settlement reads and writes only `billing.process` dead-job records.
--   3. The job guard: a settlement job is enqueued with at least the default five attempts, and an
--      application requeue of ANY dead job is due now with exactly one more attempt (the one honest
--      requeue, `deadJobsRepo.beginRecovery`, already writes exactly that).
--
-- Grants are unchanged (the deploy smoke's exact grant lists still hold). Nothing is rewritten.
-- Not a compatibility break: it only narrows the settlement process, which this release introduces,
-- and an application write no release makes. It ships in the same stopped window as 0216 to 0222.
-- Re-running is safe on its own, but re-running an EARLIER migration (0202, 0216, 0217, 0222) after
-- it would restore that migration's weaker definitions: the runner applies each file once.

-- ---------------------------------------------------------------------------------------------
-- 1. Settlement's events: only the ones its jobs name.
-- ---------------------------------------------------------------------------------------------
-- For the policy's lookup: a business's settlement jobs (the eventId is checked as a filter, since
-- `->>` is not leakproof under the jobs table's row-level security).
CREATE INDEX IF NOT EXISTS jobs_billing_event_ix
  ON jobs (business_id, (payload ->> 'eventId')) WHERE kind = 'billing.process';

DROP POLICY IF EXISTS settlement_only_its_events ON external_events;
CREATE POLICY settlement_only_its_events ON external_events AS RESTRICTIVE FOR ALL
  TO rekoda_settlement
  USING (provider = 'paystack'
         AND EXISTS (SELECT 1 FROM public.jobs j
                      WHERE j.kind = 'billing.process'
                        AND j.business_id = external_events.business_id
                        AND j.payload ->> 'eventId' = external_events.id::text))
  WITH CHECK (provider = 'paystack'
              AND EXISTS (SELECT 1 FROM public.jobs j
                           WHERE j.kind = 'billing.process'
                             AND j.business_id = external_events.business_id
                             AND j.payload ->> 'eventId' = external_events.id::text));

-- ---------------------------------------------------------------------------------------------
-- 2. Settlement's dead-job records: only its own kind.
-- ---------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS settlement_only_its_dead_jobs ON dead_job_exceptions;
CREATE POLICY settlement_only_its_dead_jobs ON dead_job_exceptions AS RESTRICTIVE FOR ALL
  TO rekoda_settlement
  USING (kind = 'billing.process')
  WITH CHECK (kind = 'billing.process');

-- ---------------------------------------------------------------------------------------------
-- 3. The application's job guard.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.jobs_application_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Any role holding rekoda_app's privileges (rekoda_app itself, or a login role that inherits it),
  -- except the table owner (migrations, the integration harness). Matching the role NAME let an
  -- inheriting login skip the guard (review of `ece0e14`, residual 11).
  IF NOT pg_has_role(current_user, 'rekoda_app', 'USAGE')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  -- Settlement's jobs (0217): the application enqueues them (the Paystack pump, a no-charge upgrade)
  -- and an operator may requeue a dead one, but only settlement runs, completes or reschedules them.
  -- A holder of the application credential could otherwise withhold a verified payment by marking
  -- its job done, by pushing its run time out, or by enqueueing it already finished (review, 0222).
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind IN ('billing.process', 'billing.apply_no_charge')
       AND (NEW.state IS DISTINCT FROM 'pending' OR NEW.locked_by IS NOT NULL
            OR NEW.locked_at IS NOT NULL OR NEW.attempts <> 0
            OR NEW.run_at > now() + interval '1 minute'
            -- With a cut retry budget the first transient verify failure would kill the job, and
            -- the pump never raises a second one for the same event (0223).
            OR NEW.max_attempts < 5) THEN
      RAISE EXCEPTION 'the application enqueues a settlement job only as pending work due now (0222)'
        USING ERRCODE = '42501';
    END IF;
    -- And only for the thing its singleton key names, which must exist for this business: a job
    -- squatting an event's key with a payload naming something else would make the pump treat the
    -- verified payment as queued while settlement settles nothing (review of `10ef5c9`).
    IF NEW.kind = 'billing.process'
       AND (NEW.singleton_key IS DISTINCT FROM 'billevent:' || (NEW.payload ->> 'eventId')
            OR NOT EXISTS (SELECT 1 FROM public.external_events e
                           WHERE e.id::text = NEW.payload ->> 'eventId'
                             AND e.business_id = NEW.business_id AND e.provider = 'paystack')) THEN
      RAISE EXCEPTION 'a settlement job names the Paystack event of its singleton key, for its business (0222)'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.kind = 'billing.apply_no_charge'
       AND (NEW.singleton_key IS DISTINCT FROM 'no-charge:' || (NEW.payload ->> 'reference')
            OR NOT EXISTS (SELECT 1 FROM public.subscription_charges c
                           WHERE c.reference = NEW.payload ->> 'reference'
                             AND c.business_id = NEW.business_id)) THEN
      RAISE EXCEPTION 'a settlement job names the charge of its singleton key, for its business (0222)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- The one honest requeue is `deadJobsRepo.beginRecovery`: due now, with exactly one more attempt.
  -- An unbounded run time or attempt budget would let the application park a verified payment's
  -- dead job out of the operator's reach (it leaves `dead`, so neither dead-job enrolment nor
  -- recovery sees it again): independent review of `10ef5c9`.
  IF OLD.kind IN ('billing.process', 'billing.apply_no_charge')
     AND NOT (OLD.state = 'dead' AND NEW.state = 'pending'
              AND NEW.run_at <= now() + interval '1 minute'
              AND NEW.max_attempts = OLD.attempts + 1) THEN
    RAISE EXCEPTION 'only settlement runs, completes or reschedules a settlement job; the application may requeue a dead one, due now, with one more attempt (0222)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
    -- The lease decides whether the handler's fenced completion still matches its row, and when
    -- the worker's reclaim takes the job back (OD-52, 0220).
    IF NEW.locked_by IS DISTINCT FROM OLD.locked_by
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'a job''s lease changes only as it moves from running to done, or from dead to pending, for the application (OD-52)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'done' THEN
    RETURN NEW;
  END IF;
  -- A recovered dead job goes back to the queue with no lease, as `deadJobsRepo.beginRecovery` writes
  -- it; the worker's claim takes it from there (residual 10). For EVERY kind, not only settlement's
  -- (0223): due now, with exactly one more attempt. Unbounded, the application could park a dead
  -- customer-payment job out of the operator's reach (it leaves `dead`, its record stays open, and
  -- the operator's recovery finds no dead job to requeue).
  IF OLD.state = 'dead' AND NEW.state = 'pending'
     AND NEW.locked_by IS NULL AND NEW.locked_at IS NULL
     AND NEW.run_at <= now() + interval '1 minute'
     AND NEW.max_attempts = OLD.attempts + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a job''s state moves only from running to done, or from dead to pending with no lease, due now, with one more attempt, for the application (OD-52, 0223)'
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION rekoda_private.jobs_application_transition_guard() FROM PUBLIC;
