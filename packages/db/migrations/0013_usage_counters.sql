-- The usage meter (docs/metering-v1.md). One row per business, per Lagos
-- calendar month, per unit. `used` moves only through the atomic
-- check-and-increment in repos/usage.ts; `bonus` is credited only by a
-- verified Rekoda.Billing top-up (M4) and exists now so the counter
-- arithmetic never has to change shape.

CREATE TABLE IF NOT EXISTS usage_counters (
  business_id  uuid NOT NULL REFERENCES businesses(id),
  period       char(7) NOT NULL,  -- 'YYYY-MM', Africa/Lagos
  unit         text NOT NULL CHECK (unit IN (
    'messages', 'voice_seconds', 'documents', 'documents_understood', 'orders')),
  used         integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  bonus        integer NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, period, unit)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_counters
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
