-- Trials end (docs/pricing-model.md: 30 days, no card).
--
-- `plan_expires_at` has existed since 0000 and was read by nothing, so every
-- trial received fresh allowances every calendar month, forever. New
-- businesses now get the date at creation; this backfills the ones already
-- in flight from the day they started rather than from today, so nobody
-- silently gains a second trial by being early.
UPDATE businesses
SET plan_expires_at = trial_started_at + interval '30 days'
WHERE plan = 'trial' AND plan_expires_at IS NULL;

-- The expiry is read on every metered message, always beside the plan.
CREATE INDEX IF NOT EXISTS businesses_plan_expiry_ix ON businesses (plan, plan_expires_at);
