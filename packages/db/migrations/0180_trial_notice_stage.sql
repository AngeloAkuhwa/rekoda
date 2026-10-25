-- G-109 / OWN-56: trial reminders (7, 2 and 1 days before the trial ends) are claimed once each.
-- Same shape as last_grace_reminder_day (0021): a conditional UPDATE moves the stage forward, so two
-- overlapping sweep passes send one message. Nullable and expand-only; the previous release ignores it.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS last_trial_notice_stage smallint;
