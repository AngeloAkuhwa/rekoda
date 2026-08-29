-- Drop `ledger_entries.account` (F1; PR-034).
--
-- The end of the ordered cutover PR-029…033 built: the chart rows are the
-- only account identity left. `account_id` becomes NOT NULL — the database
-- now states what the dual write promised, that no entry exists without its
-- chart account — and the text column goes, taking the seventeen-key
-- vocabulary's last physical trace in this table with it.
--
-- Runs strictly after 0064's validated backfill (which ABORTS while any row
-- is unlinked), so SET NOT NULL cannot fail on an estate the gate passed.
--
-- Indexes follow the column. The two text-key indexes drop with it; the
-- partial index from 0063 is retired too, because its predicate is now
-- vacuously true, and one full statement-shaped index replaces the pair —
-- (business_id, account_id, created_at) serves both the statement schedules
-- (0041's rationale) and, by prefix, every business+account balance read.

ALTER TABLE ledger_entries ALTER COLUMN account_id SET NOT NULL;

DROP INDEX "ledger_entries_account_ix";
DROP INDEX "ledger_entries_business_account_created_ix";
DROP INDEX "ledger_entries_account_id_ix";

ALTER TABLE ledger_entries DROP COLUMN account;

CREATE INDEX "ledger_entries_business_account_id_created_ix"
  ON "ledger_entries" USING btree ("business_id", "account_id", "created_at");
