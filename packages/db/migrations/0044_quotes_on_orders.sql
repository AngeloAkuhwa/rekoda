-- Quotes ride the orders engine (fix-plan 4, G3). A quote is an order-shaped
-- offer: QUO-numbered on its own counter, status 'quoted' until the merchant
-- converts it into the invoice the existing engine already knows how to
-- raise. One nullable column is the whole schema cost.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "valid_until" date;
