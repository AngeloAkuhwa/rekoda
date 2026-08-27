-- Catalogue synchronisation to the WABA (spec §3.2; W3, PR-086).
--
-- The merchant's catalogue lives in the products table and nowhere else.
-- What Meta's commerce catalog holds is a PROJECTION of it, pushed item by
-- item — and this table records exactly what was pushed, when, and whether
-- Meta took it, so the sync can diff instead of re-sending the world and a
-- failed item is a named fact rather than a silent gap. The customer's
-- message never sets a price precisely because the price Meta shows came
-- from THIS push, off the merchant's own rows.
--
-- Rows exist only for what a push ATTEMPTED: SYNCED with the figures Meta
-- accepted, or FAILED with Meta's stated reason (advisory prose for the
-- merchant's next edit — never parsed, never a routing input). Dirtiness
-- needs no flag: a product that disagrees with its synced row is dirty by
-- comparison, the same derived-never-stored rule everything else follows.
--
-- Production enablement waits on W0: nothing here contacts Meta. This is
-- the additive infrastructure the readiness ruling allows against test
-- numbers.

ALTER TABLE waba_connections
  ADD COLUMN catalogue_id text;

CREATE TABLE waba_catalogue_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES businesses(id),
  waba_connection_id   uuid NOT NULL REFERENCES waba_connections(id),
  product_id           uuid NOT NULL,
  -- The identity Meta knows the item by: our product id, stable for life.
  retailer_id          text NOT NULL,
  -- What Meta currently holds, verbatim: the projection's own record.
  synced_name          text NOT NULL,
  synced_price_k       bigint NOT NULL CHECK (synced_price_k >= 0),
  synced_availability  text NOT NULL CHECK (synced_availability IN ('in stock', 'out of stock')),
  status               text NOT NULL CHECK (status IN ('SYNCED', 'FAILED')),
  error                text,
  -- A failure has a reason and a success has none: no bare adjectives.
  CONSTRAINT waba_catalogue_items_error_coherent CHECK ((status = 'FAILED') = (error IS NOT NULL)),
  synced_at            timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Tenant-safe: an item cannot cite another tenant's product (the 0101
  -- composite unique on products makes this expressible).
  CONSTRAINT waba_catalogue_items_product_fk
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id),
  CONSTRAINT waba_catalogue_items_ux UNIQUE (business_id, waba_connection_id, product_id)
);

-- 0001 default-privileges trap: new tables grant themselves to nobody.
REVOKE ALL ON waba_catalogue_items FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON waba_catalogue_items TO rekoda_app;
-- The worker gets nothing: syncs run per business under the tenant pin.

ALTER TABLE waba_catalogue_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE waba_catalogue_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waba_catalogue_items
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
