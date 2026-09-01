-- Group C of the tenant-composite foreign keys: spend, inventory, returns
-- (remediation R1 ruling 1, four of thirty-four; A was 0132, B was 0133).
--
-- Small, and it contains its own worked example. `goods_returns.invoice_id` is
-- the edge that opened this whole finding: the table ALREADY carries the
-- correct composite key for `product_id`, added when it was created, and the
-- invoice edge beside it was left single-column. One table, both forms, and
-- nothing about the second is harder than the first.
--
-- Same procedure and the same checks, run rather than assumed: business_id is
-- NOT NULL on all four child tables, so MATCH SIMPLE skips the constraint only
-- when the optional foreign id is null; suppliers, invoices, products and
-- expenses all expose UNIQUE (business_id, id); NOT VALID then VALIDATE in
-- this migration; the weaker key dropped only after the stronger one is valid.
ALTER TABLE expenses
  ADD CONSTRAINT expenses_supplier_business_fk
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id) NOT VALID;
ALTER TABLE expenses VALIDATE CONSTRAINT expenses_supplier_business_fk;
ALTER TABLE expenses DROP CONSTRAINT expenses_supplier_id_suppliers_id_fk;

ALTER TABLE goods_returns
  ADD CONSTRAINT goods_returns_invoice_business_fk
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) NOT VALID;
ALTER TABLE goods_returns VALIDATE CONSTRAINT goods_returns_invoice_business_fk;
ALTER TABLE goods_returns DROP CONSTRAINT goods_returns_invoice_fk;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_product_business_fk
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) NOT VALID;
ALTER TABLE inventory_movements VALIDATE CONSTRAINT inventory_movements_product_business_fk;
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_product_id_products_id_fk;

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_expense_business_fk
  FOREIGN KEY (business_id, expense_id) REFERENCES expenses (business_id, id) NOT VALID;
ALTER TABLE supplier_payments VALIDATE CONSTRAINT supplier_payments_expense_business_fk;
ALTER TABLE supplier_payments DROP CONSTRAINT supplier_payments_expense_id_fkey;
