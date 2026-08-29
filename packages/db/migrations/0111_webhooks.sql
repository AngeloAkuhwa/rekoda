-- Webhooks (PR-112, canonical spec §26 and §27).
--
-- Migration 0060 built the transactional outbox and left every handler
-- empty, with a note that PR-112 would replace the bodies with fan-out to
-- whatever the merchant subscribed. These two tables are that subscription
-- and its delivery log.
--
-- The shape follows the outbox's own, deliberately, because the problems
-- are the same problems: at-least-once delivery, a lease so two workers
-- cannot send one thing twice, a bounded retry, and a dead state that is
-- VISIBLE rather than a silent loss.
--
--   webhook_endpoints    what the merchant registered, and what it wants.
--   webhook_deliveries   one row per (endpoint, event). The idempotency
--                        spine: a fan-out that runs twice writes once.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  -- HTTPS only, checked here as well as in the application: a plaintext
  -- callback carries a merchant's financial facts across the open internet.
  url           text NOT NULL CHECK (url ~ '^https://'),
  description   text,
  -- Which facts this endpoint wants. Empty means every type, which is the
  -- honest default for a merchant who has not thought about it yet.
  event_types   text[] NOT NULL DEFAULT ARRAY[]::text[],
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
  -- The signing secret, AES-256-GCM under the vault key, never plaintext.
  -- Unlike an API key this must be RECOVERABLE: the signature is computed
  -- from it on every delivery, and the merchant's own verifier holds the
  -- same value. A hash would make signing impossible.
  encrypted_secret text NOT NULL,
  last_success_at  timestamptz,
  -- Consecutive failures, reset by any success. What an operator reads to
  -- find an endpoint that has quietly stopped listening.
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_business_ix
  ON webhook_endpoints (business_id, created_at DESC);
-- One URL per business, so a double-tapped "Add endpoint" is one endpoint
-- rather than two that both fire for every event.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_business_url_ux
  ON webhook_endpoints (business_id, url);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id),
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id),
  event_type      text NOT NULL,
  -- The body as it will be sent, frozen at fan-out. A retry three hours
  -- later must deliver what HAPPENED, not what the books say now.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 6,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  -- The sender's lease, same as the outbox's.
  locked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The idempotency spine. Fan-out is at-least-once like everything the
-- dispatcher does, so a second pass over the same event must find this
-- constraint rather than send the merchant a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_event_endpoint_ux
  ON webhook_deliveries (endpoint_id, outbox_event_id);

-- The sender's question: due, not delivered, not dead, not leased.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_ix
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS webhook_deliveries_business_ix
  ON webhook_deliveries (business_id, created_at DESC);

-- ── tenancy ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints', 'webhook_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)
         WITH CHECK (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

/* Migration 0060's shape: the sender works across tenants because it claims
 * what is due before it knows whose it is, so it holds its own policy rather
 * than a pin — visible in \dp, bounded to this one role. */
CREATE POLICY worker_dispatch ON webhook_deliveries
  FOR ALL TO rekoda_worker USING (true) WITH CHECK (true);
/* The sender needs the endpoint to sign for and to send to. */
CREATE POLICY worker_read ON webhook_endpoints
  FOR SELECT TO rekoda_worker USING (true);
/* And it needs to record how that went — but ONLY that. The policy allows
 * the update; the column grant below decides what may move. A delivery
 * attempt must never be able to edit the URL it delivers to or the secret it
 * signs with, and "must never" is a privilege here rather than a review
 * habit. */
CREATE POLICY worker_health ON webhook_endpoints
  FOR UPDATE TO rekoda_worker USING (true) WITH CHECK (true);

-- A delivery is the sender's record, not the merchant's to rewrite; the
-- merchant may read their log and may not edit or erase it. 0001's default
-- privileges granted both, so both are revoked.
REVOKE INSERT, UPDATE, DELETE ON webhook_deliveries FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON webhook_endpoints FROM rekoda_worker;
REVOKE DELETE ON webhook_deliveries FROM rekoda_worker;

-- Three columns back, and three only: whether the last attempt worked, and
-- how many have not. Column-level so the reach is what \dp shows rather
-- than what a WHERE clause happens to touch today.
GRANT UPDATE (last_success_at, consecutive_failures, updated_at)
  ON webhook_endpoints TO rekoda_worker;

COMMENT ON TABLE webhook_endpoints IS
  'Merchant-registered callbacks for outbox facts (spec §26, §27). The '
  'signing secret is encrypted, never hashed: signing needs it back.';
COMMENT ON TABLE webhook_deliveries IS
  'One row per (endpoint, outbox event). At-least-once with a bounded '
  'retry; a delivery that gives up is dead and visible, never deleted.';
