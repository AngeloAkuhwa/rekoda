-- Store only a message ID so a delayed receipt can identify the question it belongs to.
ALTER TABLE command_drafts ADD COLUMN held_question_message_id uuid;
