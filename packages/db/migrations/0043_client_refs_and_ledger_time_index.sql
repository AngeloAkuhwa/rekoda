-- Client idempotency keys for the owner-side ledger writes (FIX-PLAN-2 B4).
--
-- The dashboard's payment form already carries a one-shot key the database
-- enforces (payments_rekoda_reference_ux); the other five money-shaped writes
-- did not, so a double-click or a retried POST booked twice. Each write's
-- own table takes the key, nullable because chat and sweeps write these rows
-- too and their idempotency lives elsewhere (event ids, singleton jobs,
-- schedule claims). Partial unique, same as every one-shot key here: NULLs
-- never collide, so only requests that BROUGHT a key are held to it.
ALTER TABLE "ledger_transactions" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_tx_client_ref_ux"
  ON "ledger_transactions" ("business_id", "client_ref")
  WHERE "client_ref" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_notes_client_ref_ux"
  ON "credit_notes" ("business_id", "client_ref")
  WHERE "client_ref" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fixed_assets_client_ref_ux"
  ON "fixed_assets" ("business_id", "client_ref")
  WHERE "client_ref" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_payments_client_ref_ux"
  ON "supplier_payments" ("business_id", "client_ref")
  WHERE "client_ref" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "recurring_entries" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recurring_client_ref_ux"
  ON "recurring_entries" ("business_id", "client_ref")
  WHERE "client_ref" IS NOT NULL;--> statement-breakpoint

-- The overview cards and the cashflow chart both read one business's ledger
-- entries by a created_at window with the account only inside FILTER
-- clauses, a shape no existing index serves: (business_id, account, ...)
-- indexes need the account pinned, so every dashboard load walked the
-- business's whole ledger. This is the index those two reads describe.
CREATE INDEX IF NOT EXISTS "ledger_entries_business_created_ix"
  ON "ledger_entries" ("business_id", "created_at");
