-- Background work queue (MASTER-PLAN §5.3.1 "all real work happens in a job",
-- and 4.4 #3 "jobs must run inside withBusiness"). See ADR 0022 for why this
-- is a table in our own schema rather than pg-boss.
--
-- The design point is the last line of this file: the ability to claim a job
-- across tenants is a ROLE, not a code path. `rekoda_app` — the role the API
-- runs as — is bound by `tenant_isolation` here exactly as it is everywhere
-- else, so an API process cannot see another tenant's queue even if some
-- future handler asks it to. Only `rekoda_worker` can, and only on this one
-- table; for every other table it is as constrained as the API.

CREATE TABLE IF NOT EXISTS jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  kind          text NOT NULL,
  -- References, never content. Every worker can read this column.
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  singleton_key text,
  state         text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'running', 'done', 'dead')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The claim query's index. Partial, because a queue that is doing its job is
-- mostly `done` rows and none of them are ever due.
CREATE INDEX IF NOT EXISTS jobs_due_ix ON jobs (run_at, created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS jobs_business_state_ix ON jobs (business_id, state);

-- Enqueue-time idempotency. "Render the PDF for document X" enqueued twice
-- while the first is still pending or running is one job, decided by the
-- database rather than by a caller remembering to check first.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_singleton_ux
  ON jobs (business_id, kind, singleton_key)
  WHERE singleton_key IS NOT NULL AND state IN ('pending', 'running');

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- ── the worker role ─────────────────────────────────────────────────────────
-- A second login role, because claiming work is inherently cross-tenant: you
-- cannot pin the tenant of a job you have not read yet. Making that capability
-- a separate role means the reach is bounded by which credential a process
-- holds, and is visible in `\dp` rather than buried in a function.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rekoda_worker') THEN
    CREATE ROLE rekoda_worker LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO rekoda_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rekoda_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rekoda_worker;

-- Append-only means append-only for the worker too. A background process is
-- exactly where "just fix up that ledger row" gets written.
REVOKE UPDATE, DELETE ON audit_events FROM rekoda_worker;
REVOKE UPDATE, DELETE ON ledger_entries FROM rekoda_worker;
REVOKE UPDATE, DELETE ON inventory_movements FROM rekoda_worker;

-- The whole privilege difference between the API and a worker, in one policy:
-- read and claim any tenant's job ROW. Every other table stays under
-- `tenant_isolation`, so the moment the runner has a job it must pin the
-- tenant to do anything with it.
CREATE POLICY worker_claim ON jobs
  FOR ALL
  TO rekoda_worker
  USING (true)
  WITH CHECK (true);
