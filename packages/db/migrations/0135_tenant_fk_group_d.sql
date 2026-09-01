-- Group D of the tenant-composite foreign keys: reconciliation and ledger
-- provenance (remediation R1 ruling 1, six of thirty-four; A was 0132, B was
-- 0133, C was 0134).
--
-- The group the plan flagged for highest care, and the reason is worth stating
-- rather than assuming. Five of these six attach a business record to a POSTED
-- LEDGER TRANSACTION. A cross-tenant link here is not an untidy join; it is a
-- business record claiming provenance in another tenant's financial history —
-- an expense pointing at somebody else's posting, a bank line matched to a
-- transaction that was never theirs.
--
-- Ledger transactions are append-only (0051) and posted drafts are locked
-- (0073), so nothing here can rewrite history. What was missing is the
-- narrower guarantee: that the row POINTING at that history belongs to the
-- same tenant as the history it points at.
--
-- Same procedure as the three groups before it, with the same checks run
-- rather than assumed:
--
--   * business_id is NOT NULL on all six child tables, so MATCH SIMPLE skips
--     the constraint only when the optional foreign id is null, exactly as
--     the single-column key does today;
--   * ledger_transactions and payments both expose UNIQUE (business_id, id);
--   * NOT VALID then VALIDATE in this migration: a lighter lock for the scan,
--     and no constraint left in a state nobody can rely on;
--   * the weaker key is dropped only after the stronger one is valid.
--
-- Deliberately NOT touched: `ledger_entries.transaction_id` carries BOTH the
-- composite key (0070) and a redundant single-column one. It sits beside these
-- edges and would be easy to sweep up here, but the owner ruling put that
-- duplicate in its own cleanup, and widening this migration to take it would
-- mix a correction with a tidy-up.
ALTER TABLE bank_line_matches
  ADD CONSTRAINT bank_line_matches_tx_business_fk
  FOREIGN KEY (business_id, transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE bank_line_matches VALIDATE CONSTRAINT bank_line_matches_tx_business_fk;
ALTER TABLE bank_line_matches DROP CONSTRAINT bank_line_matches_transaction_id_fkey;

ALTER TABLE credit_notes
  ADD CONSTRAINT credit_notes_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE credit_notes VALIDATE CONSTRAINT credit_notes_tx_business_fk;
ALTER TABLE credit_notes DROP CONSTRAINT credit_notes_ledger_transaction_id_fkey;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE expenses VALIDATE CONSTRAINT expenses_tx_business_fk;
ALTER TABLE expenses DROP CONSTRAINT expenses_ledger_transaction_id_fkey;

ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_assets_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE fixed_assets VALIDATE CONSTRAINT fixed_assets_tx_business_fk;
ALTER TABLE fixed_assets DROP CONSTRAINT fixed_assets_ledger_transaction_id_fkey;

ALTER TABLE reconciliations
  ADD CONSTRAINT reconciliations_payment_business_fk
  FOREIGN KEY (business_id, payment_id) REFERENCES payments (business_id, id) NOT VALID;
ALTER TABLE reconciliations VALIDATE CONSTRAINT reconciliations_payment_business_fk;
ALTER TABLE reconciliations DROP CONSTRAINT reconciliations_payment_id_payments_id_fk;

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE supplier_payments VALIDATE CONSTRAINT supplier_payments_tx_business_fk;
ALTER TABLE supplier_payments DROP CONSTRAINT supplier_payments_ledger_transaction_id_fkey;
