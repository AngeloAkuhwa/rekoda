-- TaxEvent (spec §13; F2, PR-079).
--
-- The record that a TAX POINT occurred: which code, on what basis, how
-- much, WHEN (occurred_at is the tax point, which is the §13 sentence —
-- not automatically the revenue-recognition moment), from which source
-- document, carried by which journal. Written by the SEPARATED tax
-- calculator; RevenueRecognitionEvent is written by the recognition
-- engine reading the same state, and the two never fuse.
--
-- APPEND-ONLY like every event table: a tax event is a fact about a
-- moment, and the §13 unique is the ledger-grade idempotency — a
-- retried issue cannot record the same point twice.
--
-- Deliberately NOT backfilled. Historical VAT truth lives in the ledger
-- (the VAT_PAYABLE credits every sale posting wrote); the basis those
-- documents were taxed on was never stored, and a reconstructed basis
-- would be an invented figure in an append-only table. Events record
-- tax points from this migration forward.

CREATE TABLE tax_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  tax_code_id    uuid NOT NULL,
  /* What was taxed and what it carried, integer minor units. */
  basis_minor    bigint NOT NULL CHECK (basis_minor >= 0),
  tax_minor      bigint NOT NULL CHECK (tax_minor >= 0),
  currency       text NOT NULL DEFAULT 'NGN',
  source_type    text NOT NULL,
  source_id      text NOT NULL,
  /* The TAX POINT (§13). */
  occurred_at    timestamptz NOT NULL,
  /* The posting that carried the tax to the books, when one did. */
  journal_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_events_code_fk
    FOREIGN KEY (business_id, tax_code_id) REFERENCES tax_codes (business_id, id),
  /* §13's exact key: one event per code per source. */
  CONSTRAINT tax_events_ux UNIQUE (business_id, tax_code_id, source_type, source_id)
);

CREATE INDEX tax_events_business_time_ix ON tax_events (business_id, occurred_at);

ALTER TABLE tax_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_events
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

REVOKE UPDATE, DELETE ON tax_events FROM rekoda_app;
REVOKE UPDATE, DELETE ON tax_events FROM rekoda_worker;
