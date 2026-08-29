-- The transactional outbox (canonical spec §26; PR-020).
--
-- An OutboxEvent is written in the SAME transaction as the state change it
-- announces. That one sentence is the whole pattern: an event beside a
-- rolled-back sale never exists, and a sale beside a lost event never
-- happens, because they are one commit. Everything else here is the
-- dispatcher's bookkeeping.

CREATE TABLE IF NOT EXISTS outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  type          text NOT NULL CHECK (length(btrim(type)) > 0),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  /** NULL until delivered. Dispatch state, like every state here, is a
   * nullable timestamp rather than a status column: written once, no
   * invalid combinations. */
  dispatched_at timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  /* Enough retries to ride out an outage, few enough that a poisoned event
   * stops burning the dispatcher. A dead event is VISIBLE, never deleted. */
  max_attempts  integer NOT NULL DEFAULT 8,
  last_error    text,
  /** The dispatcher's lease, so two workers cannot deliver one event. */
  locked_at     timestamptz
);

/* The dispatcher's question: undelivered, attempts left, not leased. */
CREATE INDEX outbox_events_undispatched_ix
  ON outbox_events (occurred_at)
  WHERE dispatched_at IS NULL;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_events
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* The jobs-table shape (migration 0004): the worker dispatches across
 * tenants, so it holds its own policy rather than a pin. */
CREATE POLICY worker_dispatch ON outbox_events
  FOR ALL TO rekoda_worker USING (true) WITH CHECK (true);

-- An outbox event is a record of something that HAPPENED. The application
-- appends and the dispatcher stamps; nobody rewrites history and nobody
-- deletes it. The usual 0001 default-privileges correction:
REVOKE UPDATE, DELETE ON outbox_events FROM rekoda_app;
REVOKE DELETE ON outbox_events FROM rekoda_worker;
