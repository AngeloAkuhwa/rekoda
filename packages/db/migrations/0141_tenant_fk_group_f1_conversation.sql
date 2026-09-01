-- Group F, part one: the conversation thread.
--
-- Ruling 1's thirty-four were closed in 0132 through 0140. Re-running that
-- audit's own question against the finished schema found FOURTEEN more
-- relationships of exactly the same shape that the original enumeration
-- missed: a single-column foreign key from a tenant-owned child to a
-- tenant-owned parent, with no composite beside it. They are being closed in
-- five migrations, by concern, on the same terms as A through E.
--
-- This one is the chat spine, and it is a chain: a message belongs to a
-- thread, and a command draft belongs to the message that proposed it. Both
-- edges said only that the parent exists. Nothing said whose it was, so a
-- message could have been filed under another merchant's conversation and a
-- draft under another merchant's message. That is the transcript a merchant
-- reads and the draft they are asked to confirm before money moves.
--
-- The usual checks, run rather than assumed: business_id is NOT NULL on both
-- children AND both reference columns are NOT NULL, so these constraints are
-- always checked, never skipped. Neither parent exposed UNIQUE
-- (business_id, id), so this adds both first; that is additive and is the key
-- every other parent in this schema already exposes. No existing row points
-- across a tenant. NOT VALID then VALIDATE here, and the weaker key dropped
-- only after the stronger one is valid.
--
-- Order matters inside this file: conversation_messages is a child of
-- conversations and the parent of command_drafts, so its own unique key has
-- to exist before the draft edge can reference it.
ALTER TABLE conversations ADD CONSTRAINT conversations_business_id_ux UNIQUE (business_id, id);
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_business_id_ux UNIQUE (business_id, id);

ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_conversation_business_fk
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations (business_id, id) NOT VALID;
ALTER TABLE conversation_messages VALIDATE CONSTRAINT conversation_messages_conversation_business_fk;
ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_conversation_id_conversations_id_fk;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_message_business_fk
  FOREIGN KEY (business_id, conversation_message_id) REFERENCES conversation_messages (business_id, id) NOT VALID;
ALTER TABLE command_drafts VALIDATE CONSTRAINT command_drafts_message_business_fk;
ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_conversation_message_id_fkey;
