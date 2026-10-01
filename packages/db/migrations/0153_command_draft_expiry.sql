-- A preview is a question with a time limit (G-23).
--
-- Until now a draft stayed `pending` for as long as nobody answered it. A
-- merchant previewed a sale on Monday, said nothing, and a "yes" on Thursday
-- (meant for something else, or sent by whoever picked the phone up) issued
-- Monday's invoice. A preview is the merchant agreeing to what they READ, and
-- what they read on Monday is not what they are agreeing to on Thursday.
--
-- So every draft now carries the moment it stops being confirmable, owned by
-- the database rather than by whichever process happened to read it:
--
--   * `expires_at`: when the confirmation window closes. A draft may be
--     claimed only while `state = 'pending' AND clock < expires_at`, and the
--     claim itself carries that predicate (conversationsRepo.claimDraft), so
--     a draft cannot age out between a check and the write that trusted it.
--   * `expired`: a new state, distinct from the four that exist.
--       pending     can still be confirmed
--       confirmed   was claimed by a "yes"
--       superseded  replaced by a correction, or cancelled with "no"
--       abandoned   a retired purchase question (G-61): kept on the record,
--                   never itself confirmable, and re-asked by a "yes"
--       expired     the confirmation window elapsed before anyone said yes
--     `abandoned` is NOT reused for expiry: since G-61 it means a question the
--     merchant answers by sending the purchase again, and a "yes" after it
--     asks that question again. An expired sale is not a question.
--
-- The window is CONFIRMATION_TTL_SECONDS (packages/core/src/risk.ts, 300
-- seconds), the one already used for a HIGH_RISK confirmation: five minutes
-- is long enough to read a preview and decide, short enough that a phone left
-- on a counter is not an open authorisation. One window for both, never a
-- second number. SQL cannot import the constant, so the 300 below is pinned
-- to it by draft-expiry.integration.test.ts, which fails if they diverge.
--
-- `previewed` records whether the merchant was actually SHOWN a preview a
-- "yes" confirms, as opposed to a question (a CG1 arithmetic question, "which
-- invoice?") that is stored as a draft with the same financial intent. Only
-- an expired preview is answered "that request has expired"; a lapsed
-- question was never something to confirm. FALSE by default and for every
-- existing row: never claim a preview that may not have been shown.
--
-- Nothing is deleted: an expired draft keeps its intent, its tokenised
-- command and its confirmation_context, which are part of the conversation's
-- history. Expiry is decided lazily, when the merchant next interacts; no
-- sweep is needed to stop a stale preview from executing.

ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_state_check;
ALTER TABLE command_drafts ADD CONSTRAINT command_drafts_state_check
  CHECK (state IN ('pending', 'superseded', 'confirmed', 'abandoned', 'expired'));

ALTER TABLE command_drafts ADD COLUMN expires_at timestamptz;

-- Every existing draft gets the window it would have had: deterministic, and
-- in the past for anything older than five minutes, so a preview left
-- pending before this release can no longer be confirmed by a late "yes".
-- (Migrations run with BYPASSRLS, enforced by migrate.ts, so this reaches
-- every tenant's rows.)
UPDATE command_drafts SET expires_at = created_at + interval '300 seconds';

ALTER TABLE command_drafts ALTER COLUMN expires_at SET NOT NULL;

-- The repository always sets it from the constant; the default is the safety
-- net for any other writer, on the same clock as `created_at`.
ALTER TABLE command_drafts
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '300 seconds');

ALTER TABLE command_drafts ADD COLUMN previewed boolean NOT NULL DEFAULT false;

-- The metered units a "yes" reserved, recorded on the message that spent
-- them, in the SAME committed transaction as the consume. A confirmation
-- meters in its own transaction (a rollback must not hand units back that
-- were genuinely spent), so a job that then fails leaves them spent; its
-- retry never meters again, and when it executes nothing it refunds exactly
-- what is recorded here and clears it, inside the job's own transaction.
-- Facts, not inference: no unit is refunded that was not reserved, none
-- twice. Unit names only; nothing about the message or the merchant.
ALTER TABLE external_events ADD COLUMN reserved_units text[] NOT NULL DEFAULT '{}';
