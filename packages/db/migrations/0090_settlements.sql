-- Provider settlement, modelled as the provider reports it (spec §20;
-- P2, PR-063).
--
-- Three tables, §20's three nouns: a Settlement is what the provider paid
-- out and when; SettlementItems are which payments it covered;
-- SettlementComponents are the SIGNED adjustments that explain the gap
-- between gross and net. Actual provider data drives the books — rate
-- cards estimate for checkout display (§19) and the cost model (§29),
-- never for authoritative postings — and this is the shape that actual
-- data lands in. Ingestion (PR-064) writes it; postings (PR-065) read it.

/* Items name the payments a payout covered, tenant-safely. */
ALTER TABLE payments
  ADD CONSTRAINT payments_business_id_ux UNIQUE (business_id, id);

CREATE TABLE settlements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses (id),
  payment_connection_id  uuid NOT NULL,
  /* The provider's own id for the payout. Connection-scoped, like every
   * provider identifier (§22.3) — never assumed globally unique. */
  provider_settlement_id text NOT NULL,
  status                 text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SETTLED', 'FAILED')),
  currency               text NOT NULL DEFAULT 'NGN',
  /* What the covered payments summed to, and what actually left the
   * provider. Both are the PROVIDER'S numbers, recorded as reported; the
   * components below explain the difference, and ingestion (PR-064)
   * refuses a report whose explanation does not add up rather than
   * storing an incoherent fact. */
  gross_k                bigint NOT NULL CHECK (gross_k >= 0),
  net_k                  bigint NOT NULL,
  settled_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settlements_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT settlements_connection_fk
    FOREIGN KEY (business_id, payment_connection_id)
    REFERENCES payment_connections (business_id, id),
  /* One payout, one row: the provider re-reporting a settlement is a
   * refresh of this row, never a second payout. */
  CONSTRAINT settlements_provider_ux
    UNIQUE (business_id, payment_connection_id, provider_settlement_id)
);

CREATE INDEX settlements_business_status_ix ON settlements (business_id, status);

CREATE TABLE settlement_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses (id),
  settlement_id  uuid NOT NULL,
  payment_id     uuid NOT NULL,
  amount_k       bigint NOT NULL CHECK (amount_k > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settlement_items_settlement_fk
    FOREIGN KEY (business_id, settlement_id)
    REFERENCES settlements (business_id, id),
  CONSTRAINT settlement_items_payment_fk
    FOREIGN KEY (business_id, payment_id)
    REFERENCES payments (business_id, id),
  /* A payment appears in a given payout once. It MAY appear in another
   * settlement — a reversal and a re-settlement are two payouts. */
  CONSTRAINT settlement_items_payment_ux
    UNIQUE (business_id, settlement_id, payment_id)
);

CREATE INDEX settlement_items_payment_ix ON settlement_items (business_id, payment_id);

CREATE TABLE settlement_components (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses (id),
  settlement_id  uuid NOT NULL,
  /* §20's vocabulary, verbatim and closed: a component the model cannot
   * name is a conversation with the provider, not a row. */
  kind           text NOT NULL CHECK (kind IN (
    'PROCESSING_FEE', 'VAT_ON_FEE', 'WITHHOLDING', 'LEVY',
    'RESERVE_HELD', 'RESERVE_RELEASED', 'REBATE', 'ADJUSTMENT',
    'CHARGEBACK')),
  /* SIGNED by direction, never by a negative amount: -₦500 of VAT reads
   * as a rebate to exactly the person who must not misread it. */
  direction      text NOT NULL CHECK (direction IN ('DEDUCTION', 'ADDITION')),
  amount_k       bigint NOT NULL CHECK (amount_k > 0),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settlement_components_settlement_fk
    FOREIGN KEY (business_id, settlement_id)
    REFERENCES settlements (business_id, id)
);

CREATE INDEX settlement_components_settlement_ix
  ON settlement_components (business_id, settlement_id);

ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlements
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_items
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE settlement_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_components
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* What the provider paid is a FACT: a settlement's status may resolve,
 * but nothing here is ever deleted, and items and components — the
 * covered payments and the signed explanation — never change at all. A
 * corrected report is a refreshed settlement whose detail rows are
 * re-derived by the ingestion that owns them (PR-064), under these same
 * constraints. */
REVOKE DELETE ON settlements FROM rekoda_app;
REVOKE DELETE ON settlements FROM rekoda_worker;
REVOKE UPDATE, DELETE ON settlement_items FROM rekoda_app;
REVOKE UPDATE, DELETE ON settlement_items FROM rekoda_worker;
REVOKE UPDATE, DELETE ON settlement_components FROM rekoda_app;
REVOKE UPDATE, DELETE ON settlement_components FROM rekoda_worker;
