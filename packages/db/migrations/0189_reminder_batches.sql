-- REM-05 (OWN-43): scheduled and bulk payment reminders.
--
-- A batch is the merchant's confirmed list of invoices to remind, now or at a chosen time. It holds
-- no message, contact or money: each recipient is dispatched later through the same single-reminder
-- path (`ReminderService.send`), which re-reads the invoice, the balance, the contact, the opt-out
-- and the attestation immediately before the provider call and writes its own `invoice_reminders`
-- row. So the batch tables are scheduling bookkeeping only; the per-recipient outcome is the
-- reminder history, joined by the deterministic idempotency key `batch:<batch id>:<item id>`.
--
--   reminder_batches
--       one confirmed batch. `state`: scheduled (waiting or dispatching), completed (no item left to
--       dispatch), cancelled (the merchant stopped it; items not yet dispatched were cancelled).
--   reminder_batch_items
--       one invoice in a batch, once (`UNIQUE (batch_id, invoice_id)`: a duplicate in the request is
--       one reminder). `state`: pending, dispatching (claimed by the worker immediately before its
--       send), done, cancelled, skipped (the person who scheduled it can no longer send reminders).
--
-- Discovery (OWN-57, ADR 0035 Amendment 1, class 2): `sweep_due_reminder_batches` is the dedicated,
-- worker-only, ID-only function that says which batches are due. It returns only the batch id, the
-- business id and the scheduled time; every later read and write runs under withBusiness() on the
-- application role. Expand-only: two new tables and one new function.

CREATE TABLE IF NOT EXISTS reminder_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  -- 'auto', 'whatsapp', 'email' or 'both': the channel plan each recipient is sent with.
  channels         text NOT NULL CHECK (channels IN ('auto', 'whatsapp', 'email', 'both')),
  -- The merchant attested, at confirmation, a lawful basis to email these customers (OWN-62(A)).
  attest           boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'scheduled'
                     CHECK (state IN ('scheduled', 'completed', 'cancelled')),
  scheduled_for    timestamptz NOT NULL,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  item_count       integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_by     uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  completed_at     timestamptz,
  CONSTRAINT reminder_batches_tenant_id_ux UNIQUE (business_id, id),
  CONSTRAINT reminder_batches_cancel_ck CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_batches_idem_ux
  ON reminder_batches (business_id, idempotency_key);
CREATE INDEX IF NOT EXISTS reminder_batches_due_ix
  ON reminder_batches (scheduled_for, id) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS reminder_batches_recent_ix
  ON reminder_batches (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reminder_batch_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  batch_id     uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  position     integer NOT NULL CHECK (position >= 0),
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'dispatching', 'done', 'cancelled', 'skipped')),
  reason_code  text CHECK (reason_code IS NULL OR length(reason_code) <= 60),
  claimed_at   timestamptz,
  finished_at  timestamptz,
  CONSTRAINT reminder_batch_items_batch_fk
    FOREIGN KEY (business_id, batch_id) REFERENCES reminder_batches (business_id, id),
  CONSTRAINT reminder_batch_items_invoice_fk
    FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id),
  CONSTRAINT reminder_batch_items_once_ux UNIQUE (batch_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS reminder_batch_items_batch_ix
  ON reminder_batch_items (business_id, batch_id, position);

ALTER TABLE reminder_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reminder_batches
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE reminder_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reminder_batch_items
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON reminder_batches TO rekoda_app;
REVOKE DELETE ON reminder_batches FROM rekoda_app;
REVOKE ALL ON reminder_batches FROM rekoda_worker;

GRANT SELECT, INSERT, UPDATE ON reminder_batch_items TO rekoda_app;
REVOKE DELETE ON reminder_batch_items FROM rekoda_app;
REVOKE ALL ON reminder_batch_items FROM rekoda_worker;

-- ID-only discovery of due batches. Scheduling inputs only (a clock reading, a page size, a keyset
-- cursor); returns no merchant data. EXECUTE for rekoda_worker only.
CREATE OR REPLACE FUNCTION sweep_due_reminder_batches(
  as_of timestamptz,
  page_size integer,
  after_id uuid
) RETURNS TABLE (
  id uuid,
  business_id uuid,
  scheduled_for timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.business_id, b.scheduled_for
  FROM public.reminder_batches b
  WHERE b.state = 'scheduled'
    AND b.scheduled_for <= as_of
    AND (after_id IS NULL OR b.id > after_id)
  ORDER BY b.id
  LIMIT least(greatest(page_size, 1), 1000)
$$;

REVOKE ALL ON FUNCTION sweep_due_reminder_batches(timestamptz, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sweep_due_reminder_batches(timestamptz, integer, uuid) FROM rekoda_app;
GRANT EXECUTE ON FUNCTION sweep_due_reminder_batches(timestamptz, integer, uuid) TO rekoda_worker;
