-- G-109 (OWN-54): usage a business on the trial plan spent BEFORE trial usage moved to one row.
--
-- Until migration 0175's release, a trial metered by calendar month like any other plan. A business
-- that is still on the trial plan has never been on a paid one (a plan never returns to trial), so
-- every base-plan meter row it holds is TRIAL usage. Left on its month rows it would be both
-- invisible to the trial meter (a second allowance) and carried into a first paid month in the
-- same month (no fresh meter). This moves it, once, onto the trial row (`TRIAL00`), summing the
-- months a trial can span, and points the reservations still recorded on its messages at that row.
--
-- The units a standalone holding sells (API_REQUEST_UNITS, WEBHOOK_DELIVERIES) keep their own
-- monthly rows and are not touched. A paid, expired or later business is not touched. Safe to run
-- again: a second run finds no month row to move. Row-level security is switched off for the
-- statements and restored (enabled and forced) in the same migration, as migration 0053 does.

ALTER TABLE usage_counters DISABLE ROW LEVEL SECURITY;

WITH moved AS (
  DELETE FROM usage_counters uc
  USING businesses b
  WHERE b.id = uc.business_id
    AND b.plan = 'trial'
    AND uc.period <> 'TRIAL00'
    AND uc.unit NOT IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES')
  RETURNING uc.business_id, uc.unit, uc.used, uc.bonus
)
INSERT INTO usage_counters (business_id, period, unit, used, bonus)
SELECT business_id, 'TRIAL00', unit, SUM(used)::int, SUM(bonus)::int
  FROM moved
 GROUP BY business_id, unit
ON CONFLICT (business_id, period, unit) DO UPDATE
  SET used = usage_counters.used + EXCLUDED.used,
      bonus = usage_counters.bonus + EXCLUDED.bonus,
      updated_at = now();

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;

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
