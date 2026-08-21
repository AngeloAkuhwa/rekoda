-- Correcting an invoice money has already arrived against.
--
-- `voidInvoice` refuses any invoice with a payment on it and tells the
-- merchant that a credit note is the right instrument. Until now there was no
-- such instrument, so that refusal was a dead end: the one correction path a
-- merchant is most likely to need ended in advice they could not act on.
--
-- ── why not just extend the void ───────────────────────────────────────────
--
-- Because they describe different things. A void says the sale never should
-- have happened and mirrors its whole posting. A credit note says the sale
-- happened and is being reduced - returned goods, an overcharge, a settled
-- dispute - and the money that already moved stays where it is. Collapsing
-- them would reverse a payment that is sitting in the merchant's account.
--
-- The two are mutually exclusive by construction: the void takes unpaid
-- invoices, the credit note takes the rest.
CREATE TABLE IF NOT EXISTS credit_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  credit_note_number text NOT NULL,
  amount_k      bigint NOT NULL,
  /* The share of the credit that was VAT, so the liability comes back down
     with the revenue. Zero on an invoice that carried none. */
  vat_k         bigint NOT NULL DEFAULT 0,
  reason        text NOT NULL,
  actor         text NOT NULL,
  ledger_transaction_id uuid REFERENCES ledger_transactions(id),
  snapshot_json jsonb,
  doc_hash      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Dense per business per year, same rule as invoices and receipts: a gap an
-- auditor cannot explain is what they read as a deleted document.
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_ux
  ON credit_notes (business_id, credit_note_number);
CREATE INDEX IF NOT EXISTS credit_notes_invoice_ix ON credit_notes (business_id, invoice_id);

-- How much of this invoice has been credited so far. The guard against
-- crediting an invoice past its own value, and it lives on the row rather
-- than being summed at write time so the check and the write are one
-- statement that two concurrent credits cannot both pass.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credited_k bigint NOT NULL DEFAULT 0;

-- Same tenant isolation as every other financial table.
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_notes
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON credit_notes TO rekoda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_notes TO rekoda_worker;
-- A credit note is a document, not a working row: it is never rewritten.
REVOKE UPDATE, DELETE ON credit_notes FROM rekoda_app;
