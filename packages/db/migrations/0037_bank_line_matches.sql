-- Which statement line is which posting.
--
-- Its own table rather than columns on bank_statement_lines, and the reason
-- is the property 0036 established: a statement line is what the BANK said,
-- and the application holds no UPDATE on it. A match is not part of what the
-- bank said. It is Rekoda's assertion about it, made later, by a rule or by a
-- merchant, and revisable without touching the evidence.
--
-- The two unique indexes are the whole model. A statement line has at most
-- one posting and a posting has at most one line, so a reconciliation cannot
-- quietly explain the same money twice. Without them, a merchant matching by
-- hand after an automatic pass could point two lines at one posting and read
-- a difference of zero that means nothing.
--
-- No UPDATE for the application: a match is made or unmade, never edited into
-- a different match. Unmatching is a DELETE, which leaves the line and the
-- posting exactly as they were.
CREATE TABLE IF NOT EXISTS bank_line_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  line_id uuid NOT NULL REFERENCES bank_statement_lines(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  /* 'auto' when the rule was certain, 'manual' when a person decided. Kept
   * because "the computer did this" and "I did this" are different claims,
   * and a merchant reviewing a reconciliation needs to know which. */
  decided_by text NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_match_decided CHECK (decided_by IN ('auto', 'manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_match_line_ux ON bank_line_matches (business_id, line_id);
CREATE UNIQUE INDEX IF NOT EXISTS bank_match_tx_ux ON bank_line_matches (business_id, transaction_id);

ALTER TABLE bank_line_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_line_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_line_matches
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON bank_line_matches TO rekoda_app;
GRANT SELECT, INSERT, DELETE ON bank_line_matches TO rekoda_worker;

-- REVOKE, not a narrower GRANT. 0001_rls.sql sets default privileges granting
-- all four verbs on every table created after it, so listing three above adds
-- nothing and removes nothing. This is the lesson 0036 learned the hard way:
-- without these lines the rule in the comment reads as enforced and is not.
REVOKE UPDATE ON bank_line_matches FROM rekoda_app;
REVOKE UPDATE ON bank_line_matches FROM rekoda_worker;
