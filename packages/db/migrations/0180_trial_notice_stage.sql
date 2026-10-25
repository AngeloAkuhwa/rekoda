-- G-109 / OWN-56 / OWN-47: trial reminders (7, 2 and 1 days before the trial ends) are claimed once
-- each and the latest send attempt is recorded durably.
--
-- last_trial_notice_stage has the shape of last_grace_reminder_day (0021): a conditional UPDATE moves
-- it forward, so two overlapping sweep passes send one message. The three attempt columns describe the
-- LATEST attempt (a later stage replaces them):
--   'sending'  claimed, outcome not yet known (a crash leaves it here);
--   'sent'     the provider accepted it (provider_message_id when it named one);
--   'suppressed' the final eligibility check just before dispatch found the trial ended, a plan
--              bought or the owner opted out, so nothing was sent; the stage stays claimed and is
--              never retried;
--   'unknown'  the outcome cannot be told (timeout, dropped connection, a crash). Never resent: a
--              duplicate reminder is not a harm worth risking, and no exactly-once claim is made.
-- A send the provider definitively refused releases the claim and clears the state.
-- Nullable and expand-only; the previous release ignores all four columns.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS last_trial_notice_stage smallint,
  ADD COLUMN IF NOT EXISTS trial_notice_state text
    CHECK (trial_notice_state IN ('sending', 'sent', 'unknown', 'suppressed')),
  ADD COLUMN IF NOT EXISTS trial_notice_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_notice_provider_message_id text;
