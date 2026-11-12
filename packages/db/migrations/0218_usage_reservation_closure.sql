-- OD-51.4, completed (independent review of `2b602b0`, recorded as OD-52; owner instruction OWN-91:
-- the limits are closed, not accepted): a reservation stops being refundable when the work it
-- paid for is finished.
--
-- 0216 made `usage_refund` the only way to lower `used`, against a reservation, once, within 45
-- days. But nothing marked a reservation as FINISHED. A message that was answered, a document that
-- was issued or a voice note that was transcribed keeps its reservation's handle on its event
-- (`external_events.reserved_meters`), by design, so a retry of the same event does not pay twice.
-- That handle is readable with the application credential, so a holder of it could return every
-- refundable unit a business genuinely used in the last 45 days: most of the "allowance restored
-- for free" that 0216 set out to stop.
--
-- The rule the code already follows is: a unit goes back only inside an attempt of the SAME event's
-- job (a retry that executes nothing, an exit that produced no document, a job that died). Once
-- that job is done, nothing honest ever refunds it. This migration makes the database hold that
-- rule:
--
--   1. A reservation can be bound to the event it was made for (`usage_bind_event`, called beside
--      the write that records the handle on the event). Bound once; never re-bound.
--   2. When a job is marked done, every reservation bound to its event is CLOSED, in the same
--      transaction (a trigger on `jobs`, run as `rekoda_usage_writer`, so no runtime role needs a
--      right on the reservations for it and no code path can forget it).
--   3. `usage_refund` gives nothing back for a closed reservation.
--
-- What stays refundable: a reservation whose job has not finished (it may still fail, retry or
-- die, and then the unit must go back, exactly as before), and a reservation held only in memory
-- by a request (a template send, a storefront order, a webhook delivery, an export), whose id no
-- runtime role can read.
--
-- Existing rows: every reservation whose handle is recorded on an event is bound to that event
-- (0216 created one for each past event that recorded a unit), and those whose event has no job
-- still waiting, running or dead are closed (a dead job may be recovered and then give its unit
-- back). No counter value, charge or event is changed.
--
-- Compatibility: additive on top of 0216 (one nullable column pair, one function, one trigger, a
-- re-created `usage_refund` with one more refusal). The release that carries 0216 without this
-- migration keeps working against it: it never binds, so nothing of its own is closed. Rollback:
-- none past 0196 (OWN-86). Re-running is safe. Re-running 0216 by hand afterwards puts its older
-- `usage_refund` back, so it must be followed by this file again (the migration runner applies each
-- file once, in order, and never does that).

ALTER TABLE usage_reservations
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;
CREATE INDEX IF NOT EXISTS usage_reservations_event_ix
  ON usage_reservations (business_id, event_id) WHERE event_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 1. Bind a reservation to the event it was made for.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_bind_event(
  p_business uuid,
  p_reservation uuid,
  p_event uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
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
  UPDATE public.usage_reservations SET event_id = p_event WHERE id = r.id;
  RETURN true;
END $$;

ALTER FUNCTION public.usage_bind_event(uuid, uuid, uuid) OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION public.usage_bind_event(uuid, uuid, uuid)
  FROM PUBLIC, rekoda_settlement, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.usage_bind_event(uuid, uuid, uuid) TO rekoda_app, rekoda_worker;

-- ---------------------------------------------------------------------------------------------
-- 2. A finished job closes its event's reservations.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event text := NEW.payload ->> 'eventId';
BEGIN
  IF v_event IS NULL
     OR v_event !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN NEW; -- a job that is not about an event holds no reservation
  END IF;
  UPDATE public.usage_reservations
  SET closed_at = now()
  WHERE business_id = NEW.business_id AND event_id = v_event::uuid AND closed_at IS NULL;
  RETURN NEW;
END $$;

ALTER FUNCTION rekoda_private.jobs_close_event_reservations() OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION rekoda_private.jobs_close_event_reservations() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_close_event_reservations ON jobs;
CREATE TRIGGER jobs_close_event_reservations
  AFTER UPDATE OF state ON jobs
  FOR EACH ROW
  WHEN (NEW.state = 'done' AND OLD.state IS DISTINCT FROM 'done')
  EXECUTE FUNCTION rekoda_private.jobs_close_event_reservations();

-- ---------------------------------------------------------------------------------------------
-- 3. A closed reservation gives nothing back. Otherwise exactly the function of 0216.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_refund(
  p_business uuid,
  p_reservation uuid,
  p_unit text,
  p_n integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  v_back integer;
BEGIN
  IF p_business IS NULL OR p_reservation IS NULL OR p_unit IS NULL OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_refund: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_refund: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id, period, unit, quantity, refunded, created_at, closed_at INTO r
  FROM public.usage_reservations
  WHERE id = p_reservation AND business_id = p_business
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0; -- the spend never committed (its transaction rolled back), or is long past
  END IF;
  IF r.unit <> p_unit THEN
    RAISE EXCEPTION 'usage_refund: the reservation is for another unit' USING ERRCODE = '22023';
  END IF;
  IF r.closed_at IS NOT NULL THEN
    RETURN 0; -- the work it paid for is finished: the unit was used
  END IF;
  IF r.created_at < now() - interval '45 days' THEN
    RETURN 0;
  END IF;
  v_back := least(p_n, r.quantity - r.refunded);
  IF v_back <= 0 THEN
    RETURN 0; -- already given back
  END IF;
  UPDATE public.usage_counters
  SET used = greatest(used - v_back, 0), updated_at = now()
  WHERE business_id = p_business AND period = r.period AND unit = r.unit;
  UPDATE public.usage_reservations
  SET refunded = refunded + v_back, refunded_at = now()
  WHERE id = r.id;
  RETURN v_back;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_usage_writer) and the grants of 0216.

-- ---------------------------------------------------------------------------------------------
-- 4. Existing reservations: bind each to the event that records its handle, and close those whose
--    event has no job still waiting, running or dead (a dead job may be recovered and give its
--    unit back). As the table owner, across tenants, once.
-- ---------------------------------------------------------------------------------------------
UPDATE usage_reservations r
SET event_id = e.id
FROM external_events e
CROSS JOIN LATERAL jsonb_each_text(e.reserved_meters) AS m(unit, handle)
WHERE r.event_id IS NULL
  AND e.business_id = r.business_id
  AND m.handle LIKE '%#%'
  AND split_part(m.handle, '#', 2) = r.id::text;

UPDATE usage_reservations r
SET closed_at = now()
WHERE r.event_id IS NOT NULL AND r.closed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.business_id = r.business_id
      AND j.payload ->> 'eventId' = r.event_id::text
      AND j.state IN ('pending', 'running', 'dead'));
