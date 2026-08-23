-- Keys for the writes the audit caught racing or double-applying.
--
-- products: findOrCreateProduct read-then-inserted with nothing behind it,
-- so two messages naming a new product at the same moment created twins and
-- split the stock history forever. The index expression is EXACTLY the fold
-- productByName matches on; drift between the two is the bug both of their
-- comments already warn about. No production data exists yet, so no
-- de-duplication precedes this; on a dirty database this fails loudly, which
-- is the correct outcome because the duplicates need a human's merge.
CREATE UNIQUE INDEX IF NOT EXISTS "products_business_folded_name_ux"
  ON "products" ("business_id", lower(regexp_replace(btrim("name"), '[[:space:]]+', ' ', 'g')));--> statement-breakpoint

-- subscription_charges: the cycle index already stops a double renewal and,
-- now that first purchases carry a day-truncated period_start, a double
-- first purchase. Upgrades and packs were excluded entirely, so a retried
-- POST opened two payable charges for one decision. One PENDING charge per
-- target at a time: a second click meets the index and is handed the first
-- charge's reference, and a SETTLED charge blocks nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_charges_pending_upgrade_ux"
  ON "subscription_charges" ("business_id", "plan")
  WHERE "kind" = 'upgrade' AND "status" = 'pending';--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_charges_pending_pack_ux"
  ON "subscription_charges" ("business_id", "pack_id")
  WHERE "kind" = 'add_on' AND "status" = 'pending';
