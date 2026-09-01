-- Group B of the tenant-composite foreign keys: payments, intents,
-- allocations, receipts, evidence (remediation R1 ruling 1, twelve of
-- thirty-four; group A was migration 0132).
--
-- The most exposed group, and the reason the ruling grouped by domain rather
-- than doing all thirty-four at once. R1 singled out three of these edges —
-- `payment_allocations.invoice_id`, `payment_intents.invoice_id` and
-- `receipts.invoice_id` — as the ones most likely to be fed by an id arriving
-- from outside. R2 found no reachable path, and that remains beside the point:
-- a tenant-owned child must not be CAPABLE of naming another tenant's parent.
--
-- What is at stake here is arithmetic, not just tidiness. `payment_allocations`
-- is what says a payment settled an invoice, and `invoices.balance_due_k` is a
-- projection of exactly those rows. An allocation pointing at another tenant's
-- invoice would take a debt off books it never belonged to.
--
-- Same procedure as 0132, and the same three checks run rather than assumed:
--
--   * business_id is NOT NULL on all six child tables, so MATCH SIMPLE skips
--     the constraint only when the optional foreign id is null, which is
--     exactly what the single-column key does today;
--   * every parent already exposes UNIQUE (business_id, id) — customers,
--     invoices, orders, payments and payment_intents;
--   * NOT VALID then VALIDATE in this migration, so the scan takes a lighter
--     lock and no constraint is left in a state nobody can rely on.
--
-- The weaker key is dropped only after the stronger one is valid.
ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE payment_allocations VALIDATE CONSTRAINT payment_allocations_invoice_business_fk;
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_invoice_id_invoices_id_fk;

ALTER TABLE payment_allocations
  ADD CONSTRAINT payment_allocations_payment_business_fk
  FOREIGN KEY (business_id, payment_id) REFERENCES payments (business_id, id) NOT VALID;
ALTER TABLE payment_allocations VALIDATE CONSTRAINT payment_allocations_payment_business_fk;
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_payment_id_payments_id_fk;

ALTER TABLE payment_evidence
  ADD CONSTRAINT payment_evidence_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE payment_evidence VALIDATE CONSTRAINT payment_evidence_customer_business_fk;
ALTER TABLE payment_evidence DROP CONSTRAINT payment_evidence_customer_id_fkey;

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE payment_intents VALIDATE CONSTRAINT payment_intents_customer_business_fk;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_customer_id_fkey;

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE payment_intents VALIDATE CONSTRAINT payment_intents_invoice_business_fk;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_invoice_id_fkey;

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_order_business_fk
  FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id) NOT VALID;
ALTER TABLE payment_intents VALIDATE CONSTRAINT payment_intents_order_business_fk;
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_order_id_fkey;

ALTER TABLE payment_verifications
  ADD CONSTRAINT payment_verifications_payment_business_fk
  FOREIGN KEY (business_id, payment_id) REFERENCES payments (business_id, id) NOT VALID;
ALTER TABLE payment_verifications VALIDATE CONSTRAINT payment_verifications_payment_business_fk;
ALTER TABLE payment_verifications DROP CONSTRAINT payment_verifications_payment_id_fkey;

ALTER TABLE payments
  ADD CONSTRAINT payments_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_customer_business_fk;
ALTER TABLE payments DROP CONSTRAINT payments_customer_id_customers_id_fk;

ALTER TABLE payments
  ADD CONSTRAINT payments_payment_intent_business_fk
  FOREIGN KEY (business_id, payment_intent_id) REFERENCES payment_intents (business_id, id) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_payment_intent_business_fk;
ALTER TABLE payments DROP CONSTRAINT payments_payment_intent_id_fkey;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE receipts VALIDATE CONSTRAINT receipts_customer_business_fk;
ALTER TABLE receipts DROP CONSTRAINT receipts_customer_id_customers_id_fk;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE receipts VALIDATE CONSTRAINT receipts_invoice_business_fk;
ALTER TABLE receipts DROP CONSTRAINT receipts_invoice_id_invoices_id_fk;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_payment_business_fk
  FOREIGN KEY (business_id, payment_id) REFERENCES payments (business_id, id) NOT VALID;
ALTER TABLE receipts VALIDATE CONSTRAINT receipts_payment_business_fk;
ALTER TABLE receipts DROP CONSTRAINT receipts_payment_id_payments_id_fk;
