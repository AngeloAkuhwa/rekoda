-- The ledger was half append-only (PR-010, canonical spec §9 and §10).
--
-- `ledger_entries` has been protected since 0001 and 0004: neither
-- `rekoda_app` nor `rekoda_worker` may UPDATE or DELETE a line. But
-- `ledger_transactions` never got the same treatment. It takes the broad
-- GRANT in 0001 and nothing revokes it, so the row that OWNS the immutable
-- lines has been freely editable this whole time.
--
-- That is not a theoretical gap. A transaction row carries `memo`,
-- `source_type`, `source_id`, `reverses_id` and `created_at`. An UPDATE could
-- rewrite what a posting was for, break a reversal chain, or move a posting
-- into a different month without touching a single figure. The books would
-- still balance. Every statement would be wrong.
--
-- Nothing in the codebase updates or deletes either table today, which is
-- exactly why this is safe to apply and exactly why it should have been done
-- when 0001 was written. If some path did, it now fails loudly, which is the
-- outcome we want.
--
-- INSERT and SELECT are untouched: the ledger must still be writable forward.
-- Corrections remain what they always were, a reversing posting (§9.3).

REVOKE UPDATE, DELETE ON ledger_transactions FROM rekoda_app;
REVOKE UPDATE, DELETE ON ledger_transactions FROM rekoda_worker;

-- 0001 and 0004 also set ALTER DEFAULT PRIVILEGES granting UPDATE and DELETE
-- on future tables, so a table created later inherits the permissive grant.
-- Re-stating the revocation for the two ledger tables keeps this migration
-- correct however the surrounding grants are replayed from zero.
REVOKE UPDATE, DELETE ON ledger_entries FROM rekoda_app;
REVOKE UPDATE, DELETE ON ledger_entries FROM rekoda_worker;

COMMENT ON TABLE ledger_transactions IS
  'Posted journal (canonical spec §9). Append-only: UPDATE and DELETE are '
  'revoked from rekoda_app and rekoda_worker by migration 0051. A correction '
  'is a reversing posting, never an edit.';
