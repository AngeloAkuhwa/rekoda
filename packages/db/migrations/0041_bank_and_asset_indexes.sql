-- Two indexes the audit found queries silently doing without.
--
-- bank_statement_lines: allBankLinesFor walks the table in chunks with
-- WHERE business_id = ? AND id > ? ORDER BY id LIMIT n. Without an index on
-- (business_id, id) each chunk filters on the day index and re-sorts the
-- tenant's whole line set, so the chunking cost MORE than one unbounded read
-- would have. This index is what makes the walk what it was designed to be.
CREATE INDEX IF NOT EXISTS "bank_lines_business_id_ix"
  ON "bank_statement_lines" USING btree ("business_id", "id");--> statement-breakpoint

-- fixed_assets: assetsDue is a cross-tenant sweep. Its predicate has no
-- business_id, so the (business_id, status) index cannot serve it and every
-- hourly pass scanned the whole table. Partial and in sweep order, the way
-- recurring_due_ix already is for the recurring sweep.
CREATE INDEX IF NOT EXISTS "fixed_assets_due_ix"
  ON "fixed_assets" USING btree ("bought_on")
  WHERE "status" = 'recorded' AND "months_charged" < "useful_life_months";
--> statement-breakpoint
-- ledger_entries: the statement schedules filter business_id + account +
-- created_at range, three times per statements page and again per PDF and
-- Excel export. Neither existing index carries all three, so a big ledger
-- scanned every EXPENSES row to aggregate one month.
CREATE INDEX IF NOT EXISTS "ledger_entries_business_account_created_ix"
  ON "ledger_entries" USING btree ("business_id", "account", "created_at");
