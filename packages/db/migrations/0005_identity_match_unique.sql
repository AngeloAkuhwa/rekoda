-- One person is one customer, even when two messages arrive together.
--
-- `identities_match_ix` was a plain index. It made the lookup fast and
-- guaranteed nothing: the gateway looks a match key up, finds nothing, and
-- creates a customer — so two messages from the same new number, arriving in
-- the same second, both find nothing and both create one. The merchant ends up
-- with two customers who are the same person, two tokens, and a debtor list
-- that splits one balance in half.
--
-- This is the same race `upsertUserByPhone` lost in M1, in a different table.
-- The fix is the same: let the database decide, and let the loser find out it
-- was second.
--
-- Partial, because `match_key` is null for facets that are never matched on
-- (an address, a name we chose not to key). Those rows must stay unconstrained.
DROP INDEX IF EXISTS identities_match_ix;

CREATE UNIQUE INDEX IF NOT EXISTS identities_match_ux
  ON customer_identities (business_id, facet, match_key)
  WHERE match_key IS NOT NULL;

-- The lookup path for unmatched facets, which the unique index above no longer
-- covers.
CREATE INDEX IF NOT EXISTS identities_business_facet_ix
  ON customer_identities (business_id, facet)
  WHERE match_key IS NULL;
