-- The Payment Hub's foundation (docs/payments-v1.md §3–9): connections and
-- intents. Payments themselves already exist (0000_init) and gain their
-- gross/fee/settlement breakdown in the webhook-processing slice, where those
-- columns get their first writer.

CREATE TABLE IF NOT EXISTS payment_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                uuid NOT NULL REFERENCES businesses(id),
  provider_type              text NOT NULL,
  external_merchant_id       text,
  external_subaccount_id     text,
  settlement_bank_code       text,
  -- The full account number exists ONLY as a vault blob (AES-256-GCM);
  -- last4 is what surfaces render as "GTBank •••• 4821" without a decrypt.
  settlement_account_cipher  text,
  settlement_account_last4   text,
  settlement_account_name    text,
  status                     text NOT NULL DEFAULT 'pending_details'
    CHECK (status IN (
      'not_configured', 'pending_details', 'pending_provider_creation',
      'pending_kyc', 'pending_settlement_verification',
      'active', 'suspended', 'failed', 'disconnected')),
  kyc_status                 text NOT NULL DEFAULT 'pending',
  capabilities               jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- One connection per provider per business. Reconnecting is an UPDATE with a
-- state transition, not a second row — two rows would mean two settlement
-- destinations for one provider and nobody able to say which is live.
CREATE UNIQUE INDEX IF NOT EXISTS payment_connections_business_provider_ux
  ON payment_connections (business_id, provider_type);

ALTER TABLE payment_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_connections
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS payment_intents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses(id),
  customer_id            uuid REFERENCES customers(id),
  order_id               uuid REFERENCES orders(id),
  invoice_id             uuid REFERENCES invoices(id),
  provider_type          text NOT NULL,
  payment_connection_id  uuid REFERENCES payment_connections(id),
  reference              text NOT NULL,
  expected_amount_k      bigint NOT NULL CHECK (expected_amount_k > 0),
  currency               text NOT NULL DEFAULT 'NGN',
  method_preference      text NOT NULL DEFAULT 'bank_transfer',
  provider_reference     text,
  provider_checkout_ref  text,
  status                 text NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created', 'awaiting_provider', 'awaiting_customer', 'processing',
      'succeeded', 'failed', 'expired', 'cancelled')),
  expires_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- GLOBALLY unique, deliberately not scoped by business: the reference is what
-- an incoming transfer is matched BY, before its tenant is known. A
-- per-business uniqueness would make that lookup circular (payments-v1 §9).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_reference_ux
  ON payment_intents (reference);

-- A provider's own reference maps to at most one intent per provider.
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_ref_ux
  ON payment_intents (provider_type, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_intents_business_status_ix
  ON payment_intents (business_id, status);
CREATE INDEX IF NOT EXISTS payment_intents_invoice_ix
  ON payment_intents (invoice_id);

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_intents
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The worker may RESOLVE any intent by reference, because resolution is
-- inherently pre-tenant: a webhook names a reference, and which business that
-- reference belongs to is the answer, not the input. Same reasoning — and the
-- same narrow shape — as `worker_claim` on jobs (0004): one extra policy, one
-- role, SELECT only. The API role stays fully tenant-scoped, so a request
-- handler cannot read another tenant's intents no matter what it is asked.
CREATE POLICY worker_resolve ON payment_intents
  FOR SELECT
  TO rekoda_worker
  USING (true);

GRANT SELECT, INSERT, UPDATE ON payment_connections, payment_intents TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON payment_connections, payment_intents TO rekoda_worker;
