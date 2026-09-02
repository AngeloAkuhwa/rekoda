-- Group F, part three: the append-only reversal chains (0141 and 0142 before).
--
-- Two self-referential edges. A correction points at what it corrects:
--   payment_allocations.reversal_of_id           -> payment_allocations
--   customer_credit_applications.reversal_of_id  -> customer_credit_applications
--
-- Unlike parts one and two, this is HARDENING rather than the closing of a
-- reachable hole, and the difference is worth stating plainly rather than
-- overselling. Both tables already refuse a cross-tenant reversal on the only
-- path an application role can take:
--
--   * the `*_reversal_shape` trigger from 0078 looks the original up with
--     `WHERE id = NEW.reversal_of_id AND business_id = NEW.business_id`, so an
--     INSERT citing another merchant's row is already rejected; and
--   * these tables are append-only. `rekoda_app` and `rekoda_worker` hold
--     INSERT and SELECT and nothing else, so no application role can UPDATE
--     the column afterwards.
--
-- What the key adds is what those two do not cover. The trigger is BEFORE
-- INSERT only: it never fires on UPDATE, and it never validated the rows that
-- already existed when it was created. A composite foreign key is declarative,
-- covers every path including an owner-credential fix-up script, and is
-- checked once over all history by VALIDATE. Ruling 1 also settled the
-- principle: application reachability is not the test for whether a
-- tenant-owned child may reference another tenant's parent. And
-- `ledger_transactions.reverses_id`, the third reversal chain in this schema,
-- already carries this key from 0137; leaving these two different would be an
-- inconsistency nobody could justify later.
--
-- The usual checks, run rather than assumed: business_id is NOT NULL on both
-- tables. `reversal_of_id` is nullable on both, correctly - most rows are not
-- reversals - so MATCH SIMPLE skips the constraint only when the row is not a
-- reversal at all. Neither table exposed UNIQUE (business_id, id), so this
-- adds both first, additively. No existing row points across a tenant. NOT
-- VALID then VALIDATE here, and the weaker key dropped only after the
-- stronger one is valid.
ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_business_id_ux UNIQUE (business_id, id);
ALTER TABLE customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_business_id_ux UNIQUE (business_id, id);

ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_reversal_business_fk
  FOREIGN KEY (business_id, reversal_of_id) REFERENCES payment_allocations (business_id, id) NOT VALID;
ALTER TABLE payment_allocations VALIDATE CONSTRAINT payment_allocations_reversal_business_fk;
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_reversal_of_id_fkey;

ALTER TABLE customer_credit_applications
  ADD CONSTRAINT customer_credit_applications_reversal_business_fk
  FOREIGN KEY (business_id, reversal_of_id) REFERENCES customer_credit_applications (business_id, id) NOT VALID;
ALTER TABLE customer_credit_applications VALIDATE CONSTRAINT customer_credit_applications_reversal_business_fk;
ALTER TABLE customer_credit_applications DROP CONSTRAINT customer_credit_applications_reversal_of_id_fkey;
