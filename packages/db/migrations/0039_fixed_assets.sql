-- Things the business keeps and uses (ADR 0026).
--
-- A ₦450,000 generator recorded as an expense reports a loss the business did
-- not make, hides an asset it owns, and flatters every month afterwards. The
-- row is what lets the charge be spread across the months the thing is
-- actually used, and what a merchant reads when they ask what they own.
--
-- `useful_life_months` is asked, never inferred. A model deciding how long a
-- merchant's freezer lasts would be a model computing money, which the spec
-- forbids, and it would be wrong often enough to matter.
--
-- `months_charged` rather than a last-charged date: the arithmetic that keeps
-- an asset depreciating to EXACTLY its cost counts months, and a date would
-- have to be turned back into a count on every read. Counting once and storing
-- the count means a missed sweep is visible as a number that is behind rather
-- than as a gap nobody can see.
CREATE TABLE IF NOT EXISTS fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  description text NOT NULL,
  cost_k bigint NOT NULL CHECK (cost_k > 0),
  /* Whole months, at least one. Zero would divide by nothing. */
  useful_life_months integer NOT NULL CHECK (useful_life_months >= 1),
  /* How many months of wear have been charged so far. Never exceeds the life. */
  months_charged integer NOT NULL DEFAULT 0 CHECK (months_charged >= 0),
  bought_on date NOT NULL,
  /* The posting that put it on the balance sheet, so a withdrawal has
   * something exact to reverse. */
  ledger_transaction_id uuid REFERENCES ledger_transactions(id),
  /* recorded | withdrawn. A withdrawal marks the row and mirrors its posting,
   * exactly as a voided expense does. */
  status text NOT NULL DEFAULT 'recorded',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixed_asset_status CHECK (status IN ('recorded', 'withdrawn')),
  CONSTRAINT fixed_asset_life_not_exceeded CHECK (months_charged <= useful_life_months)
);

CREATE INDEX IF NOT EXISTS fixed_assets_business_ix ON fixed_assets (business_id, status);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_assets
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- "Whose equipment is due a month of wear" names no tenant, which is the
-- point: the sweep cannot pin a business it has not read yet. SELECT and
-- nothing else, so the reach this credential buys is the question, never the
-- answer. Same shape as `worker_due` on recurring_entries (0027), and the
-- REVOKE below is what makes it mean what it says.
CREATE POLICY worker_due ON fixed_assets
  FOR SELECT
  TO rekoda_worker
  USING (true);

-- UPDATE is kept here, unlike the append-only tables: `months_charged` and
-- `status` are both meant to change, and they are the only two that do. The
-- cost and the life are what the merchant said, and nothing in the codebase
-- writes them twice.
GRANT SELECT, INSERT, UPDATE ON fixed_assets TO rekoda_app;

-- DELETE is not granted to the application. A thing the business bought is a
-- fact; deciding it was never bought is a withdrawal, which the status column
-- records and the ledger reverses.
REVOKE DELETE ON fixed_assets FROM rekoda_app;

-- 0001 grants the worker everything on every table created afterwards. Taking
-- the writes back is what makes `worker_due` mean what it says: the charge and
-- the claim are both written under `rekoda_app`, pinned to one tenant.
REVOKE INSERT, UPDATE, DELETE ON fixed_assets FROM rekoda_worker;
