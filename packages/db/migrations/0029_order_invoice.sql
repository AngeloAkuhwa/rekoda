-- Which invoice an order became (MASTER-PLAN §5.3.5).
--
-- The orders card on the invoice register already tells a merchant that each
-- order became the invoice below it, and until now nothing recorded WHICH. A
-- shop with thirty orders and thirty invoices had to match them by eye, on a
-- page that claimed the matching had been done for them. That is the worst
-- kind of gap: not a missing feature, a stated fact the data cannot support.
--
-- On `orders` rather than on `invoices`, and the direction is deliberate. An
-- invoice is a document written by half a dozen paths and read by all of
-- them; an order is written by one. A nullable column on the document table
-- that only one path ever sets is a column every other path has to learn to
-- ignore.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id);

-- One order per invoice, enforced rather than assumed. Two orders pointing at
-- one invoice would mean a merchant was quoted twice and billed once, and the
-- register would show the same document under two different requests.
-- Partial, because an order that is still a quote has no invoice at all and
-- there can be any number of those.
CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_ux
  ON orders (business_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
