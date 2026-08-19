-- Composite indexes on the paths that will actually be hot (MASTER-PLAN 4.4 #4).
--
-- Every query in Rekoda is tenant-scoped by construction: row-level security
-- means an index that does not lead with business_id cannot serve a query the
-- policies will allow. The single-column indexes dropped here were therefore
-- doing no work the composites do not already do — PostgreSQL uses any leading
-- subset of a composite key, so (business_id, status) answers everything
-- (business_id) answered.
--
-- invoices_customer_ix is the clearest case: an index on customer_id alone can
-- only serve a lookup across businesses, which is exactly what RLS forbids.
--
-- Dropping them is not tidying. The ledger and its documents are append-heavy,
-- and every surviving index is paid for on every insert.

DROP INDEX IF EXISTS invoices_business_ix;
DROP INDEX IF EXISTS invoices_customer_ix;
DROP INDEX IF EXISTS payments_business_ix;

-- "Who owes me?" — the debtors question, asked constantly.
CREATE INDEX IF NOT EXISTS invoices_business_status_ix ON invoices (business_id, status);
-- One customer's statement.
CREATE INDEX IF NOT EXISTS invoices_business_customer_ix ON invoices (business_id, customer_id);
-- The reconciliation queue: unverified payments for one business.
CREATE INDEX IF NOT EXISTS payments_business_verified_ix ON payments (business_id, verified);
