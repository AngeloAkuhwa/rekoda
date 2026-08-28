-- PlatformCostEvent (PR-102, canonical spec §29, decision COST-1).
--
-- Real money Rekoda spends gets an immutable fact. `usage_events` is
-- telemetry - mutable in practice, never designed as a financial record -
-- and the margin model must not stand on it forever. This is the
-- append-only platform-cost subledger BL2 consumes for unit economics:
-- revenue less messaging, AI inference, OCR, payment fees, bank feeds and
-- storage, per merchant, per plan, per cohort.
--
-- No second corporate general ledger inside the merchant product: this is
-- a subledger feeding a margin model, exportable later into Rekoda
-- Commerce Technologies Limited's own statutory books, which stay outside
-- the product for V1.

CREATE TABLE IF NOT EXISTS platform_cost_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,
  provider_product      text NOT NULL,
  -- Nullable, per the spec: some costs are not attributable to one
  -- merchant (hosting, a platform OTP, a global rate-limit probe).
  business_id           uuid REFERENCES businesses(id),
  payment_connection_id uuid REFERENCES payment_connections(id),
  payment_id            uuid REFERENCES payments(id),
  settlement_id         uuid REFERENCES settlements(id),
  cost_type             text NOT NULL CHECK (cost_type IN (
                          'MESSAGING', 'AI_INFERENCE', 'OCR', 'PAYMENT_FEE',
                          'BANK_FEED', 'STORAGE', 'TELEPHONY')),
  amount_minor          bigint NOT NULL CHECK (amount_minor >= 0),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_minor             bigint CHECK (tax_minor IS NULL OR tax_minor >= 0),
  -- The provider's own id for the charge; for a rate-card derivation, the
  -- deterministic internal key it derives from. With `provider` it is the
  -- idempotency spine: a retried writer meets the unique index and records
  -- one fact (the same property invariant 14 demands of journals).
  external_reference    text NOT NULL,
  incurred_at           timestamptz NOT NULL,
  source                text NOT NULL CHECK (source IN (
                          'PROVIDER_INVOICE', 'PROVIDER_API', 'DERIVED_FROM_RATE_CARD')),
  cost_schedule_id      uuid REFERENCES provider_cost_schedules(id),
  actual_or_estimated   text NOT NULL CHECK (actual_or_estimated IN ('ACTUAL', 'ESTIMATED')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_cost_events_reference_ux UNIQUE (provider, external_reference)
);

CREATE INDEX IF NOT EXISTS platform_cost_events_business_ix
  ON platform_cost_events (business_id, incurred_at);
CREATE INDEX IF NOT EXISTS platform_cost_events_type_ix
  ON platform_cost_events (cost_type, incurred_at);

-- Append-only. No UPDATE, no DELETE - for the application, as a database
-- property rather than a review hope (0001's default privileges grant
-- both, so each is revoked per role).
--
-- The app role also loses SELECT: costs are written from tenant-pinned
-- transactions (the AI call, the template send), but this table has no RLS
-- - business_id is nullable and the reader is the margin engine sweeping
-- every tenant - so the merchant-facing role gets to add facts and never
-- to read the platform's finances.
REVOKE SELECT, UPDATE, DELETE ON platform_cost_events FROM rekoda_app;
REVOKE UPDATE, DELETE ON platform_cost_events FROM rekoda_worker;

COMMENT ON TABLE platform_cost_events IS
  'Append-only platform-cost subledger (canonical spec §29, COST-1). Real '
  'money Rekoda spends, one immutable fact per charge; usage_events stays '
  'telemetry. No UPDATE, no DELETE.';
