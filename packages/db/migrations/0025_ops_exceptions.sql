-- An exception queue an operator can WORK, not only count (MASTER-PLAN §6.4).
--
-- The paystack pump's comments have called its marks "the admin exception
-- queue" since it shipped, and `eventHealth` could only ever say how many
-- there were. A number you cannot act on is not a queue; it is an alarm with
-- no handle, and the honest end of that is somebody with database access at
-- 2am reading `external_events` by hand.
--
-- Three columns, so working an exception leaves a record of who decided and
-- why. Without them the only way to make a flagged event stop appearing would
-- be to edit `error`, which would destroy the reason it was flagged for.
--
-- `external_events` is deliberately outside row-level security (see the note
-- at the top of repos/events.ts): an event arrives before anyone knows whose
-- it is. That is exactly why this queue is gated on the deployment secret and
-- the worker credential rather than on a session, and why nothing it returns
-- carries the payload.
ALTER TABLE external_events
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS resolution text;

-- The queue's own query: everything flagged and not yet dealt with, oldest
-- first. Partial, because the rows that matter are a vanishing fraction of a
-- table that grows with every webhook Meta and Paystack ever send.
CREATE INDEX IF NOT EXISTS external_events_open_exceptions_ix
  ON external_events (created_at)
  WHERE error IS NOT NULL AND resolved_at IS NULL;

-- And the other half: stored, never processed, never attributed. A backlog
-- here means a sweep is not running.
CREATE INDEX IF NOT EXISTS external_events_stuck_ix
  ON external_events (created_at)
  WHERE processed_at IS NULL AND business_id IS NULL;
