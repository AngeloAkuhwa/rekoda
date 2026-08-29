-- FinancialAccountConnection and connection-scoped identity
-- (spec §18, §22.3; B1, PR-073).
--
-- The FEED side finally gets the entity the payment side has had since
-- 0010: a CONNECTION — this business, this provider, this linked
-- account, this standing. `bank_feed_connections` (0045) was the
-- one-per-business sketch of it, floating free of `financial_accounts`;
-- canonically the connection is what feeds ONE place money sits, so the
-- new table binds to `financial_accounts` with the composite FK shape
-- every scope column already uses, and the old table is backfilled from,
-- frozen below, and dropped when B1's surface lands.
--
-- §22.3 is the other half: "an identifier is scoped to the connection
-- that produced it unless the provider's documentation explicitly
-- guarantees global uniqueness". Settlements (0090) and payment attempts
-- (0081) already carry theirs; feed lines get theirs here —
-- `external_transaction_id`, unique per connection. The spec's key
-- reads (businessId, provider, financialAccountConnectionId,
-- externalTransactionId); the connection column PINS the provider, so
-- the constraint stores the same identity without repeating a fact a
-- JOIN already knows. ProviderEvent's row in that table arrives with the
-- ProviderEvent entity itself.

CREATE TABLE financial_account_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id),
  /* The one place money sits that this connection reads (0061). */
  financial_account_id  uuid NOT NULL,
  provider_type         text NOT NULL,
  /* The aggregator's opaque id for the linked account. Theirs, never shown. */
  external_account_id   text NOT NULL,
  bank_name             text NOT NULL DEFAULT '',
  account_last4         text NOT NULL DEFAULT '',
  /* linked | unlinked. Unlinked keeps the row: lapsed is not never-was. */
  status                text NOT NULL DEFAULT 'linked'
    CHECK (status IN ('linked', 'unlinked')),
  /* The last Lagos day a sync ran, so the next fetch knows where to start. */
  last_synced_on        date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  /* The composite target every child FK uses, so a line cannot cite a
   * connection belonging to another tenant. */
  CONSTRAINT financial_account_connections_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT financial_account_connections_account_fk
    FOREIGN KEY (business_id, financial_account_id)
    REFERENCES financial_accounts (business_id, id),
  /* One connection per place money sits. V1 has one bank account and so
   * one feed — the same rule 0045 spelled one-per-business, now stated
   * on the thing it is actually about. Re-linking is an update. */
  CONSTRAINT financial_account_connections_account_ux
    UNIQUE (business_id, financial_account_id),
  /* §22.3 for the connection itself: the provider's account id is scoped
   * to (business, provider), never assumed globally unique. */
  CONSTRAINT financial_account_connections_identity_ux
    UNIQUE (business_id, provider_type, external_account_id)
);

ALTER TABLE financial_account_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_account_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_account_connections
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* The background sweep lists linked feeds across tenants before pinning
 * each one. Same policy shape as 0019, 0048 and 0049; SELECT only. */
CREATE POLICY sweep_read_feed_connections ON financial_account_connections
  FOR SELECT
  TO rekoda_worker
  USING (true);

/* ── backfill from the 0045 sketch ────────────────────────────────────── */

/* Every business has exactly one 'bank' financial account (0062 seeded
 * the estate; seedChartOfAccounts births them since). The DISTINCT ON is
 * belt-and-braces against a hand-made second. */
INSERT INTO financial_account_connections
  (business_id, financial_account_id, provider_type, external_account_id,
   bank_name, account_last4, status, last_synced_on, created_at, updated_at)
SELECT bfc.business_id, fa.id, bfc.provider, bfc.account_ref,
       bfc.bank_name, bfc.account_last4, bfc.status, bfc.last_synced_on,
       bfc.created_at, bfc.updated_at
FROM bank_feed_connections bfc
JOIN LATERAL (
  SELECT id FROM financial_accounts
  WHERE business_id = bfc.business_id AND kind = 'bank'
  ORDER BY created_at
  LIMIT 1
) fa ON true;

/* The 0064-shape gate: a feed authorisation that did not map is a
 * migration that must not report success. */
DO $$
DECLARE unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped
  FROM bank_feed_connections bfc
  WHERE NOT EXISTS (
    SELECT 1 FROM financial_account_connections fac
    WHERE fac.business_id = bfc.business_id
      AND fac.external_account_id = bfc.account_ref
  );
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'financial_account_connections backfill left % bank_feed_connections rows unmapped', unmapped;
  END IF;
END $$;

/* Frozen, loudly: every reader and writer moves to the new table in the
 * same change, and a straggler fails here instead of writing state the
 * canonical table never sees. The drop lands with B1's surface PR. */
REVOKE INSERT, UPDATE, DELETE ON bank_feed_connections FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON bank_feed_connections FROM rekoda_worker;

/* ── §22.3 identity on the lines themselves ───────────────────────────── */

ALTER TABLE bank_statement_lines
  ADD COLUMN financial_account_connection_id uuid,
  ADD COLUMN external_transaction_id text;

ALTER TABLE bank_statement_lines
  ADD CONSTRAINT bank_lines_connection_fk
    FOREIGN KEY (business_id, financial_account_connection_id)
    REFERENCES financial_account_connections (business_id, id),
  /* An external id with no connection to scope it is exactly the
   * assumed-global identifier §22.3 exists to forbid. */
  ADD CONSTRAINT bank_lines_identity_coherent CHECK (
    external_transaction_id IS NULL OR financial_account_connection_id IS NOT NULL
  );

/* Partial: upload lines have neither and keep their fingerprint
 * identity; feed lines carry both and a provider id can land through one
 * connection exactly once. */
CREATE UNIQUE INDEX bank_lines_provider_identity_ux
  ON bank_statement_lines (business_id, financial_account_connection_id, external_transaction_id)
  WHERE financial_account_connection_id IS NOT NULL AND external_transaction_id IS NOT NULL;
