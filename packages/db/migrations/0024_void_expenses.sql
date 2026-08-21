-- Withdrawing a spend entry that should not have been recorded.
--
-- The invoice register got this in PR #79 and the spend register did not,
-- which left the half of the books a merchant dictates fastest with no
-- correction path at all. "I spent five thousand on diesel" said into a
-- WhatsApp voice note is exactly where a wrong figure comes from, and until
-- now the only remedy was a second entry that made the books wrong twice.
--
-- Same shape as the invoice void: not a delete. The row stays, gets marked,
-- and the ledger gets the MIRROR of its original posting.
--
-- ── why a foreign key and not a rebuild ─────────────────────────────────────
--
-- `voidInvoice` rebuilds the original posting from the invoice, because an
-- unpaid sale's posting is a pure function of the invoice row. A purchase's
-- is not: `postPurchase` splits on how much was PAID at the time, and the
-- expenses row has never stored that. The remainder went to ACCOUNTS_PAYABLE
-- and only the ledger knows how much.
--
-- So the reversal is built from the entries that were actually written, which
-- also removes the one thing the invoice path warns about: matching the
-- original transaction by memo is something that can drift, and a foreign key
-- is not.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS ledger_transaction_id uuid REFERENCES ledger_transactions(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'recorded';

-- Rows written before this migration, matched on the source they share with
-- their posting AND on the memo the builders write, so a draft that produced
-- more than one transaction cannot attach the wrong one. Anything left NULL
-- reports `no_posting` rather than guessing, which is the honest answer for
-- an entry whose posting cannot be identified.
UPDATE expenses e
   SET ledger_transaction_id = t.id
  FROM ledger_transactions t
 WHERE e.ledger_transaction_id IS NULL
   AND t.business_id = e.business_id
   AND t.source_type = e.source_type
   AND t.source_id IS NOT DISTINCT FROM e.source_id
   AND t.memo = CASE
                  WHEN e.category = 'stock' THEN 'Stock: ' || e.description
                  ELSE 'Expense: ' || e.description
                END;

-- The register reads `status` on every page load and the void writes it under
-- a WHERE on the same column, which is the mutual exclusion.
CREATE INDEX IF NOT EXISTS expenses_business_status_ix ON expenses (business_id, status);
