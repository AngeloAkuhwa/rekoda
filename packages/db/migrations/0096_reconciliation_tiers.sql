-- Reconciliation tiers one to four (spec §22.1; B1, PR-074).
--
--   1  exact reference           deterministic, auto-matched
--   2  strong deterministic      auto-matched
--   3  suggested                 proposed to a human, NEVER applied
--   4  manual review             a person decides, with a reason recorded
--
-- A match row now says WHICH tier decided it, and the two §22.1 sentences
-- that carry the risk become constraints rather than intentions:
--
--   - "suggested … never applied": tier 3 is a kind of PROPOSAL, not a
--     kind of match, so a tier-3 row here is unrepresentable. Proposals
--     live in the reconcile output and on the review screen, not in this
--     table.
--   - "a person decides, with a reason recorded": a manual match without
--     its reason is unrepresentable. An auto match carries NO reason
--     column text — its tier is its reason, and a sentence there would be
--     a person's words on a computer's decision.
--
-- decided_by stays CHECK ('auto', 'manual') — there is no 'ai' value to
-- add, which is §22.1's other sentence made structural: AI can explain,
-- and only deterministic logic or an authorised human decides.

ALTER TABLE bank_line_matches
  ADD COLUMN tier smallint,
  ADD COLUMN reason text;

/* Every existing auto row was the amount-and-date rule (tier 2 is what
 * the estate's matcher has been since 0037); every manual row predates
 * the reason requirement, and its backfilled reason says exactly that
 * rather than inventing a rationale nobody gave. */
UPDATE bank_line_matches SET tier = CASE decided_by WHEN 'auto' THEN 2 ELSE 4 END;
UPDATE bank_line_matches SET reason = 'paired by hand before 0096 recorded reasons'
  WHERE decided_by = 'manual';

ALTER TABLE bank_line_matches
  ALTER COLUMN tier SET NOT NULL,
  ADD CONSTRAINT bank_match_tier CHECK (tier IN (1, 2, 4)),
  ADD CONSTRAINT bank_match_tier_coherent CHECK (
    (decided_by = 'auto' AND tier IN (1, 2) AND reason IS NULL)
    OR (decided_by = 'manual' AND tier = 4 AND reason IS NOT NULL)
  );
