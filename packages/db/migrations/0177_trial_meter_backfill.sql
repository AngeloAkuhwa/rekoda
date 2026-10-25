-- G-109 (OWN-54): seed the trial row from the usage a business on the trial plan spent BEFORE trial
-- usage moved to one row. EXPAND-ONLY: it adds rows and deletes none, so the previous release,
-- which still reads and writes calendar-month rows, keeps working untouched until it is replaced.
--
-- Until migration 0175's release, a trial metered by calendar month like any other plan. A business
-- that is still on the trial plan has never been on a paid one (a plan never returns to trial), so
-- every base-plan meter row it holds is TRIAL usage. The new release meters a trial on ONE row
-- (`TRIAL00`), so a running trial's usage must be on it, or the trial would get a second allowance.
-- This COPIES the sum of those month rows (`used` and `bonus`, summing the months a trial can span)
-- onto `TRIAL00`, and points the reservations still recorded on its messages at that row. It never
-- overwrites a `TRIAL00` row that exists (DO NOTHING), so running it again changes nothing.
--
-- The month rows are left where they are. The new release never reads them for a trial; migration
-- 0177 discards them when the business leaves the trial, so a first paid month starts fresh. The
-- units a standalone holding sells (API_REQUEST_UNITS, WEBHOOK_DELIVERIES) keep their own monthly
-- rows and are not touched, nor is any business that is not on the trial plan.
--
-- Row-level security is switched off for the statements and restored (enabled and forced) in the
-- same migration, as migration 0053 does. This file touches ONE table (the reservations are the next
-- migration), so its ACCESS EXCLUSIVE lock is never held while another table's is wanted: the
-- previous release is still running and takes row locks on both.

ALTER TABLE usage_counters DISABLE ROW LEVEL SECURITY;

INSERT INTO usage_counters (business_id, period, unit, used, bonus)
SELECT uc.business_id, 'TRIAL00', uc.unit, SUM(uc.used)::int, SUM(uc.bonus)::int
  FROM usage_counters uc
  JOIN businesses b ON b.id = uc.business_id
 WHERE b.plan = 'trial'
   AND uc.period <> 'TRIAL00'
   AND uc.unit NOT IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES')
 GROUP BY uc.business_id, uc.unit
ON CONFLICT (business_id, period, unit) DO NOTHING;

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
