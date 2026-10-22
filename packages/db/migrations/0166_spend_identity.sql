-- G-87 (OWN-31, 22 Oct 2026): one real purchase must not become two
-- financial truths because one message was read as a stock purchase and
-- another as an expense. An EXPENSE draft may now be held for the identity
-- question, name the records its question is about, and be the fresh
-- preview a "separate" answer builds, exactly as a purchase draft can since
-- 0158. Only the two spend intents: no other draft carries these columns.
ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_separate_from_check;
ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_separate_from_check
  CHECK (separate_from IS NULL
         OR (intent IN ('RecordPurchase', 'RecordExpense') AND separate_from <> id));

ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_asked_about_check;
ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_asked_about_check
  CHECK ((asked_about_drafts IS NULL AND asked_about_expenses IS NULL)
         OR intent IN ('RecordPurchase', 'RecordExpense'));
