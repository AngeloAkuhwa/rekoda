-- The price list a merchant can actually manage (MASTER-PLAN §5.3.5).
--
-- `products` has built itself out of conversation since M1: a merchant says
-- "sold 2 bags of rice" and a rice row appears, which is the right way round
-- and is why there has never been a setup screen to fill in first. What it
-- has never had is a way to say anything ABOUT a product. A price could only
-- be set by mentioning it in a sale, there was nowhere to describe what the
-- thing is, and `active` existed as a column nothing could ever set.
--
-- That is fine for a shop keeping books and useless for one selling: Rekoda
-- Integrate's whole promise is a catalogue a customer sees, and a catalogue
-- with no photo and no description is a list of words and numbers.
ALTER TABLE products
  -- What the merchant would say about it to a customer. Theirs, in their
  -- words, and never generated: a description Rekoda invented would be
  -- Rekoda making a claim about goods it has never seen.
  ADD COLUMN IF NOT EXISTS description text,
  -- The storage key of the photo, never the bytes. Same rule as `documents`:
  -- a financial database that carries every image a merchant ever uploaded
  -- is a file server with a WAL, and every backup and replica pays for it.
  ADD COLUMN IF NOT EXISTS image_key text;

-- The catalogue page's own query. `active` is in the index because the
-- listed and the hidden are two different lists to a merchant and one table
-- to Postgres.
CREATE INDEX IF NOT EXISTS products_business_active_ix ON products (business_id, active);
