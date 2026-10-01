-- The G-61 funding-source question as a continuation (G-68 Phase 2).
--
-- "I bought 10 cartons for 180k, paid by POS" is asked where the money came
-- from (OWN-17: POS is a channel, the books need the account). Before this,
-- the merchant had to send the whole purchase again; a short "bank" or "cash"
-- arrived with nothing to attach to. 0154 could not represent that question:
-- its `expects` CHECK allows only 'period' and 'choice'. 0154 is applied and
-- immutable, so the widening is this migration.
--
-- A funding-source clarification points at the ONE retired (abandoned)
-- purchase draft that asked the question, by id, so the answer can rebuild
-- that purchase with the account filled in. It is never a path to execute
-- that draft: the answer builds a NEW command, shows a FRESH preview through
-- the ordinary gates, and a normal "yes" confirms the new draft. The retired
-- draft stays retired (G-61). Nothing else is stored: no amount, no words.

-- command_drafts had no (business_id, id) key to point a composite FK at
-- (the 0141 pattern: another tenant's draft must be unrepresentable).
ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_business_id_ux UNIQUE (business_id, id);

ALTER TABLE conversation_continuations ADD COLUMN draft_id uuid;

ALTER TABLE conversation_continuations
  ADD CONSTRAINT conversation_continuations_draft_business_fk
  FOREIGN KEY (business_id, draft_id) REFERENCES command_drafts (business_id, id);

ALTER TABLE conversation_continuations
  DROP CONSTRAINT conversation_continuations_expects_check;
ALTER TABLE conversation_continuations
  ADD CONSTRAINT conversation_continuations_expects_check
  CHECK (expects IN ('period', 'choice', 'funding_source'));

-- A funding-source question always names its draft and nothing else; no
-- other row names a draft. The 0154 shape rule is unchanged for the rest.
ALTER TABLE conversation_continuations
  ADD CONSTRAINT conversation_continuations_funding_shape_check CHECK (
    (expects IS NOT DISTINCT FROM 'funding_source') = (draft_id IS NOT NULL)
    AND (expects IS DISTINCT FROM 'funding_source' OR (topic IS NULL AND options IS NULL))
  );
