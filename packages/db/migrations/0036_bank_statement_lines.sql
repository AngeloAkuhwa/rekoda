-- What the merchant's bank says happened (ADR 0025 groundwork).
--
-- Rekoda's books are built from what a merchant told it. A bank statement is
-- the other side of that: what actually moved, according to somebody with no
-- reason to agree. Reconciliation is the comparison, and this is where the
-- bank's half lives until then.
--
-- Statement import rather than a bank feed, deliberately. A feed needs an
-- aggregator, a commercial agreement, and a third party standing between a
-- merchant and their bank data. Every Nigerian bank already emails a
-- statement, so the version that needs approval from nobody ships first.
--
-- `fingerprint` is what stops a re-upload duplicating everything. Merchants
-- re-upload constantly, usually with an overlap of a week or two, and without
-- a key each overlap doubles the lines and the reconciliation gets further
-- from the truth with every upload. It is computed in @rekoda/core, where it
-- can be tested, and it includes an occurrence number so that two genuinely
-- identical charges on one day both survive.
--
-- `narration` carries counterparty names, which is the whole reason a line
-- can be matched to an invoice at all. It is stored, shown to the merchant
-- who downloaded it, and never sent to a model. It is also covered by the
-- retention sweep without anybody remembering to add it: 0022 discovers
-- tables by their business_id column rather than from a list.
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  /* The day the bank posted it. A date, not a timestamp: a statement reports
   * days, and inventing a time would invite reading it as one. */
  posted_on date NOT NULL,
  /* Signed kobo. Positive is money INTO the account, the same convention the
   * parser produces, so no reader has to know which way a bank spelled it. */
  amount_k bigint NOT NULL,
  narration text NOT NULL DEFAULT '',
  bank_ref text,
  fingerprint text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_line_not_nothing CHECK (amount_k <> 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_lines_fingerprint_ux
  ON bank_statement_lines (business_id, fingerprint);
CREATE INDEX IF NOT EXISTS bank_lines_business_day_ix
  ON bank_statement_lines (business_id, posted_on);

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_statement_lines
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON bank_statement_lines TO rekoda_app;
GRANT SELECT, INSERT, DELETE ON bank_statement_lines TO rekoda_worker;

-- REVOKE, not a narrower GRANT.
--
-- 0001_rls.sql sets ALTER DEFAULT PRIVILEGES granting SELECT, INSERT, UPDATE
-- and DELETE on every table created afterwards, so a new table arrives with
-- UPDATE already granted and listing three verbs above adds nothing and takes
-- nothing away. The ledger has the same shape for the same reason. Without
-- these two lines the append-only rule below would read as enforced and would
-- not be.
--
-- No UPDATE, for the same reason the ledger has none. A statement line is
-- what the bank said; editing it would make the one independent record in the
-- system agree with the books by force, which is the opposite of its purpose.
-- DELETE stays, because a merchant who imported the wrong account's statement
-- has to be able to take it back out, and the retention sweep needs it.
REVOKE UPDATE ON bank_statement_lines FROM rekoda_app;
REVOKE UPDATE ON bank_statement_lines FROM rekoda_worker;
