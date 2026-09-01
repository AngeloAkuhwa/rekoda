-- Group A of the tenant-composite foreign keys: invoices, orders, customers,
-- items (remediation R1 ruling 1, nine of thirty-four).
--
-- Each of these nine columns names a row in another table that belongs to a
-- tenant, and each is enforced today by a foreign key that does not mention
-- the tenant at all:
--
--   FOREIGN KEY (invoice_id) REFERENCES invoices(id)
--
-- which says the invoice EXISTS. It does not say it is this business's
-- invoice. Every child table below carries `business_id NOT NULL`, and every
-- parent already exposes UNIQUE (business_id, id), so the stronger form costs
-- nothing but the writing:
--
--   FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id)
--
-- Application code checks this today, and R2 found no reachable path that
-- bypasses it. That is not the standard the ruling set, and it should not be:
-- a tenant-owned child must not be CAPABLE of naming another tenant's parent,
-- whether or not today's callers would.
--
-- MATCH SIMPLE (the default) is correct here and was checked rather than
-- assumed: it skips the constraint when ANY column of the key is null, which
-- for these nine means only when the optional foreign id is null — exactly
-- what the single-column key does today. `business_id` is NOT NULL on all six
-- child tables, so there is no null-tenant row that escapes the check. The
-- tables where that is NOT true are held back for their own ruling.
--
-- NOT VALID then VALIDATE, in that order and in this migration, so the scan
-- takes a lighter lock than ADD CONSTRAINT would while still ending validated.
-- A constraint left NOT VALID is one nobody can rely on.
--
-- The weaker key is dropped only after the stronger one is valid, which is the
-- order the ruling asked for and the order that leaves no window with neither.

ALTER TABLE credit_notes
  ADD CONSTRAINT credit_notes_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE credit_notes VALIDATE CONSTRAINT credit_notes_invoice_business_fk;
ALTER TABLE credit_notes DROP CONSTRAINT credit_notes_invoice_id_fkey;

ALTER TABLE customer_identities
  ADD CONSTRAINT customer_identities_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE customer_identities VALIDATE CONSTRAINT customer_identities_customer_business_fk;
ALTER TABLE customer_identities DROP CONSTRAINT customer_identities_customer_id_customers_id_fk;

ALTER TABLE invoice_items
  ADD CONSTRAINT invoice_items_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE invoice_items VALIDATE CONSTRAINT invoice_items_invoice_business_fk;
ALTER TABLE invoice_items DROP CONSTRAINT invoice_items_invoice_id_invoices_id_fk;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_customer_business_fk;
ALTER TABLE invoices DROP CONSTRAINT invoices_customer_id_customers_id_fk;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_order_business_fk
  FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id) NOT VALID;
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_order_business_fk;
ALTER TABLE invoices DROP CONSTRAINT invoices_order_id_orders_id_fk;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_order_business_fk
  FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id) NOT VALID;
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_order_business_fk;
ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_orders_id_fk;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_product_business_fk
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) NOT VALID;
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_product_business_fk;
ALTER TABLE order_items DROP CONSTRAINT order_items_product_id_products_id_fk;

ALTER TABLE orders
  ADD CONSTRAINT orders_customer_business_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_business_fk;
ALTER TABLE orders DROP CONSTRAINT orders_customer_id_customers_id_fk;

ALTER TABLE orders
  ADD CONSTRAINT orders_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_invoice_business_fk;
ALTER TABLE orders DROP CONSTRAINT orders_invoice_id_fkey;
