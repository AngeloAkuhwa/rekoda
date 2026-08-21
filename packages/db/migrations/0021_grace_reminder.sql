-- One grace reminder per day, claimed rather than remembered (ADR 0024).
--
-- The sweep runs on a timer and may run in more than one process. Deciding
-- "have I already sent day 5" by reading a row and then sending would send
-- twice the first time two passes overlap, and a merchant whose card failed
-- receiving the same message twice is the product looking broken at the exact
-- moment it is asking them for money.
--
-- So the reminder is CLAIMED with a conditional UPDATE, the same shape as the
-- draft claim and the stranger sweep's one-reply-per-day guard: the database
-- picks the winner and the loser sends nothing.
--
-- Strictly increasing, so a clock that jumps backwards cannot re-send day 1
-- after day 5 has gone out. Cleared when a cycle is paid for, because the
-- next failure starts a fresh grace period from day zero.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS last_grace_reminder_day smallint;
