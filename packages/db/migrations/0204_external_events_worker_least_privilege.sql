-- Owner review of PR #432 (11 Nov 2026), item 5: close the generic event-resolution cross-tenant
-- WRITE privilege.
--
-- Migration 0130 described `worker_reads_the_estate` as a read ("the worker sees the estate"), but
-- it was created with no `FOR` clause and no `WITH CHECK`, so it applied to EVERY command with
-- `true` on both sides. Together with the blanket table grants of 0004, the worker credential could
-- INSERT, UPDATE and DELETE any business's `external_events` rows, on every column, with no tenant
-- pin: re-point an event to another business, rewrite its payload or reservation, stamp it resolved.
-- The generic operator resolve (`POST /v1/ops/exceptions/:id/resolve`) used exactly that: it ran on
-- the worker credential with no pin, no check that the row was an exception, and no audit row,
-- which ADR 0035 Amendment 2 rule 4 says every operator mutation must have. That route now runs on
-- the application credential under the event's own business pin, checks the target is an open
-- exception, and writes an audit row (apps/api/src/health/ops.controller.ts).
--
-- What the worker legitimately writes on this table without a pin, and nothing more:
--   * the payments pump and the stranger sweep mark an UNATTRIBUTED event processed, with a reason
--     (`processed_at`, `error`), and attribute it once (`business_id`, from NULL);
--   * a dead job's record flags its own event (`error`), under that business's pin
--     (dead-jobs.recordDeath), which the ordinary tenant policy already allows.
-- So the worker keeps:
--   * SELECT on every row (attribution and the exception queue are cross-tenant reads, OWN-85);
--   * UPDATE of `processed_at` and `error` only, and without a pin only on a row that is still
--     unattributed (USING and WITH CHECK both `business_id IS NULL`, so no write can move a row);
--   * attribution through `attribute_external_event(event, business)`, a worker-only SECURITY
--     DEFINER function (pinned search_path, validated inputs) that sets `business_id` once, from
--     NULL, to a business that exists, and nothing else;
-- and loses INSERT and DELETE (it never records ingress; retention deletes through its definer
-- function) and UPDATE of every other column (business_id, payload, signature, reservations,
-- resolution).
--
-- Residual, recorded in docs/rls-exemption-register.md and ADR 0035: `app.business_id` is an
-- ordinary setting, so a holder of the worker credential can still pin a business and update that
-- business's `processed_at`/`error` through the tenant policy (never `business_id` or the
-- resolution, which it holds no grant on), as the application credential can for its tenant rows; the definer-function narrowing of the worker's other blanket
-- grants is the OD-33-F1 follow-up.
--
-- Rollback: a release older than this one resolves exceptions on the worker credential and would
-- get "permission denied" on that route only; nothing else it does is refused. Re-running is safe.

DROP POLICY IF EXISTS worker_reads_the_estate ON external_events;
CREATE POLICY worker_reads_the_estate ON external_events
  FOR SELECT TO rekoda_worker
  USING (true);

DROP POLICY IF EXISTS worker_attributes_ingress ON external_events;
DROP POLICY IF EXISTS worker_marks_unattributed_ingress ON external_events;
CREATE POLICY worker_marks_unattributed_ingress ON external_events
  FOR UPDATE TO rekoda_worker
  USING (business_id IS NULL);

REVOKE INSERT, UPDATE, DELETE ON external_events FROM rekoda_worker;
GRANT UPDATE (processed_at, error) ON external_events TO rekoda_worker;

-- Attribution: write-once, to a business that exists, nothing else on the row. Owned by the migration
-- owner (it must reach the unattributed row and check the business under FORCE ROW LEVEL SECURITY),
-- executable by the worker only.
CREATE OR REPLACE FUNCTION attribute_external_event(p_event uuid, p_business uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_event IS NULL OR p_business IS NULL THEN
    RAISE EXCEPTION 'attribute_external_event: invalid input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.external_events
     SET business_id = p_business
   WHERE id = p_event AND business_id IS NULL
     AND EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = p_business);
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION attribute_external_event(uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION attribute_external_event(uuid, uuid) FROM rekoda_app;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
GRANT EXECUTE ON FUNCTION attribute_external_event(uuid, uuid) TO rekoda_worker;
