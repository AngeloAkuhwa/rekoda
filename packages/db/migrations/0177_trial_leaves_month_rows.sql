-- G-109 (OWN-54): a business leaving the trial leaves no trial usage on a calendar-month row.
--
-- The trial meters its base-plan units on ONE row (`TRIAL00`); migration 0176 copied the usage a
-- running trial had on calendar-month rows onto it and left those rows in place, so the previous
-- release (which still reads and writes them) keeps working until it is replaced. A deploy cannot
-- stop that release's processes before it migrates, so a trial business can have calendar-month
-- rows from before 0176 and from the previous release's writes after it. The new release never
-- reads such a row for a trial, and left alone it would be read as PAID usage the moment the
-- business buys a plan in that month, so the first paid month would not start fresh.
--
-- Any base-plan month row a business holds at the moment its plan leaves `trial` is therefore
-- trial usage by definition (paid usage has not begun), and is discarded here, in the same
-- statement that changes the plan, whichever code path changes it. The units a standalone holding
-- sells (API_REQUEST_UNITS, WEBHOOK_DELIVERIES) keep their own months and are not touched. Runs as
-- the invoking role under the tenant pin (the application and worker roles may delete their own
-- tenant's usage rows); with no pin the delete matches nothing and the plan change is unaffected.
-- What the previous release spent after 0176 copied the totals is not counted against the trial
-- budget: a bounded, one-time benefit to the merchant during a single deploy window.

CREATE OR REPLACE FUNCTION release_trial_month_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM usage_counters
   WHERE business_id = NEW.id
     AND period <> 'TRIAL00'
     AND unit NOT IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS businesses_release_trial_month_rows ON businesses;
CREATE TRIGGER businesses_release_trial_month_rows
  AFTER UPDATE OF plan ON businesses
  FOR EACH ROW
  WHEN (OLD.plan = 'trial' AND NEW.plan IS DISTINCT FROM 'trial')
  EXECUTE FUNCTION release_trial_month_rows();
