-- Costs that arrive whether or not anybody mentions them (MASTER-PLAN §5.3.7).
--
-- Rent, salaries, the generator service contract, the shop's own data plan.
-- Every one of them lands on the same day each month and none of them send a
-- WhatsApp message, so until now the only route into the books was a merchant
-- remembering to dictate them. That fails hardest in the months a shop is
-- busiest, which is exactly when a wrong cost figure does the most damage: the
-- books show the takings of a good month against the expenses of a quiet one.
--
-- ── a schedule is not a document ────────────────────────────────────────────
--
-- This table is a working row, not an append-only record: it is paused,
-- restarted, retired, and claimed by the sweep. What it PRODUCES is the
-- permanent thing, and an entry it raises is an ordinary expense with an
-- ordinary posting that can be withdrawn like any other. Deleting a schedule
-- never touches an entry it already raised.
--
-- ── how it cannot pay twice ─────────────────────────────────────────────────
--
-- `last_raised_on` plus a conditional UPDATE is the whole mutual exclusion.
-- The sweep claims a row by writing today's date under a WHERE that only
-- matches while it is still unclaimed, in the same transaction as the expense
-- it raises. Two sweeps racing means one UPDATE matches and the other sees a
-- row that has moved on; a sweep that crashes after claiming rolls the claim
-- back with the entry, so nothing is silently skipped either.
CREATE TABLE IF NOT EXISTS recurring_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  description   text NOT NULL,
  category      text,
  amount_k      bigint NOT NULL CHECK (amount_k > 0),
  method        text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'transfer')),
  -- The day of the month the merchant CHOSE, kept whole. A schedule anchored
  -- on the 31st falls on 28 February and returns to 31 March, which it can
  -- only do if the clamped date never overwrites the anchor.
  anchor_day    integer NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  -- A calendar day, not an instant. "The 1st" means the 1st in Lagos, and a
  -- timestamp would make that a question about the hour the sweep ran.
  next_due_on   date NOT NULL,
  last_raised_on date,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The register's own query: every schedule a merchant has, newest first.
CREATE INDEX IF NOT EXISTS recurring_business_ix ON recurring_entries (business_id, created_at);

-- The sweep's query. Partial, because a paused schedule is never due and the
-- table it scans grows with every merchant who ever set one up.
CREATE INDEX IF NOT EXISTS recurring_due_ix
  ON recurring_entries (next_due_on)
  WHERE active;

ALTER TABLE recurring_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON recurring_entries
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- "Whose rent is due today" names no tenant, which is the point: the sweep
-- cannot pin a business it has not read yet. SELECT and nothing else, so the
-- reach the worker credential buys is the question, never the answer.
CREATE POLICY worker_due ON recurring_entries
  FOR SELECT
  TO rekoda_worker
  USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_entries TO rekoda_app;
-- 0004 grants the worker everything on every new table by default. Taking the
-- writes back is what makes the policy above mean what it says: the entry and
-- the claim are both written under `rekoda_app`, pinned to one tenant.
REVOKE INSERT, UPDATE, DELETE ON recurring_entries FROM rekoda_worker;
