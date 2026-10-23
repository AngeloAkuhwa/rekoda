-- G-20 (owner ruling): a merchant must never confirm a financial draft whose
-- preview was not presented to them. A draft whose preview WhatsApp failed to
-- deliver (a send that failed outright, or a `failed` status webhook after
-- acceptance) is retired, as `superseded`, and this column records why, so
-- the retirement is auditable rather than indistinguishable from a merchant's
-- own "no" or a correction.
--
-- NULL on every row that was never retired for this reason, which is every
-- existing row. Additive, nullable, no default; covered by the table-level
-- grants and RLS policies command_drafts already has.
ALTER TABLE command_drafts ADD COLUMN retired_reason text;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_retired_reason_ck
  CHECK (retired_reason IS NULL OR retired_reason IN ('preview_not_delivered')) NOT VALID;
ALTER TABLE command_drafts VALIDATE CONSTRAINT command_drafts_retired_reason_ck;
