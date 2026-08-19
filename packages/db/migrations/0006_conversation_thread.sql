-- One thread per business per channel.
--
-- A merchant messaging Rekoda on WhatsApp has one conversation, not one per
-- inbound message. Without a constraint the lazy "select, then insert if
-- absent" in the conversations repository loses the same race everything else
-- in this schema has already lost once: two messages arriving together each
-- find no thread and each create one, and the merchant's history is split
-- across two rows that nothing will ever reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_business_channel_ux
  ON conversations (business_id, channel);
