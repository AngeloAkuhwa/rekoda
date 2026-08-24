-- Supplier identities join the vault (the "later slice" spend.ts promised).
--
-- The suppliers table has existed since 0000 with a plaintext name column
-- and NO write path: the spend boundary deliberately dropped supplier
-- mentions because "names live in the identity vault or nowhere". This is
-- that vault. The plaintext column goes (it was never written, so nothing
-- is lost), and what replaces it is the customer construction: a cipher
-- only the authorised boundary can open, and an HMAC match key so the same
-- supplier said twice folds to one row without the name being comparable.
ALTER TABLE suppliers DROP COLUMN IF EXISTS name;
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS name_cipher text NOT NULL,
  ADD COLUMN IF NOT EXISTS match_key text NOT NULL;

-- One row per supplier per business, decided by the database: two drafts
-- naming the same supplier in the same minute produce one record.
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_match_ux ON suppliers (business_id, match_key);
