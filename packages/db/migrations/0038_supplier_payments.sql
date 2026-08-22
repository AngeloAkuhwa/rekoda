-- Paying a supplier back.
--
-- A purchase on credit writes ACCOUNTS_PAYABLE and, until now, nothing could
-- clear it but a manual journal. That left two figures in the same product
-- disagreeing: `spendFor` reads the whole ACCOUNTS_PAYABLE balance and saw the
-- debt gone, while `payableAgeingFor` joins entries to the purchase's OWN
-- ledger transaction and saw it standing, ageing past ninety days, forever.
--
-- The row is what attributes a settlement to the purchase it settles. Without
-- it a payment is just a movement on a liability account and no amount of
-- arithmetic can say which debt it cleared.
--
-- Append-only, like every other financial record here: a payment made is a
-- fact, and correcting one is a second fact. There is no UPDATE for the
-- application, and a payment that should not have been recorded is reversed
-- by a journal rather than edited into a different amount.
CREATE TABLE IF NOT EXISTS supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  /* The purchase this settles. NOT nullable: a payment that cannot name what
   * it settles is exactly the ambiguity this table exists to remove. */
  expense_id uuid NOT NULL REFERENCES expenses(id),
  amount_k bigint NOT NULL CHECK (amount_k > 0),
  /* 'cash' or 'transfer', which decides whether CASH or BANK gave it up. */
  method text NOT NULL,
  /* The posting this wrote, so the money and the attribution cannot drift. */
  ledger_transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  paid_on date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_payment_method CHECK (method IN ('cash', 'transfer'))
);

CREATE INDEX IF NOT EXISTS supplier_payments_expense_ix
  ON supplier_payments (business_id, expense_id);

ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_payments
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT ON supplier_payments TO rekoda_app;
GRANT SELECT, INSERT ON supplier_payments TO rekoda_worker;

-- REVOKE, not a narrower GRANT. 0001_rls.sql sets default privileges granting
-- all four verbs on every table created after it, so the GRANT above adds
-- nothing and removes nothing. Without these lines the append-only rule in
-- the comment reads as enforced and is not (the lesson from 0036).
REVOKE UPDATE, DELETE ON supplier_payments FROM rekoda_app;
REVOKE UPDATE, DELETE ON supplier_payments FROM rekoda_worker;
