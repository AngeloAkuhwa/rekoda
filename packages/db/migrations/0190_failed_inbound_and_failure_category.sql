-- Owner rulings of 4 Nov 2026 on PR #428 (G-122).
--
-- 1. A merchant's inbound message whose job reaches `dead` (its handler failed on every attempt,
--    markFailed, or its worker stopped answering on every attempt, reclaimStalled) was never
--    processed. A draft that was pending when that message arrived must not be confirmable by a
--    later "yes": the lost message may have been its "cancel" or its correction. The inbound
--    handler retires such drafts under the business's inbound lock before it reads any answer
--    (`reconcileDeadInboundMessages`), as `superseded`, and this reason records why, so the
--    retirement is auditable and the next "yes" or "no" can tell the merchant to send it again.
--
-- 2. A dead job's `last_error` never carries an earlier attempt's error text. Instead each failure
--    records a fixed, sanitised category: `handler_error` (markFailed), `lease_expired` (an expired
--    lease, reclaimStalled), or `lease_expired_after_handler_error` (an expired lease on a job whose
--    handler had already failed). No error text, payload or provider response is ever stored here.
--
-- Expand-only: one nullable column with a CHECK, and one more value allowed by an existing CHECK.
-- Both tables keep their grants and RLS policies.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS failure_category text;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_failure_category_ck
  CHECK (failure_category IS NULL
         OR failure_category IN ('handler_error', 'lease_expired', 'lease_expired_after_handler_error'))
  NOT VALID;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_failure_category_ck;

ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_retired_reason_ck;
ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_retired_reason_ck
  CHECK (retired_reason IS NULL OR retired_reason IN ('preview_not_delivered', 'inbound_message_failed'))
  NOT VALID;
ALTER TABLE command_drafts VALIDATE CONSTRAINT command_drafts_retired_reason_ck;
