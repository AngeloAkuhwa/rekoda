-- Evidence retention: legal holds and the sweep's sight lines (spec §23;
-- PR-011).
--
-- PR-003 gave evidence its clocks: resolutionState, resolutionDeadline,
-- resolvedAt, rawPurgedAt. This migration adds the one thing that may stop
-- them, and lets the sweep FIND what is due.

/* ── EvidenceLegalHold ────────────────────────────────────────────────────
 * "unless EvidenceLegalHold is active — dispute, investigation or tax audit
 * — which suspends the countdown and is the only thing that can" (§23).
 *
 * A hold is active while released_at IS NULL. Releasing is an UPDATE that
 * names who; deleting is nobody's, because a record that a hold existed is
 * part of the story of the dispute it protected.                            */
CREATE TABLE IF NOT EXISTS evidence_legal_holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  payment_evidence_id uuid NOT NULL REFERENCES payment_evidence(id),
  kind                text NOT NULL CHECK (kind IN ('dispute', 'investigation', 'tax_audit')),
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  placed_by           text NOT NULL CHECK (length(btrim(placed_by)) > 0),
  placed_at           timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  released_by         text,
  /* A release names itself, exactly as a manifest rollback does. */
  CONSTRAINT evidence_legal_holds_release_attributed
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX evidence_legal_holds_active_ix
  ON evidence_legal_holds (payment_evidence_id)
  WHERE released_at IS NULL;

ALTER TABLE evidence_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON evidence_legal_holds
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The usual 0001 default-privileges correction: a hold's history is not the
-- application's to erase.
REVOKE DELETE ON evidence_legal_holds FROM rekoda_app;
REVOKE DELETE ON evidence_legal_holds FROM rekoda_worker;

/* ── the sweep's discovery ────────────────────────────────────────────────
 * The same shape as ops_read_businesses (migration 0004): the worker may
 * SEE across tenants to find what is due, and mutates nothing here — every
 * write runs tenant-pinned on the app credential, so a compromised worker
 * can list but not touch.                                                   */
CREATE POLICY ops_read_payment_evidence ON payment_evidence
  FOR SELECT TO rekoda_worker USING (true);
CREATE POLICY ops_read_evidence_legal_holds ON evidence_legal_holds
  FOR SELECT TO rekoda_worker USING (true);
