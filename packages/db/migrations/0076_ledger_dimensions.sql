-- Subledger dimensions on journal lines (spec §12.2; F1, PR-046).
--
-- "Reading a per-order balance requires journal lines to carry what they
-- belong to." The GENERIC trace every entry already carries (sourceType,
-- sourceId, postingPurpose) stays universal; these columns are the
-- ADDITIONAL context, optional by design — §12.2 is explicit that a
-- blanket orderId requirement would be too strong: opening receivables,
-- inherited balances and manual invoices are all legitimate and none has
-- an order. NULL is the truthful value for all of history and for every
-- posting whose source is not commerce.
--
-- The recognition writer (repos/recognition.ts) enforces the §12.2
-- REQUIRED rules for the lines IT writes — an AR line it posts carries its
-- invoice or receivable reference, a contract-liability line its order —
-- which is where the requirement belongs: on the writer whose events can
-- know, not on history that cannot.

ALTER TABLE invoices ADD CONSTRAINT invoices_business_id_ux UNIQUE (business_id, id);

ALTER TABLE ledger_entries
  ADD COLUMN order_id uuid,
  ADD COLUMN invoice_id uuid;

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_order_fk
    FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id),
  ADD CONSTRAINT ledger_entries_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id);

/* The per-order balance reads: role-filtered sums over one order's lines. */
CREATE INDEX ledger_entries_order_ix
  ON ledger_entries (business_id, order_id)
  WHERE order_id IS NOT NULL;
