-- Refund and PaymentReversal, kept DISTINCT (spec §6.1, §9.3, §21; P2,
-- PR-067 — the slice's last PR).
--
-- §6.1's vocabulary is the design: a Refund is money returned
-- DELIBERATELY (it leaves the bank or the till, on the day it actually
-- happens); a PaymentReversal is a payment UNDONE BEFORE SETTLEMENT (the
-- money never left the provider, so the clearing account gives it back);
-- a Chargeback is money TAKEN back after settlement (0091). Three
-- records, three postings, three purposes — collapsing any two is how
-- "verification revoked ≠ payment reversed ≠ refund ≠ chargeback" stops
-- being true.

CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES businesses (id),
  payment_id           uuid NOT NULL,
  amount_k             bigint NOT NULL CHECK (amount_k > 0),
  /* bank | cash — where the money physically left from. */
  method               text NOT NULL CHECK (method IN ('bank', 'cash')),
  /* The provider's id where the provider executed it; connection-scoped
   * uniqueness is not needed here because a refund may also be a manual
   * bank transfer with no provider involved. */
  provider_refund_id   text,
  /* Money returned deliberately has a WHY, always. */
  reason               text NOT NULL,
  actor                text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refunds_payment_fk
    FOREIGN KEY (business_id, payment_id)
    REFERENCES payments (business_id, id)
);

CREATE INDEX refunds_payment_ix ON refunds (business_id, payment_id);
CREATE UNIQUE INDEX refunds_provider_ux
  ON refunds (business_id, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

CREATE TABLE payment_reversals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses (id),
  payment_id             uuid NOT NULL,
  payment_connection_id  uuid NOT NULL,
  amount_k               bigint NOT NULL CHECK (amount_k > 0),
  provider_reversal_id   text,
  reason                 text NOT NULL,
  actor                  text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_reversals_payment_fk
    FOREIGN KEY (business_id, payment_id)
    REFERENCES payments (business_id, id),
  CONSTRAINT payment_reversals_connection_fk
    FOREIGN KEY (business_id, payment_connection_id)
    REFERENCES payment_connections (business_id, id),
  /* A payment is UNDONE once, whole (§9.3's full-reversal-once rule,
   * applied to the payment): a partial change of mind is a refund. */
  CONSTRAINT payment_reversals_payment_ux UNIQUE (business_id, payment_id)
);

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refunds
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE payment_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_reversals
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* §31 invariant 9: refunds and reversals preserve history. Both are
 * FACTS the moment they exist — nothing edits or deletes them. */
REVOKE UPDATE, DELETE ON refunds FROM rekoda_app;
REVOKE UPDATE, DELETE ON refunds FROM rekoda_worker;
REVOKE UPDATE, DELETE ON payment_reversals FROM rekoda_app;
REVOKE UPDATE, DELETE ON payment_reversals FROM rekoda_worker;
