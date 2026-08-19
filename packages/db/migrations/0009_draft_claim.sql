-- CG3: confirmation is an atomic claim.
--
-- "Two rapid yes produce exactly one document" is not a thing application code
-- can promise. Two jobs, two connections, both read a draft in state
-- 'pending', both decide to issue — and the merchant's customer receives two
-- invoices with two numbers for one sale. On WhatsApp a double-tap is not an
-- edge case; it is Tuesday.
--
-- So the claim is a conditional UPDATE whose WHERE clause carries the
-- precondition, exactly like the AI quota reservation:
--
--   UPDATE command_drafts SET state = 'confirmed'
--   WHERE id = $1 AND state = 'pending'
--   RETURNING id
--
-- No row returned means somebody else claimed it first. That needs no schema
-- change — `state` is already there — but it does need the two indexes below,
-- because the claim runs on the hot path of every confirmation.

-- "The one draft this merchant is waiting to confirm." Partial, because a
-- healthy business accumulates thousands of confirmed drafts and none of them
-- are ever the answer to that question.
CREATE INDEX IF NOT EXISTS command_drafts_pending_ix
  ON command_drafts (business_id, created_at DESC)
  WHERE state = 'pending';

-- Claiming reads by id and state together.
CREATE INDEX IF NOT EXISTS command_drafts_id_state_ix
  ON command_drafts (id, state);
