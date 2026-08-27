-- Drop the 0045 feed-connection sketch (B1, PR-076 — the drop 0095
-- promised).
--
-- `financial_account_connections` (0095) is the canonical entity: every
-- reader and writer moved in the same change that froze this table, the
-- backfill was gated, and the freeze has since proven by REVOKE that no
-- straggler writes remained. Same sequence the conversation migration
-- used (058a-5): constrain, cut over, THEN delete, so the drop removes
-- dead weight and never live state.

DROP TABLE bank_feed_connections;
