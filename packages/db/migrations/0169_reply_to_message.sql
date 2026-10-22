-- G-20: a preview WhatsApp ACCEPTED can still fail to DELIVER. That failure
-- arrives later, as a `failed` status webhook naming only the outbound wamid
-- (`conversation_messages.provider_message_id`). Nothing linked that outbound
-- reply to the inbound message whose draft it previewed, so the draft stayed
-- `previewed` and a lapsed "yes" was told an unseen request had expired.
--
-- `reply_to_message_id` is that link: the inbound message an outbound reply
-- answered. NULL on every inbound row, on every historical row, and on every
-- reply sent without a request behind it (a nudge, a notice). It is set only
-- where the merchant's preview is sent.
--
-- Composite, like every tenant edge since 0132: (business_id, reply_to) must
-- name a message of the SAME business (conversation_messages_business_id_ux,
-- 0141), so a reply cannot be filed against another merchant's request. A
-- NULL reference skips the check (MATCH SIMPLE), which is exactly the
-- "answered nothing" case. NOT VALID then VALIDATE, as in 0141; every existing
-- row is NULL, so the validation finds nothing to refuse.
--
-- No new grants: a column added to an existing table is covered by the
-- table-level privileges and RLS policies conversation_messages already has.
ALTER TABLE conversation_messages
  ADD COLUMN reply_to_message_id uuid;

ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_reply_to_business_fk
  FOREIGN KEY (business_id, reply_to_message_id) REFERENCES conversation_messages (business_id, id) NOT VALID;
ALTER TABLE conversation_messages VALIDATE CONSTRAINT conversation_messages_reply_to_business_fk;

-- Only a reply answers something.
ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_reply_to_outbound_ck
  CHECK (reply_to_message_id IS NULL OR direction = 'outbound');
