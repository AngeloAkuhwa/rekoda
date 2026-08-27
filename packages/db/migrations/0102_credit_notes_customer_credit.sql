-- Credit notes onto CustomerCredit (spec §14.1; F2, PR-081).
--
-- "Credit notes create customer credits. An unapplied credit reduces no
-- invoice until it is explicitly applied." From this migration forward
-- the credit-note flow grants a CustomerCredit and posts the liability
-- to 2300 — the negative-receivable design is SUPERSEDED. Posted history
-- is not rewritten: journals are immutable, and the old postings were
-- balanced when they were made.
--
-- The one schema change: §13's tax events learn to carry a REVERSAL.
-- A credit note gives VAT back, and its tax event is the same fact with
-- the sign turned — so the non-negative CHECKs become a sign-coherence
-- CHECK: basis and tax point the same way, never opposite ways.

ALTER TABLE tax_events
  DROP CONSTRAINT tax_events_basis_minor_check,
  DROP CONSTRAINT tax_events_tax_minor_check;

ALTER TABLE tax_events
  ADD CONSTRAINT tax_events_sign_coherent CHECK (
    (basis_minor >= 0 AND tax_minor >= 0) OR (basis_minor <= 0 AND tax_minor <= 0)
  );
