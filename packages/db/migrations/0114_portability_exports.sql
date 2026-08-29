-- Data portability, recorded (PR-118).
--
-- Taking your own books out of Rekoda is a RIGHT, not a product feature.
-- It is therefore never metered, never gated on a plan, and available to a
-- business whose subscription has lapsed - which is exactly when somebody
-- needs it and exactly when a metered export would refuse them.
--
-- A right still leaves a trace. One row per request, because "who took a
-- complete copy of this business's books, and when" is a question a
-- security review will ask, and because two mechanisms fall out of the same
-- row for free:
--
--   ONE AT A TIME     a row with completed_at IS NULL is a request in
--                     flight, and a second is refused while it stands.
--   RATE LIMITED      the newest completed row's age is the throttle, so a
--                     script cannot dump the estate in a loop.
--
-- Both are enforced in the application against these rows rather than in
-- memory: a per-process counter answers differently on each of two web
-- servers, which is not a limit.

CREATE TABLE IF NOT EXISTS portability_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  -- Who asked. `user:<uuid>`, the same actor string the audit trail uses.
  actor        text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Null while in flight. Set when the bytes were handed over.
  completed_at timestamptz,
  -- What was handed over, roughly: enough to answer "how much left" without
  -- keeping a copy of it. Null for a request that never finished.
  bytes        bigint CHECK (bytes IS NULL OR bytes >= 0),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

/* One in flight per business. A partial unique index rather than an
 * application check, because two simultaneous requests would both read
 * "none in flight" and both proceed; the database decides, as everywhere
 * else in this codebase. */
CREATE UNIQUE INDEX IF NOT EXISTS portability_exports_inflight_ux
  ON portability_exports (business_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS portability_exports_recent_ix
  ON portability_exports (business_id, requested_at DESC);

ALTER TABLE portability_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE portability_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portability_exports
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* The application starts and finishes a request and may never erase one:
 * a deletable audit trail is not one. 0001's default privileges granted
 * DELETE, so it is revoked. */
REVOKE DELETE ON portability_exports FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON portability_exports FROM rekoda_worker;

COMMENT ON TABLE portability_exports IS
  'One row per data-portability request (PR-118). Never metered; the row '
  'exists to answer who took a full copy and when, and to enforce one in '
  'flight and a throttle between them.';
