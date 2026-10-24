-- G-102 slice 2a (OWN-50): a lost Paystack checkout link is recoverable.
--
-- Paystack rejects a reference it has already seen, whether that checkout was
-- paid, failed or abandoned, so a checkout whose link was lost (the response
-- never reached Rekoda, or the merchant closed the tab) cannot be started again
-- under the same reference. Each provider checkout is therefore an ATTEMPT with
-- its own provider reference, and a charge has at most one live attempt.
--
--   attempt 1  provider reference = the charge's own reference (so every link and
--              event from before attempts existed still matches)
--   attempt n  provider reference = '<charge reference>-R<n>' (core: attemptReference)
--
-- The webhook path needs no lookup table: the charge is the provider reference
-- with the '-R<n>' suffix removed (core: chargeReferenceOf). This table carries
-- STATE only: which attempt is live, its link, and how it ended.
--
--   initializing  a request is calling Paystack, or died doing so
--   active        Paystack answered and the link is stored
--   ambiguous     the call failed or timed out: Paystack may or may not hold a session
--   superseded    replaced by a newer attempt after Paystack was asked about it
--   paid          the attempt that settled the charge
--   duplicate_paid  a second attempt was also paid; flagged for an operator refund
--   failed        Paystack reported the attempt dead (failed, abandoned, reversed)

-- A composite foreign key cannot name a child's charge without this: it is what
-- stops an attempt row from carrying one business's id and another's charge.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_business_id_ux
  ON subscription_charges (business_id, id);

CREATE TABLE IF NOT EXISTS subscription_charge_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id),
  charge_id          uuid NOT NULL,
  attempt_no         smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 20),
  provider_reference text NOT NULL,
  status             text NOT NULL DEFAULT 'initializing'
    CHECK (status IN ('initializing', 'active', 'ambiguous', 'superseded',
                      'paid', 'duplicate_paid', 'failed')),
  checkout_url       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_charge_attempts_charge_fk
    FOREIGN KEY (business_id, charge_id) REFERENCES subscription_charges (business_id, id)
);

-- One row per attempt number, and a provider reference is never reused.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charge_attempts_no_ux
  ON subscription_charge_attempts (charge_id, attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charge_attempts_ref_ux
  ON subscription_charge_attempts (provider_reference);

-- At most one LIVE attempt per charge: two concurrent requests, or a replacement
-- racing a retry, cannot leave two sessions both presented as the one to pay.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charge_attempts_live_ux
  ON subscription_charge_attempts (charge_id)
  WHERE status IN ('initializing', 'active', 'ambiguous');

ALTER TABLE subscription_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charge_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_charge_attempts
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON subscription_charge_attempts TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON subscription_charge_attempts TO rekoda_worker;

-- Never deleted: an attempt is the evidence of which session took the money.
REVOKE DELETE ON subscription_charge_attempts FROM rekoda_app;
REVOKE DELETE ON subscription_charge_attempts FROM rekoda_worker;

-- Charges initialised before attempts existed: their stored link is attempt 1.
INSERT INTO subscription_charge_attempts
  (business_id, charge_id, attempt_no, provider_reference, status, checkout_url, created_at)
SELECT c.business_id, c.id, 1, c.reference,
       CASE c.status WHEN 'pending' THEN 'active'
                     WHEN 'failed'  THEN 'failed'
                     ELSE 'paid' END,
       c.checkout_url,
       COALESCE(c.checkout_started_at, c.created_at)
FROM subscription_charges c
WHERE c.checkout_url IS NOT NULL
ON CONFLICT DO NOTHING;
