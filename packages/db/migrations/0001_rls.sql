-- Row-Level Security: the second line of tenant defence (ADR 0001, spec §40).
--
-- The application connects as `rekoda_app` — NOT the table owner, no
-- BYPASSRLS — so these policies apply to every query it runs. The tenant is
-- pinned per-transaction via  SELECT set_config('app.business_id', $1, true)
-- (see packages/db/src/client.ts withBusiness()). A query that forgets its
-- WHERE clause returns zero rows, never another tenant's ledger.
--
-- current_setting(..., true) returns NULL when unset → nullif guards make
-- an unpinned transaction see nothing rather than everything.

-- Application role (idempotent; password is set by ops, never in migrations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rekoda_app') THEN
    CREATE ROLE rekoda_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO rekoda_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rekoda_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rekoda_app;

-- Append-only tables: the app may never rewrite history.
REVOKE UPDATE, DELETE ON audit_events FROM rekoda_app;
REVOKE UPDATE, DELETE ON ledger_entries FROM rekoda_app;
REVOKE UPDATE, DELETE ON inventory_movements FROM rekoda_app;

-- ── tenant-scoped tables ────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'business_connections',
    'customers', 'customer_identities',
    'products', 'inventory_movements', 'suppliers', 'orders', 'order_items',
    'invoices', 'invoice_items', 'payments', 'payment_allocations',
    'receipts', 'expenses',
    'ledger_transactions', 'ledger_entries', 'reconciliations',
    'conversations', 'conversation_messages',
    'documents', 'doc_counters', 'audit_events', 'usage_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)
         WITH CHECK (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- businesses: a transaction may see only its own pinned tenant row.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON businesses
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Cross-tenant-by-nature tables (auth + ingress happen before a tenant is
-- known). RLS intentionally NOT enabled: users, otp_challenges, magic_links,
-- sessions, external_events. They contain no business financial data; access
-- is constrained by the auth/ingress modules and covered by integration tests.
