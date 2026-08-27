-- `ledger_entries.account_id`, additive (spec §8, F1; PR-031).
--
-- The bridge from the seventeen-key text column to the real chart of
-- accounts. NULLABLE, because every historical row is null until PR-032's
-- validated backfill; the DUAL WRITE starts now, so from this deploy on no
-- new row is born without its account — and the backfill's job only ever
-- shrinks.
--
-- The FK is composite on (business_id, id), the same shape as every scope
-- FK in 0061: an entry citing another tenant's account is unrepresentable.
-- No reader changes here; the cutover is PR-033.

ALTER TABLE ledger_entries ADD COLUMN account_id uuid;

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_account_fk
  FOREIGN KEY (business_id, account_id)
  REFERENCES accounts (business_id, id);

/* Partial, because until the backfill the null majority would bloat it for
 * nothing; after PR-034 drops the text column this is the statement index. */
CREATE INDEX ledger_entries_account_id_ix
  ON ledger_entries (business_id, account_id)
  WHERE account_id IS NOT NULL;
