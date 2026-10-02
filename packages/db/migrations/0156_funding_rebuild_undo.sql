-- An undone funding-answer rebuild, marked explicitly (G-68, Codex review).
--
-- A short "cash" to a G-61 funding question rebuilds the purchase as a NEW
-- draft and closes the question (abandoned -> superseded). When the rebuilt
-- preview's send fails, nobody saw it, so the rebuild is undone: the new
-- draft is superseded (never confirmable) and the question restored to
-- abandoned. The undone draft stays on the record (drafts are never
-- deleted), NEWER than the question it was rebuilt from.
--
-- An older question is never answerable once ANY newer purchase draft
-- exists, in any state: the newest question wins. The one exception is the
-- undone rebuild of that very question, and it must be told apart by a
-- fact, not inferred from a combination of states. This column is that
-- fact: set only by the undo, naming the question the undone draft was
-- rebuilt from, through a composite tenant key (the 0141 and 0155 pattern),
-- and only ever on a superseded draft.

ALTER TABLE command_drafts ADD COLUMN undone_rebuild_of uuid;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_undone_rebuild_business_fk
  FOREIGN KEY (business_id, undone_rebuild_of) REFERENCES command_drafts (business_id, id);

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_undone_rebuild_superseded_check
  CHECK (undone_rebuild_of IS NULL OR (state = 'superseded' AND undone_rebuild_of <> id));

-- The undo re-opens the short answer of EVERY member whose answer the
-- rebuild retired, each inside its own window, all from the one message
-- whose send failed. 0154 allowed one continuation per message in total;
-- one per message PER MEMBER is what the rule means (a message opens at
-- most one row for each member, and `openContinuation` replays by member
-- and message). Rows are never reopened: a fresh row is inserted.
DROP INDEX conversation_continuations_message_ux;
CREATE UNIQUE INDEX conversation_continuations_message_ux
  ON conversation_continuations (source_message_id, user_id);
