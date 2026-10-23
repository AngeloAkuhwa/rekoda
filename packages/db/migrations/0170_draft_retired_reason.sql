-- G-20 (owner ruling): a merchant must never confirm a financial draft whose
-- preview was not presented to them. A `pending` draft whose preview WhatsApp
-- accepted and later reported as `failed` (a status webhook) is retired, as
-- `superseded`, and this column records why, so the retirement is auditable
-- rather than indistinguishable from a merchant's own "no" or a correction. A
-- send that failed outright leaves the draft `pending` with `previewed = false`
-- (no reason is recorded); `claimDraft` refuses it. An `expired` draft keeps its
-- state and gets no reason either; only its `previewed` flag is cleared.
--
-- NULL on every row that was never retired for this reason, which is every
-- existing row. Additive, nullable, no default; covered by the table-level
-- grants and RLS policies command_drafts already has.
ALTER TABLE command_drafts ADD COLUMN retired_reason text;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_retired_reason_ck
  CHECK (retired_reason IS NULL OR retired_reason IN ('preview_not_delivered')) NOT VALID;
ALTER TABLE command_drafts VALIDATE CONSTRAINT command_drafts_retired_reason_ck;
