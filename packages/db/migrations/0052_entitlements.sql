-- Entitlements as data (PR-012, canonical spec §4.1).
--
-- Today the product boundary is a number: Integrate is "gated" by an orders
-- allowance of zero, so a Chat business is refused customer orders by the
-- meter rather than by a rule. That works until the first capability that
-- costs nothing to meter, and it puts the boundary in a table about volume
-- rather than a table about permission.
--
-- Two tables, and nothing reads them yet. The resolver and the command-layer
-- gate are PR-013; this PR only gives them somewhere to read from. Until BL2
-- makes plans data, effective entitlements stay derived from `businesses.plan`
-- and these rows record explicit grants alongside that derivation.
--
-- REKODA_COMPLETE is deliberately absent. Complete is the PAIR (spec §3.3),
-- and a single Complete row would make it possible to hold Complete while
-- holding neither half, which is a state the product does not have.

CREATE TABLE IF NOT EXISTS entitlements (
  key         text PRIMARY KEY
              CHECK (key IN ('REKODA_CHAT', 'REKODA_INTEGRATE', 'REKODA_API')),
  name        text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- No RLS: it is the same three rows for every tenant, and a policy keyed on
-- app.business_id would hide the catalogue from any code reading it outside a
-- pinned transaction.
--
-- But the application may never WRITE it. A service that can insert its own
-- entitlement key, or rename one, has no product boundary left to enforce.
-- Seeding and any future catalogue change belong to a migration.
REVOKE INSERT, UPDATE, DELETE ON entitlements FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON entitlements FROM rekoda_worker;

INSERT INTO entitlements (key, name, description) VALUES
  ('REKODA_CHAT', 'Rekoda Chat',
   'The merchant talks to Rekoda. Sales, expenses, purchases, receivables, '
   'inventory, reconciliation and reports, from their own messages.'),
  ('REKODA_INTEGRATE', 'Rekoda Integrate',
   'The merchant''s customers transact on the merchant''s own channels. '
   'Catalogue, cart, order, server-side validation, payment and receipt.'),
  ('REKODA_API', 'Rekoda API',
   'Programmatic access to the same application commands. A separate '
   'commercial entitlement, never included with Chat, Integrate or Complete.')
ON CONFLICT (key) DO NOTHING;

-- What a business actually holds, and why it holds it.
--
-- `source` matters at a downgrade: a grant that came from a PLAN goes when the
-- plan does, and a MANUAL_GRANT does not. Without it, a support-issued
-- entitlement would silently disappear at the next renewal sweep.
CREATE TABLE IF NOT EXISTS business_entitlements (
  business_id      uuid NOT NULL REFERENCES businesses(id),
  entitlement_key  text NOT NULL REFERENCES entitlements(key),
  source           text NOT NULL
                   CHECK (source IN ('PLAN', 'TRIAL', 'MANUAL_GRANT')),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  granted_by       text,
  PRIMARY KEY (business_id, entitlement_key)
);

ALTER TABLE business_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_entitlements
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

COMMENT ON TABLE entitlements IS
  'The entitlement catalogue (canonical spec §4.1). Reference data: the '
  'application reads it and may never write it. Complete is the pair of '
  'REKODA_CHAT and REKODA_INTEGRATE, never a row of its own.';
COMMENT ON TABLE business_entitlements IS
  'Explicit entitlement grants per business. Until BL2 makes plans data, '
  'effective entitlements are these grants together with what businesses.plan '
  'implies; the resolver that combines them is PR-013.';
