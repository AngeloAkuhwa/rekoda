-- PR #432 closeout round G (Qodo findings 12 and 13 on the 0227 gate, rated IMPORTANT by the
-- round's independent triage): a usage reservation binds only to its event's own metering job.
--
-- A bound reservation is refundable for 45 days, an unbound one for 15 minutes, and only the event's
-- job finishing closes it (0218, 0221). 0227 bound to an event of this business with ANY running job
-- whose payload named it, matched by stripping `{`, `}` and `-` from the payload's text. Reproduced
-- on a live `rekoda_app` connection (packages/db/src/ops/usage-bind-event-job.integration.test.ts):
--   * 12: `{{<uuid>}}`, or a hyphen out of place, passed that match, but the closure trigger casts
--     the payload to uuid and returns without closing when the cast fails: the unit stayed
--     refundable for 45 days although its job finished. 0227's comment ("a malformed id matches
--     nothing") was untrue;
--   * 13: a running job of any kind qualified, for example one the application enqueued with a
--     budget of one attempt; a dead job's reservation stays open by design (the operator's
--     recovery), so that job dying kept the unit refundable;
--   * a second live job of a metering kind naming the event, beside the real one, qualified too.
-- Now the payload must be a spelling the trigger reads as this uuid (`pg_input_is_valid`, then the
-- same cast), the job an `inbound.message` or `customer.message` (the two handlers that meter an
-- event's spend: `events.noteReservedUnit`, `reserveUnitForEvent`), and the event's only live job of
-- those kinds. Every refusal keeps 0227's message and SQLSTATE.
--
-- Residual (stated, OD-54): the application credential can still fabricate a Meta event and enqueue
-- its one handler job; that job runs the real handler, whose finish closes the reservation. What
-- the database cannot tell is whether an event is genuine: the webhook's signature check is the
-- application's.
--
-- The function's owner, `rekoda_usage_writer`, gains SELECT on `jobs.kind` beside the
-- `business_id`, `state` and `payload` 0227 gave it: a coordination column, and nothing it can write.
--
-- Not a compatibility break: the function is replaced in place (same signature, owner, grants and
-- result). Re-running is safe; re-running 0227 afterwards would put back the earlier match (the
-- pre-start smoke checks this text).

GRANT SELECT (kind) ON jobs TO rekoda_usage_writer;

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
  -- 0245 (Qodo 12, 13): and that job is the event's own metering job. Its payload names the event in
  -- a spelling the closure trigger (0221) reads as this uuid, tested with the same input rule the
  -- cast applies (pg_input_is_valid) and never cast unchecked, so a payload the trigger cannot read
  -- matches nothing; its kind is one of the two handlers that meter an event's spend; and it is the
  -- event's only live job of those kinds, so a second one naming the event (forged beside it) is
  -- refused rather than chosen.
  IF NOT EXISTS (
       SELECT 1 FROM public.external_events e
       WHERE e.id = p_event AND e.business_id = p_business)
     OR (SELECT count(*) FROM public.jobs j
         WHERE j.business_id = p_business
           AND j.kind IN ('inbound.message', 'customer.message')
           AND j.state IN ('pending', 'running')
           AND CASE WHEN pg_input_is_valid(j.payload ->> 'eventId', 'uuid')
                    THEN (j.payload ->> 'eventId')::uuid END = p_event) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.jobs j
       WHERE j.business_id = p_business AND j.state = 'running'
         AND j.kind IN ('inbound.message', 'customer.message')
         AND CASE WHEN pg_input_is_valid(j.payload ->> 'eventId', 'uuid')
                  THEN (j.payload ->> 'eventId')::uuid END = p_event) THEN
    RAISE EXCEPTION 'usage_bind_event: not an event of this business whose job is running'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.usage_reservations SET event_id = p_event WHERE id = r.id;
  RETURN true;
END $function$;
