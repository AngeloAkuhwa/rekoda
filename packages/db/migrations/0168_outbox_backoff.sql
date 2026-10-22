-- G-18: a failing outbox event was retried on the very next dispatcher pass,
-- so eight attempts were spent in seconds and a transient outage (a provider
-- blip, a deploy) killed the event for good. `next_attempt_at` is the time
-- before which the event is not claimable again; `markFailed` sets it with an
-- exponential delay and `claimBatch` honours it. NULL means due now, which is
-- every event that has never failed and every historical row.
ALTER TABLE outbox_events
  ADD COLUMN next_attempt_at timestamptz;
