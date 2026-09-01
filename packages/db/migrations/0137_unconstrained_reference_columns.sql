-- Six columns that named a row in another table with NO foreign key at all.
--
-- The thirty-four relationships of ruling 1 were WEAK keys: they said the
-- parent exists but not whose it was. These are worse. `invoices
-- .ledger_transaction_id` carries the comment "a null means unattributed
-- rather than something invented", which is a promise nothing enforced: the
-- column could name a posting that never existed, or one belonging to another
-- merchant, and the database had no opinion.
--
-- Found by asking the opposite question of the R1 audit. That audit
-- enumerated foreign keys missing their tenant; this came from enumerating
-- uuid columns on tenant tables that look like references and have no
-- constraint at all.
--
-- Each target was established from the writers and the column's own comment,
-- never from the column NAME, and every child carries business_id NOT NULL,
-- so MATCH SIMPLE skips only when the optional reference is null.
--
--   invoices.ledger_transaction_id       "the posting", null when unattributed
--   bills.ledger_transaction_id          the same shape, for a payable
--   goods_returns.ledger_transaction_id  joins the invoice and product edges
--                                        this table already had
--   tax_events.journal_id                "the posting that carried the tax to
--                                        the books, when one did"
--   ledger_transactions.reverses_id      "a correction points at what it
--                                        reverses" — a self reference, and the
--                                        one place a reversal chain could have
--                                        crossed tenants
--   revenue_recognition_events.order_line_id  the order line the recognition
--                                        is against
--
-- The last needs a target to point AT: `order_items` had no UNIQUE
-- (business_id, id), so this adds one first. That is additive and is the same
-- key every other parent in this schema exposes.
--
-- TWO columns are deliberately left alone, and it is not an oversight:
-- `payment_verifications.financial_transaction_id` and
-- `payment_verification_claims.financial_transaction_id`. No table named
-- `financial_transactions` exists, no code anywhere assigns either column, and
-- 0057 describes the intent only as "the bank line". A foreign key here would
-- be a guess at which table that means, and a wrong guess is worse than the
-- absence: it would look like enforcement. They stay unconstrained until a
-- writer exists to settle it.
ALTER TABLE order_items ADD CONSTRAINT order_items_business_id_ux UNIQUE (business_id, id);

ALTER TABLE invoices
  ADD CONSTRAINT invoices_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_tx_business_fk;

ALTER TABLE bills
  ADD CONSTRAINT bills_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE bills VALIDATE CONSTRAINT bills_tx_business_fk;

ALTER TABLE goods_returns
  ADD CONSTRAINT goods_returns_tx_business_fk
  FOREIGN KEY (business_id, ledger_transaction_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE goods_returns VALIDATE CONSTRAINT goods_returns_tx_business_fk;

ALTER TABLE tax_events
  ADD CONSTRAINT tax_events_journal_business_fk
  FOREIGN KEY (business_id, journal_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE tax_events VALIDATE CONSTRAINT tax_events_journal_business_fk;

-- Self-referential: a correction and what it corrects belong to one merchant.
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_reverses_business_fk
  FOREIGN KEY (business_id, reverses_id) REFERENCES ledger_transactions (business_id, id) NOT VALID;
ALTER TABLE ledger_transactions VALIDATE CONSTRAINT ledger_transactions_reverses_business_fk;

ALTER TABLE revenue_recognition_events
  ADD CONSTRAINT rre_order_line_business_fk
  FOREIGN KEY (business_id, order_line_id) REFERENCES order_items (business_id, id) NOT VALID;
ALTER TABLE revenue_recognition_events VALIDATE CONSTRAINT rre_order_line_business_fk;
