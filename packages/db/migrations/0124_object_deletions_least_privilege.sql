-- Scope the deletion queue, and write down why the other one stays open
-- (remediation R11).
--
-- pending_object_deletions is one of the tables carrying business_id with
-- no row-level security. Nothing but a grant stood between the application
-- role and every tenant's rows, and a row here is a business_id beside a
-- storage_key: not the object, but the name of it, for every merchant on
-- the platform.
--
-- The obvious tightening does not work, and the reason is worth recording
-- so nobody tries it again. Revoking SELECT from rekoda_app looks right,
-- since the application only ever inserts, but `enqueueObjectDeletions`
-- ends in ON CONFLICT (storage_key) DO NOTHING, and PostgreSQL needs
-- table-level SELECT to infer a conflict arbiter. A column grant is not
-- enough either. The revoke does not tighten the read, it breaks the
-- promise to delete.
--
-- So the answer is the one the invariant asks for: a policy.
ALTER TABLE pending_object_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_object_deletions FORCE ROW LEVEL SECURITY;

-- The application sees its own tenant and no other. It enqueues inside the
-- transaction that orphaned the object, so the business is pinned and this
-- matches, exactly as it does on every other tenant table.
CREATE POLICY tenant_isolation ON pending_object_deletions
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* And the worker sees everything, deliberately.
 *
 * This is the one table whose rows OUTLIVE the business they name, which is
 * the entire reason it exists: a row deleted with its tenant takes the
 * storage key with it and leaves the file in the bucket with nothing left
 * pointing at it. By the time the sweep runs there is usually no business
 * to pin, so the tenant policy above would match nothing and the promise
 * would never be kept. A second permissive policy is how that is said in
 * SQL rather than in a comment.
 *
 * This does not hand the worker the ability to invent a deletion: 0122
 * revoked its INSERT, and a policy filters rows, it does not grant. */
CREATE POLICY worker_sweeps_orphans ON pending_object_deletions
  TO rekoda_worker USING (true);

/* ── why platform_cost_events has no policy, written down ────────────────
 * The other table R11 asked about, and the answer is different: it is
 * Rekoda's own cost ledger, not a tenant's. The margin surfaces read it
 * ACROSS businesses on purpose, and a tenant policy would break exactly
 * that. rekoda_app holds INSERT and nothing else, so the application
 * cannot read one business's costs, let alone another's.
 *
 * An exemption with a reason, in the same spirit as retention_deletions.
 * A future table carrying business_id that cannot say something similar
 * should get a policy instead. */
