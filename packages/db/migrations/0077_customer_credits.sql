-- The customer-credit subledger (spec §14.1; F1, PR-048).
--
-- ONE subledger: a credit is a balance the business owes a customer —
-- created by a credit note, created by an overpayment — and an unapplied
-- credit reduces NO invoice until it is explicitly applied. The
-- application rows are append-only from birth; §14.2's full-reversal
-- constraints (exact negation, one reversal, never reverse a reversal)
-- land with PR-049, and the columns they govern are already here so the
-- shape never migrates twice.

ALTER TABLE customers ADD CONSTRAINT customers_business_id_ux UNIQUE (business_id, id);

CREATE TABLE customer_credits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses (id),
  customer_id  uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency     char(3) NOT NULL DEFAULT 'NGN' CHECK (currency ~ '^[A-Z]{3}$'),
  /* What created the owing: credit_note | overpayment | ... The unique
   * makes a retried creator idempotent — one event, one credit. */
  source_type  text NOT NULL,
  source_id    text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer_credits_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT customer_credits_source_ux UNIQUE (business_id, source_type, source_id),
  CONSTRAINT customer_credits_customer_fk
    FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
);

CREATE INDEX customer_credits_customer_ix ON customer_credits (business_id, customer_id);

CREATE TABLE customer_credit_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses (id),
  customer_credit_id  uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  /* Positive applies; a §14.2 reversal row carries the exact negation. */
  amount_minor        bigint NOT NULL CHECK (amount_minor <> 0),
  currency            char(3) NOT NULL DEFAULT 'NGN' CHECK (currency ~ '^[A-Z]{3}$'),
  reversal_of_id      uuid REFERENCES customer_credit_applications (id),
  reason              text,
  source_type         text NOT NULL,
  source_id           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_applications_credit_fk
    FOREIGN KEY (business_id, customer_credit_id) REFERENCES customer_credits (business_id, id),
  CONSTRAINT credit_applications_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id)
);

CREATE INDEX credit_applications_credit_ix
  ON customer_credit_applications (business_id, customer_credit_id);

ALTER TABLE customer_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_credits
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE customer_credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credit_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_credit_applications
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* Append-only, both tables: what the business owes and how it was applied
 * is history. Corrections are new rows. */
REVOKE UPDATE, DELETE ON customer_credits FROM rekoda_app;
REVOKE UPDATE, DELETE ON customer_credits FROM rekoda_worker;
REVOKE UPDATE, DELETE ON customer_credit_applications FROM rekoda_app;
REVOKE UPDATE, DELETE ON customer_credit_applications FROM rekoda_worker;
