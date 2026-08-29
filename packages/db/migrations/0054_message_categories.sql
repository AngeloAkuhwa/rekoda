-- Outbound messages get their Meta category as their usage type.
--
-- Every outbound message was recorded as `message_out`, which put a ₦0
-- service reply and a ₦21.03 sign-in code in one bucket. Spec §24 separates
-- the categories precisely because "utility and marketing differ by roughly
-- eightfold in cost, and that difference is the largest variable in plan
-- margin", and one bucket is the shape in which that difference cannot be
-- seen.
--
-- The rename is safe and provable rather than assumed. `usage_events` has no
-- CHECK on `usage_type`, so nothing was ever excluded; and both writers of
-- `message_out` set `meta.window = 'service'` on every row, because both were
-- free-form replies inside the 24-hour customer service window. There is no
-- `message_out` row that was anything other than a SERVICE_MESSAGE.
--
-- The build plan lists PR-016 as needing no migration. It needs this one:
-- without it the margin view reports the same category under two names, which
-- is the same blindness the PR exists to remove, wearing a different label.
-- Data only. No schema changes, no constraints added.
--
-- Rollback: the reverse UPDATE under the same RLS disable and restore.
-- Nothing is lost either way; only the label on the row changes.
--
-- RLS is dropped for the length of the UPDATE and restored immediately.
-- `usage_events` is FORCE ROW LEVEL SECURITY, which applies to the table
-- owner too, and a migration has no `app.business_id` to pin: without this
-- the UPDATE would match zero rows and report success.

ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;

UPDATE usage_events SET usage_type = 'SERVICE_MESSAGE' WHERE usage_type = 'message_out';

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
