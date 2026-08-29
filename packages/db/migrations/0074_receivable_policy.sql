-- ReceivableRecognitionPolicy, persisted (spec §12.3, §12.5; F1, PR-044).
--
-- §12.5's four words, each load-bearing:
--   versioned         rows, never a mutable column — every policy the
--                     business ever held stays on file
--   forward-looking   a row takes effect from its date onward; the repo
--                     refuses to backdate one, and resolution is BY DATE,
--                     so historical accounting never changes because a
--                     policy changed later
--   privileged        no runtime surface writes this yet; when one
--                     arrives it goes through the command bus (Appendix D:
--                     posting-policy changes are HIGH_RISK)
--   audited           the repo writes the audit event beside the row
--
-- Append-only: UPDATE and DELETE revoked from both runtime roles. A wrong
-- policy is corrected by a new row from today, exactly like the ledger it
-- governs. Absence means ON_ISSUE_UNCONDITIONAL — the behaviour every
-- business has had since the first invoice posted a receivable.

CREATE TABLE receivable_recognition_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses (id),
  policy         text NOT NULL CHECK (policy IN ('ON_ISSUE_UNCONDITIONAL', 'ON_FULFILMENT', 'NONE')),
  /* Lagos date the policy applies from. */
  effective_from date NOT NULL,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT receivable_policies_one_per_day UNIQUE (business_id, effective_from)
);

CREATE INDEX receivable_policies_lookup_ix
  ON receivable_recognition_policies (business_id, effective_from DESC);

ALTER TABLE receivable_recognition_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_recognition_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receivable_recognition_policies
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

REVOKE UPDATE, DELETE ON receivable_recognition_policies FROM rekoda_app;
REVOKE UPDATE, DELETE ON receivable_recognition_policies FROM rekoda_worker;
