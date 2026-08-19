-- The verified-payment breakdown (docs/payments-v1.md §14–17), landing with
-- its first writer: the webhook-processing job. Every column is nullable
-- because the table already holds merchant-RECORDED payments (ADR 0014) that
-- have none of this — a recorded cash payment has no provider, no fee and no
-- settlement, and inventing zeros for it would blur the one distinction the
-- fake-alert defence rests on.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS gross_amount_k       bigint;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_fee_k       bigint;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS platform_fee_k       bigint;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_amount_k  bigint;
-- The RKD-PAY reference this payment settled. The provider's own reference
-- already lives in provider_ref (unique per business since 0000).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS rekoda_reference     text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_type        text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_intent_id    uuid REFERENCES payment_intents(id);
-- The provider's native status verbatim, for audit; Rekoda's own status is
-- judged, never copied (§17).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_status      text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status               text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS settlement_status    text;

ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (
  status IS NULL OR status IN (
    'pending', 'processing', 'confirmed', 'failed',
    'reversed', 'refunded', 'partially_refunded'));

ALTER TABLE payments ADD CONSTRAINT payments_settlement_status_check CHECK (
  settlement_status IS NULL OR settlement_status IN (
    'not_applicable', 'pending', 'processing', 'settled', 'failed', 'held'));

-- One verified payment per Rekoda reference per business. An intent goes
-- terminal on its first confirmation, so a second transfer against the same
-- reference is an exception a human resolves — never a second row here.
CREATE UNIQUE INDEX IF NOT EXISTS payments_rekoda_reference_ux
  ON payments (business_id, rekoda_reference)
  WHERE rekoda_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_intent_ix
  ON payments (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- Who bears the provider's fee is a per-connection commercial choice
-- (§14: configurable, never hard-coded). Merchant-bearing is the default
-- because it is what a plain Paystack subaccount does when nobody arranges
-- anything else: the fee comes out of settlement.
ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS fee_policy text
  NOT NULL DEFAULT 'merchant_bearing'
  CHECK (fee_policy IN ('customer_bearing', 'merchant_bearing', 'platform_bearing'));
