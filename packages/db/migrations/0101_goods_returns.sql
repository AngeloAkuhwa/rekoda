-- Purchase lifecycle and goods returns (spec §14.3, Appendix B.2/B.2a;
-- F2, PR-080).
--
-- Two things arrive together because the second cannot exist without
-- the first:
--
--   1. Every inventory movement now CARRIES THE UNIT COST applied to it
--      (Appendix B: "every movement carries the unit cost applied to
--      it, so gross profit reconstructs from the movements"). Until now
--      the cost of an outbound movement lived only in the product's
--      moving average at the moment of sale — and the customer-return
--      rule restores goods at the ORIGINAL ISSUE COST CARRIED ON THE
--      OUTBOUND MOVEMENT, which therefore has to be stored, not
--      remembered. Nullable, honestly: historical movements never
--      recorded one, and a reconstructed figure would be invented.
--
--   2. `goods_returns` — §14.3's GoodsReturn, with Appendix B.2a's
--      DISPOSITION deciding the accounting rather than being decided by
--      it. Physical quantity and financial value are different books:
--      only a RESALABLE return re-enters sellable stock (a movement),
--      and a zero-value return is never admitted just to make the
--      quantity balance. DAMAGED and QUARANTINED rows ARE the holding
--      location — a quantity with its value still an open question —
--      and SCRAPPED is gone, so a salvage value on it is
--      unrepresentable.

ALTER TABLE inventory_movements
  ADD COLUMN unit_cost_k bigint CHECK (unit_cost_k IS NULL OR unit_cost_k >= 0);

ALTER TABLE products
  ADD CONSTRAINT products_business_id_ux UNIQUE (business_id, id);

CREATE TABLE goods_returns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses(id),
  product_id             uuid NOT NULL,
  /* The sale the goods came back from, when the merchant named one. */
  invoice_id             uuid,
  quantity               integer NOT NULL CHECK (quantity > 0),
  disposition            text NOT NULL CHECK (disposition IN (
    'RESALABLE', 'DAMAGED', 'QUARANTINED', 'SCRAPPED'
  )),
  /* Per unit, from the outbound movement. Null when the original issue
   * was never costed — an honest unknown, never a reconstruction. */
  original_issue_cost_k  bigint CHECK (original_issue_cost_k IS NULL OR original_issue_cost_k >= 0),
  /* TOTAL supported value recovered on a damaged or quarantined return.
   * Null means no recoverable value was claimed. */
  salvage_value_k        bigint CHECK (salvage_value_k IS NULL OR salvage_value_k >= 0),
  /* The posting the disposition implied, when it implied one. */
  ledger_transaction_id  uuid,
  source_type            text NOT NULL,
  source_id              text,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT goods_returns_product_fk
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id),
  CONSTRAINT goods_returns_invoice_fk
    FOREIGN KEY (invoice_id) REFERENCES invoices (id),
  /* B.2a: a resalable return rejoins stock at cost — salvage is not a
   * concept it has; and SCRAPPED means no inventory value remains. */
  CONSTRAINT goods_returns_salvage_coherent CHECK (
    salvage_value_k IS NULL OR disposition IN ('DAMAGED', 'QUARANTINED')
  )
);

CREATE INDEX goods_returns_business_ix ON goods_returns (business_id, created_at);

ALTER TABLE goods_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goods_returns
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* A return is a fact about goods that came back. Corrections are new
 * facts, never edits. */
REVOKE UPDATE, DELETE ON goods_returns FROM rekoda_app;
REVOKE UPDATE, DELETE ON goods_returns FROM rekoda_worker;
