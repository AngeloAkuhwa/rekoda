-- REM-01 / G-109: a trial reminder Meta ACCEPTED and later reported as FAILED is recorded as
-- 'undelivered', instead of staying 'sent' for ever.
--
-- 0180 records the latest attempt and, when Meta accepted it, the wamid it returned
-- (trial_notice_provider_message_id). A delivery failure arrives later, as a `failed` status receipt
-- naming that wamid; the `delivery.status` job applies it under the business's tenant pin
-- (subscriptionsRepo.markTrialNoticeUndelivered), moving 'sent' (or 'unknown') to 'undelivered' only
-- when the wamid matches this business's latest attempt. The stage stays claimed: like 'unknown', an
-- undelivered stage is NOT resent (OWN-47, no exactly-once claim), and the next milestone is still
-- owed because the claim compares stages, not states.
--
-- trial_notice_failed_at is when the failure was applied; a later claim clears it with the rest of
-- the attempt.
--
-- sweep_trial_candidates (0181) returns trial_notice_state as text and filters on plan and expiry
-- only, never on the state, so it needs no change: the new value passes through as-is.
--
-- Safe on a populated table and re-runnable: the new CHECK is a superset of the old one, so every
-- existing row satisfies it. It is swapped in one ALTER (no window without a constraint), added NOT
-- VALID and validated separately so the scan does not hold an exclusive lock. Expand-only: the
-- previous release never writes 'undelivered' and ignores the new column.
-- Rollback (after the code that writes 'undelivered' is gone):
--   UPDATE businesses SET trial_notice_state = 'sent' WHERE trial_notice_state = 'undelivered';
--   restore the 0180 CHECK list, DROP COLUMN trial_notice_failed_at, and remove the row whose tag is
--   '0186_trial_notice_undelivered' in the migration ledger table (rekoda_migrations).
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS trial_notice_failed_at timestamptz;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_trial_notice_state_check,
  ADD CONSTRAINT businesses_trial_notice_state_check
    CHECK (trial_notice_state IN ('sending', 'sent', 'unknown', 'suppressed', 'refused', 'undelivered'))
    NOT VALID;

ALTER TABLE businesses VALIDATE CONSTRAINT businesses_trial_notice_state_check;
