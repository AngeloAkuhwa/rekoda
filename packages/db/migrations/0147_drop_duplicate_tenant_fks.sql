-- Ruling 5: the two redundant single-column foreign keys, removed.
--
-- Each of these columns carries TWO foreign keys to the same parent: the
-- original single-column key, and the tenant-composite key that replaced it
-- as the constraint of record. The composite subsumes the single key in every
-- reachable case, so the weaker one has been pure noise since the stronger
-- one validated:
--
--   ledger_entries.transaction_id
--     weak    (transaction_id)              -> ledger_transactions (id)      [0000]
--     strong  (business_id, transaction_id) -> ledger_transactions
--                                              (business_id, id)             [0070]
--     Both columns NOT NULL, so the composite is checked on every row.
--     Migration 0135 saw this duplicate, said so, and deliberately left it
--     for its own cleanup rather than mixing a tidy-up into a correction.
--
--   payment_intents.payment_connection_id
--     weak    (payment_connection_id)               -> payment_connections (id) [0010]
--     strong  (business_id, payment_connection_id)  -> payment_connections
--                                                      (business_id, id)        [0081]
--     `payment_connection_id` is nullable; under MATCH SIMPLE a NULL exempts
--     the single-column key and the composite alike, and `business_id` is
--     NOT NULL, so whenever the weak key would have been checked the strong
--     one is checked too. Identical coverage, stricter predicate.
--
-- Neither weak key carries ON DELETE or ON UPDATE behaviour the composite
-- lacks — all four constraints are plain REFERENCES — so nothing about
-- delete-time behaviour changes here. Both composites are VALIDATED (proven
-- again by this migration's test suite, along with the cross-tenant refusals
-- that only the composites now enforce).

ALTER TABLE ledger_entries
  DROP CONSTRAINT ledger_entries_transaction_id_ledger_transactions_id_fk;

ALTER TABLE payment_intents
  DROP CONSTRAINT payment_intents_payment_connection_id_fkey;
