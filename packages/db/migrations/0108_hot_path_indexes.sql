-- Load and performance (PR-105, S1).
--
-- Three additive indexes, each backed by a measured plan rather than a
-- guess. The estate's hot reads were EXPLAINed over seeded volume; these
-- are the joins that fell to sequential scans, and every one sits on a
-- path that grows with a merchant's history:
--
--   1. customer_credit_applications had no invoice_id index, so every
--      question of the form "was this invoice settled by credit" - the
--      invoice balance tie, the customer statement, the §31 invariant-3
--      probe - hash-joined a full scan of the table per ask.
--   2. receipts carried only a bare business_id index, so the receipt
--      register's newest-first page sorted the whole tenant's history on
--      every load; the register is a page a tax officer is shown.
--   3. supplier_payments had no bill_id index, and the supplier statement
--      joins payments to bills by exactly that column.
--
-- Additive only: no table is rewritten, no reader changes, and rollback is
-- DROP INDEX. (The build-plan row carried "no migration"; the measurement
-- said otherwise, and an index IS the load-and-performance deliverable -
-- recorded in amendment 1.111 rather than silently deviated.)

CREATE INDEX IF NOT EXISTS credit_applications_invoice_ix
  ON customer_credit_applications (invoice_id);

CREATE INDEX IF NOT EXISTS receipts_business_created_ix
  ON receipts (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS supplier_payments_bill_ix
  ON supplier_payments (business_id, bill_id)
  WHERE bill_id IS NOT NULL;
