-- Group F, part two: the payment evidence chain (part one was 0141).
--
-- Five of the fourteen relationships that re-running the R1 audit's own
-- question against the finished schema turned up. They form the provenance
-- spine behind verify-before-book, and they are a chain two deep:
--
--   payment_evidence          what the merchant or the provider showed us
--     <- payments                    the money booked against it
--     <- payment_verifications       the finding that the evidence is good
--     <- evidence_legal_holds        the reason it must not be purged yet
--          payment_verifications
--            <- payment_verification_claims        what the finding asserts
--            <- payment_verification_revocations   why it was withdrawn
--
-- Every one of those edges said only that the parent exists. Nothing said
-- whose it was, so a payment could have been booked against another
-- merchant's evidence, a verification could have vouched for it, a legal hold
-- could have pinned another merchant's document past its retention date, and
-- a revocation could have withdrawn another merchant's finding.
--
-- The usual checks, run rather than assumed: business_id is NOT NULL on all
-- five children. `payments.payment_evidence_id` and
-- `payment_verifications.payment_evidence_id` are nullable, which is correct
-- and unchanged - not every payment arrives with evidence - so MATCH SIMPLE
-- skips those two only when the evidence itself is absent. The other three
-- reference columns are NOT NULL and are therefore always checked. Neither
-- parent exposed UNIQUE (business_id, id), so this adds both first,
-- additively. No existing row points across a tenant. NOT VALID then VALIDATE
-- here, and each weaker key dropped only after its stronger one is valid.
--
-- Order matters inside this file: payment_verifications is a child of
-- payment_evidence and the parent of claims and revocations, so its own
-- unique key has to exist before those two edges can reference it.
ALTER TABLE payment_evidence ADD CONSTRAINT payment_evidence_business_id_ux UNIQUE (business_id, id);
ALTER TABLE payment_verifications ADD CONSTRAINT payment_verifications_business_id_ux UNIQUE (business_id, id);

ALTER TABLE payments
  ADD CONSTRAINT payments_evidence_business_fk
  FOREIGN KEY (business_id, payment_evidence_id) REFERENCES payment_evidence (business_id, id) NOT VALID;
ALTER TABLE payments VALIDATE CONSTRAINT payments_evidence_business_fk;
ALTER TABLE payments DROP CONSTRAINT payments_payment_evidence_id_fkey;

ALTER TABLE payment_verifications
  ADD CONSTRAINT payment_verifications_evidence_business_fk
  FOREIGN KEY (business_id, payment_evidence_id) REFERENCES payment_evidence (business_id, id) NOT VALID;
ALTER TABLE payment_verifications VALIDATE CONSTRAINT payment_verifications_evidence_business_fk;
ALTER TABLE payment_verifications DROP CONSTRAINT payment_verifications_payment_evidence_id_fkey;

ALTER TABLE evidence_legal_holds
  ADD CONSTRAINT evidence_legal_holds_evidence_business_fk
  FOREIGN KEY (business_id, payment_evidence_id) REFERENCES payment_evidence (business_id, id) NOT VALID;
ALTER TABLE evidence_legal_holds VALIDATE CONSTRAINT evidence_legal_holds_evidence_business_fk;
ALTER TABLE evidence_legal_holds DROP CONSTRAINT evidence_legal_holds_payment_evidence_id_fkey;

ALTER TABLE payment_verification_claims
  ADD CONSTRAINT payment_verification_claims_verification_business_fk
  FOREIGN KEY (business_id, verification_id) REFERENCES payment_verifications (business_id, id) NOT VALID;
ALTER TABLE payment_verification_claims VALIDATE CONSTRAINT payment_verification_claims_verification_business_fk;
ALTER TABLE payment_verification_claims DROP CONSTRAINT payment_verification_claims_verification_id_fkey;

ALTER TABLE payment_verification_revocations
  ADD CONSTRAINT payment_verification_revocations_verification_business_fk
  FOREIGN KEY (business_id, verification_id) REFERENCES payment_verifications (business_id, id) NOT VALID;
ALTER TABLE payment_verification_revocations VALIDATE CONSTRAINT payment_verification_revocations_verification_business_fk;
ALTER TABLE payment_verification_revocations DROP CONSTRAINT payment_verification_revocations_verification_id_fkey;
