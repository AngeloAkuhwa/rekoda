-- Messaging consent (Meta policy; MASTER-PLAN §5.3.4 STOP/START).
--
-- STOP must be a fact in the database, not a sentence in a reply. Proactive
-- sends (receipts, resends, future reminders) check this column; direct
-- replies to an inbound message do not, because answering the message a
-- person just sent is not the thing they opted out of.
ALTER TABLE users ADD COLUMN opted_out_at timestamptz;
