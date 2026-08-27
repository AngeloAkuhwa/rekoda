-- PaymentCharge (spec §19.1; P1, PR-057).
--
-- A breakdown where every line is a RECORD, and where the taxable base is
-- STATED rather than inferred from the arithmetic: each charge carries its
-- own tax code (nullable — whether a charge sits in the base is a
-- configuration decision, not a property of the concept), who benefits,
-- and who economically bears it. A customer surcharge is
-- CONFIGURATION-GATED, never derived: in several markets it is regulated
-- or prohibited, and Rekoda must never add a charge a merchant did not
-- choose to add — the core builder enforces that gate; this table records
-- what was chosen.

CREATE TABLE payment_charges (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                uuid NOT NULL REFERENCES businesses (id),
  order_id                   uuid NOT NULL,
  type                       text NOT NULL
    CHECK (type IN ('PAYMENT_PROCESSING', 'DELIVERY', 'SERVICE', 'SURCHARGE')),
  /* What the customer reads. Honest, not "convenience fee". */
  label                      text NOT NULL CHECK (length(label) > 0),
  amount_minor               bigint NOT NULL CHECK (amount_minor >= 0),
  currency                   char(3) NOT NULL DEFAULT 'NGN' CHECK (currency ~ '^[A-Z]{3}$'),
  beneficiary                text NOT NULL
    CHECK (beneficiary IN ('MERCHANT', 'REKODA', 'PROVIDER')),
  economic_bearer            text NOT NULL
    CHECK (economic_bearer IN ('MERCHANT', 'CUSTOMER', 'REKODA', 'SHARED')),
  /* Nullable: whether this line sits in the taxable base is configuration. */
  tax_code                   text,
  actual_or_estimated        text NOT NULL DEFAULT 'ESTIMATED'
    CHECK (actual_or_estimated IN ('ESTIMATED', 'ACTUAL')),
  /* What the estimate came from. The ProviderCostSchedule table arrives
   * with the cost-model slice; a reference today, an FK then. */
  provider_cost_schedule_id  uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_charges_order_fk
    FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id)
);

CREATE INDEX payment_charges_order_ix ON payment_charges (business_id, order_id);

ALTER TABLE payment_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_charges
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* A line the customer read is a record: an estimate RESOLVES to actual,
 * nothing disappears. */
REVOKE DELETE ON payment_charges FROM rekoda_app;
REVOKE DELETE ON payment_charges FROM rekoda_worker;
