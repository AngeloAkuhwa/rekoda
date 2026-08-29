-- Chargebacks (spec §21; P2, PR-066).
--
-- A chargeback is the provider taking money back. WHAT it does to the
-- books depends on WHERE the money was: before settlement the clearing
-- account reverses (§21.1); after settlement the money is gone and the
-- merchant OWES THE PROVIDER — a LIABILITY on the connection's
-- chargeback-payable account (2150, provisioned by PR-053), never a
-- second receivable. CHARGEBACK_RECEIVABLE is SUPERSEDED by the spec in
-- those words: crediting a receivable asserts that a second party owes
-- the merchant money, which is the opposite of what a chargeback creates.

CREATE TABLE chargebacks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES businesses (id),
  payment_connection_id    uuid NOT NULL,
  payment_id               uuid NOT NULL,
  /* The provider's own id for the dispute. Connection-scoped (§22.3). */
  provider_chargeback_id   text NOT NULL,
  amount_k                 bigint NOT NULL CHECK (amount_k > 0),
  /* WHERE the money was when the provider took it back — decided from
   * the payment's settlement state at record time, because the posting
   * each timing demands is different (§21.1 vs §21.2). */
  timing                   text NOT NULL CHECK (timing IN ('PRE_SETTLEMENT', 'POST_SETTLEMENT')),
  /* How it resolved. CLEARING_REVERSAL is §21.1's pre-settlement shape —
   * the money never left the provider, so the reversal IS the resolution.
   * SETTLEMENT_DEDUCTION and BANK_DEBIT are §21.2's two recovery shapes
   * for money that had already settled; null while the payable stands. */
  recovered_via            text
    CHECK (recovered_via IS NULL
      OR recovered_via IN ('CLEARING_REVERSAL', 'SETTLEMENT_DEDUCTION', 'BANK_DEBIT')),
  status                   text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'RECOVERED')),
  reason                   text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chargebacks_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT chargebacks_connection_fk
    FOREIGN KEY (business_id, payment_connection_id)
    REFERENCES payment_connections (business_id, id),
  CONSTRAINT chargebacks_payment_fk
    FOREIGN KEY (business_id, payment_id)
    REFERENCES payments (business_id, id),
  /* One dispute, one row: the provider re-notifying is a refresh. */
  CONSTRAINT chargebacks_provider_ux
    UNIQUE (business_id, payment_connection_id, provider_chargeback_id),
  /* A recovered chargeback says HOW; an open one says nothing yet. */
  CONSTRAINT chargebacks_recovery_coherent CHECK (
    (status = 'OPEN' AND recovered_via IS NULL)
    OR (status = 'RECOVERED' AND recovered_via IS NOT NULL)
  )
);

CREATE INDEX chargebacks_business_status_ix ON chargebacks (business_id, status);
CREATE INDEX chargebacks_payment_ix ON chargebacks (business_id, payment_id);

ALTER TABLE chargebacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chargebacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chargebacks
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* §31 invariant 9: chargebacks preserve history. The status resolves;
 * the dispute never disappears. */
REVOKE DELETE ON chargebacks FROM rekoda_app;
REVOKE DELETE ON chargebacks FROM rekoda_worker;
