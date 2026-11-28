-- OD-57: validates the check 0247 added NOT VALID. VALIDATE takes only SHARE UPDATE EXCLUSIVE
-- (reads and writes continue) and runs in its own migration transaction, separate from the ADD.
-- Every existing row holds NULL or the 0152 kind, which the new check accepts unchanged.
ALTER TABLE command_drafts VALIDATE CONSTRAINT command_drafts_confirmation_context_ck;
