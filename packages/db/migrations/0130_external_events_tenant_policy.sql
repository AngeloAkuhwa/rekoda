-- Close the last cross-tenant read in the schema (remediation R1/R2, ruling 2).
--
-- external_events has carried business_id with no row-level security since
-- §5.3.1, and the reason written at the top of repos/events.ts was true when
-- it was written: an event arrives BEFORE anyone knows whose it is, and a
-- policy keyed on app.business_id would reject the very insert that decides
-- it. What was never true is the conclusion drawn from it — that the whole
-- table therefore had to stay open to the application role.
--
-- A Meta payload is the merchant's own message text and the sender's number.
-- It is sealed (AES-256-GCM, see the note in meta.service.ts), so this is not
-- a plaintext leak; it is every tenant's traffic pattern, volume and failure
-- history readable by any request. That is worth closing before launch.
--
-- Two changes shipped ahead of this one, because the runbook's
-- expand -> deploy -> contract discipline requires the release already
-- running to tolerate a migration, and a policy is a contraction:
--
--   * the estate-wide counts on /v1/ops/health moved to the worker
--     credential, which is the only one entitled to ask an estate-wide
--     question;
--   * recordEvent stopped reading the conflicting row back, which under a
--     policy it may not be able to see.
--
-- Without both, the window between `migrate` and the container swap would
-- report zeros on the health surface and raise on every provider retry.
ALTER TABLE external_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_events FORCE ROW LEVEL SECURITY;

-- The canonical predicate, character for character, because
-- rls-invariants.integration.test.ts holds every tenant policy to it: one
-- that is ALMOST this one is the shape a leak hides in.
--
-- This is what every attributed path already satisfies. The Meta ingress
-- records inside withBusiness once it has resolved the sender, and the job
-- runner opens withBusiness(appDb, job.business_id) before any handler
-- touches an event, so eventForBusiness and markProcessed are pinned to the
-- tenant they name. Nothing had to move for this policy; the pin was
-- already there.
CREATE POLICY tenant_isolation ON external_events
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* The worker sees the estate, deliberately, exactly as it does on
 * pending_object_deletions (0124).
 *
 * Attribution is a cross-tenant read by definition: resolving a payment
 * reference to the intent that owns it is the `worker_resolve` right granted
 * in 0010, and it happens BEFORE there is a tenant to pin. The stranger sweep
 * and the exception queue are the same shape. A second permissive policy is
 * how that is said in SQL rather than in a comment. */
CREATE POLICY worker_reads_the_estate ON external_events
  TO rekoda_worker USING (true);

/* And the application keeps exactly one thing: the unattributed backlog.
 *
 * This is the narrow answer to the objection the file header raised. An event
 * with no business_id belongs to NOBODY yet, so letting the ingress store and
 * dedupe one is not letting it read another tenant's event — and the moment
 * the pump attributes the row, it leaves this view for good.
 *
 * Deliberately not FOR INSERT alone. `ON CONFLICT DO NOTHING` needs to see
 * its own arbiter, and a retry that could not match would insert a duplicate
 * or raise; either answer breaks the promise the ingress makes to a provider.
 *
 * What it is NOT: a `USING (true)` for rekoda_app. That would undo the tenant
 * policy above for every ordinary request, which is the specific thing the
 * invariant test refuses. */
CREATE POLICY app_records_unattributed_ingress ON external_events
  TO rekoda_app USING (business_id IS NULL);
