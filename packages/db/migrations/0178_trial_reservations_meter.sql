-- G-109 (OWN-54): point the reservations still recorded on a running trial's messages at the trial
-- row (`TRIAL00`), where migration 0177 copied that trial's usage, so a delayed refund lands there.
-- EXPAND-ONLY: it fills `reserved_meters`, which the previous release never reads, and deletes
-- nothing. Only reservations of a business still on the trial plan, and only units without a meter
-- row already; API request and webhook units keep their own monthly cycle. Re-running changes nothing.
--
-- A separate file from 0177 on purpose: each migration is one transaction, and disabling row-level
-- security takes an ACCESS EXCLUSIVE lock on its table until the file ends. The previous release is
-- still running while this runs and takes row locks on external_events and usage_counters in
-- turn, so one file must never hold the lock on one of them while it waits for the other.

ALTER TABLE external_events DISABLE ROW LEVEL SECURITY;

UPDATE external_events e
   SET reserved_meters = e.reserved_meters || COALESCE((
         SELECT jsonb_object_agg(split_part(u, ':', 1), 'TRIAL00')
           FROM unnest(e.reserved_units) AS u
          WHERE split_part(u, ':', 1) NOT IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES')
            AND NOT (e.reserved_meters ? split_part(u, ':', 1))), '{}'::jsonb)
  FROM businesses b
 WHERE b.id = e.business_id
   AND b.plan = 'trial'
   AND cardinality(e.reserved_units) > 0;

ALTER TABLE external_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_events FORCE ROW LEVEL SECURITY;
