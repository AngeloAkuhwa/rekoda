-- A customer replied on WhatsApp to an invoice reminder: the business is told, once (OWN-83).
--
-- One row per WhatsApp reminder whose reply the business has been told about. The primary key is
-- the claim: the customer-message job inserts ON CONFLICT DO NOTHING in the same transaction as the
-- notice, so a redelivered webhook, a retried job or a customer's second and third message about
-- the same reminder never tells the business twice. A later reminder is a new row, so a reply to it
-- is told again.
--
-- No message text, no phone number and no customer name is stored: only which reminder was
-- answered and when the business was told.
--
-- Rollback: a normal release rollback (docs/runbooks/deploy.md) keeps this schema and its rows;
-- the older code ignores them, and the rows are what stops a second notice for a reminder already
-- told. An exceptional manual rollback is allowed only if those rows are kept, and is otherwise
-- not done. RLS is forced, so the copy and the restore run as a superuser or a BYPASSRLS role
-- (otherwise they see no rows), and the copy, which has no RLS, is closed to the application
-- roles in the same transaction. With the API, worker and migration jobs stopped:
--   BEGIN; CREATE TABLE reminder_reply_notices_kept AS SELECT * FROM reminder_reply_notices;
--   REVOKE ALL ON reminder_reply_notices_kept FROM PUBLIC, rekoda_app, rekoda_worker; COMMIT;
--   check that the copy has as many rows as the table, then
--   DROP TABLE reminder_reply_notices; DROP INDEX invoice_reminders_whatsapp_sent_ix;
--   ALTER TABLE invoice_reminders DROP CONSTRAINT invoice_reminders_tenant_id_ux;
-- then remove this migration's ledger entry, only after every statement succeeded. Before any
-- release that uses 0192 restarts: migrate, then (same role)
--   INSERT INTO reminder_reply_notices SELECT * FROM reminder_reply_notices_kept
--     ON CONFLICT DO NOTHING; check the row counts match; DROP TABLE reminder_reply_notices_kept;

-- The tenant-scoped key a child row references, so a notice can only name a reminder of its own
-- business (the composite foreign key idiom of 0132 onwards).
ALTER TABLE invoice_reminders
  ADD CONSTRAINT invoice_reminders_tenant_id_ux UNIQUE (business_id, id);

CREATE TABLE IF NOT EXISTS reminder_reply_notices (
  business_id uuid NOT NULL REFERENCES businesses(id),
  reminder_id uuid NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, reminder_id),
  CONSTRAINT reminder_reply_notices_reminder_fk
    FOREIGN KEY (business_id, reminder_id) REFERENCES invoice_reminders (business_id, id)
);

-- The reply lookup: a customer's newest sent WhatsApp reminder, found from the customer the
-- phone blind index names, without scanning the business's other reminders.
CREATE INDEX IF NOT EXISTS invoice_reminders_whatsapp_sent_ix
  ON invoice_reminders (business_id, customer_id, sent_at DESC)
  WHERE channel = 'whatsapp' AND status = 'sent';

ALTER TABLE reminder_reply_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_reply_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reminder_reply_notices
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The default privileges grant both application roles full DML, so what they must not hold is
-- revoked. The customer-message job runs as the application role; a notice is evidence of what
-- was said to the business, so it is never changed or deleted.
GRANT SELECT, INSERT ON reminder_reply_notices TO rekoda_app;
REVOKE UPDATE, DELETE ON reminder_reply_notices FROM rekoda_app;
REVOKE ALL ON reminder_reply_notices FROM rekoda_worker;
