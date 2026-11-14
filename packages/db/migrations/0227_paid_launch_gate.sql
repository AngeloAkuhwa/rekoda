-- OWN-92 paid-launch security gate (named "migration 0224" in the ruling; it takes the next free
-- number). Two things a holder of the application credential could still do at 0226, each now
-- refused by the database. Final remediation of PR #432 (owner brief, 15 Nov 2026).
--
-- (a) Qodo 12: reschedule queued work without changing its state. The 0223 job guard checked a
--     same-state update only for its lease, and `rekoda_app` holds UPDATE on `run_at` and
--     `max_attempts` (for the honest dead-to-pending requeue), so it could push a pending
--     `payment.process` job's run time out or cut its retry budget, delaying or suppressing a
--     verified customer payment; in one statement for every pending job, too. It could also
--     insert a non-settlement job already `running`, leased, or with attempts spent. Since 0227
--     the guard refuses any application change of `run_at`, `max_attempts` or `attempts` except in
--     the dead-to-pending requeue (due now, exactly one more attempt, attempts unchanged), and any
--     insert that is not new pending work with no lease and no attempt spent. The trigger is FOR
--     EACH ROW, so a bulk update is refused as a whole. The worker's claim, retry and defer, and
--     settlement's own kinds, are unaffected (the guard applies only to holders of rekoda_app).
--
-- (b) Qodo 11: `usage_bind_event` (0218) bound a reservation to any event id. A bound reservation
--     stays refundable for 45 days from its creation, against 15 minutes for an unbound one, and
--     only its event's job finishing closes it (0218, `jobs_close_event_reservations`), so a
--     binding to an event that does not exist, belongs to another business, or has no running job
--     kept a spent unit refundable for 45 days. Since 0227 it binds only to an event of the same
--     business whose job is running now (exactly when the event's handler binds its spend),
--     refuses anything else with 42501 before writing, and keeps the 0218 rules (a repeat to the
--     same event is a no-op; another event is refused). The usage writer reads only the columns
--     the check needs, under the caller's tenant pin.
--
-- The windows, unchanged and now owner-approved (owner brief, 15 Nov 2026): an unbound reservation
-- is refundable for 15 minutes and a bound one for 45 days, both counted from
-- `usage_reservations.created_at`, which only the usage writer's functions set (the reservation's
-- creation, in the database's clock). After the window the reservation gives nothing back: its
-- units stay spent. A reservation closed by its job, or fully refunded, gives nothing back either.
--
-- Compatibility: the previous release (main, 0192) has neither function changed here; this
-- release's application never reschedules a job and binds only from the running handler. Not
-- compatibility-breaking. Rollback: none past 0196 (OWN-86). Re-running is safe.

GRANT SELECT (id, business_id) ON external_events TO rekoda_usage_writer;
GRANT SELECT (business_id, state, payload) ON jobs TO rekoda_usage_writer;

CREATE OR REPLACE FUNCTION rekoda_private.jobs_application_transition_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- 0227: the 0223 definition, plus the schedule rule and the insert rule for every kind.
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
    -- 0227 (OWN-92 (a)): any kind is enqueued as new work: pending, no lease, no attempt spent.
    -- A job inserted already running would be closed by nobody's handler, and one inserted with
    -- its attempts spent would skip retries the worker owns.
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.locked_by IS NOT NULL
       OR NEW.locked_at IS NOT NULL OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'the application enqueues a job only as pending work with no lease and no attempt spent (OWN-92, 0227)'
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
  -- 0227 (OWN-92 (a), Qodo 12): a job's schedule and retry budget belong to the worker (claim,
  -- retry, defer) and to settlement for its own kinds. The application changes them only in the one
  -- honest requeue below (dead to pending, due now, one more attempt). Checked here, before every
  -- branch, so a same-state update, a completion or a bulk update cannot move them either.
  IF (NEW.run_at IS DISTINCT FROM OLD.run_at OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
      OR NEW.attempts IS DISTINCT FROM OLD.attempts)
     AND NOT (OLD.state = 'dead' AND NEW.state = 'pending') THEN
    RAISE EXCEPTION 'only the worker schedules or retries a job; the application may requeue a dead one, due now, with one more attempt (OWN-92, 0227)'
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
     AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts
     AND NEW.max_attempts = OLD.attempts + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a job''s state moves only from running to done, or from dead to pending with no lease, due now, with one more attempt, for the application (OD-52, 0223)'
    USING ERRCODE = '42501';
END $function$;

CREATE OR REPLACE FUNCTION public.usage_bind_event(p_business uuid, p_reservation uuid, p_event uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
BEGIN
  IF p_business IS NULL OR p_reservation IS NULL OR p_event IS NULL THEN
    RAISE EXCEPTION 'usage_bind_event: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_bind_event: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id, event_id, closed_at INTO r
  FROM public.usage_reservations
  WHERE id = p_reservation AND business_id = p_business
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false; -- the spend never committed
  END IF;
  IF r.event_id IS NOT NULL THEN
    -- Bound already. The same event again is a repeat; another event is refused: a reservation
    -- moved to an event whose job never finishes would stay refundable for ever.
    IF r.event_id = p_event THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'usage_bind_event: the reservation belongs to another event'
      USING ERRCODE = '42501';
  END IF;
  IF r.closed_at IS NOT NULL THEN
    RETURN false;
  END IF;
  -- 0227 (OWN-92 (b), Qodo 11): only to an event of this business whose job is running now, as the
  -- event's handler binds the spend it makes. That job finishing closes the reservation (0218); an
  -- event that does not exist, is another business's, or has no running job would leave the unit
  -- refundable for the bound window (45 days) with nothing ever to close it.
  IF NOT EXISTS (
       SELECT 1 FROM public.external_events e
       WHERE e.id = p_event AND e.business_id = p_business)
     OR NOT EXISTS (
       SELECT 1 FROM public.jobs j
       WHERE j.business_id = p_business AND j.state = 'running'
         -- Any spelling the closure trigger reads as this uuid (braced, hyphenless, upper case:
         -- 0220), compared as text and never cast, so a malformed id matches nothing.
         AND lower(translate(j.payload ->> 'eventId', '{}-', '')) = replace(p_event::text, '-', '')) THEN
    RAISE EXCEPTION 'usage_bind_event: not an event of this business whose job is running'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.usage_reservations SET event_id = p_event WHERE id = r.id;
  RETURN true;
END $function$;
