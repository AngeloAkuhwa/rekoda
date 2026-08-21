-- The posting an invoice wrote, recorded on the invoice.
--
-- `expenses` and `credit_notes` have carried this link since they existed.
-- `invoices` never did, and the gap has cost twice already.
--
-- Voiding an invoice cannot say what it reverses. The reversal is written
-- with `reverses_id` left null, so the ledger holds a correction related to
-- what it corrects only by a memo somebody has to read. `ledger_transactions`
-- has declared that column since the schema was drawn and nothing has ever
-- filled it in.
--
-- And nothing can group revenue. `invoices.sale_source` records where a sale
-- actually happened (the shop counter, an Instagram message, the market), and
-- it has been written and never read, because there was no way to get from a
-- credit on SALES_REVENUE back to the invoice that caused it. A merchant
-- selling in four places could not be told which one earns.
--
-- Nullable, because a document is not rewritten: rows issued before this
-- column existed keep their null, and every read treats that as "not
-- attributed" rather than pretending otherwise.
ALTER TABLE invoices ADD COLUMN ledger_transaction_id uuid;

-- The join a revenue schedule makes, once per statement.
CREATE INDEX IF NOT EXISTS invoices_ledger_tx_ix
  ON invoices (business_id, ledger_transaction_id);
