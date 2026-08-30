-- Deleting the row has never deleted the object (PR-136).
--
-- Every rendered document, product photo and piece of payment evidence lives
-- in R2; the database holds only the KEY. That split is deliberate and right
-- (ADR 0006), and it left one thing undone: nothing in the estate has ever
-- called a delete on the object store. The port had `put` and `get` and no
-- third method.
--
-- So an abandoned trial swept by `retention_delete_business` lost its rows
-- and kept its invoices; `sweepEvidence` computed the raw media refs it had
-- just orphaned, returned them, and its only caller discarded the array. The
-- comment there said it out loud: "the day objects exist, the caller hands
-- these refs to the storage port". The objects exist.
--
-- The hard part is not the delete call. It is that the row naming the object
-- is gone the moment the object becomes garbage, so a failed delete loses
-- the key forever: an R2 outage during one sweep would silently keep a
-- merchant's documents past the deletion we told them had happened.
--
-- Hence a queue, written in the SAME transaction that orphans the object.
-- Rows are DELETED on success, never marked done, so the table answers
-- exactly one question and an empty table is the healthy state: what have we
-- promised to delete and not yet deleted?

CREATE TABLE pending_object_deletions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately NOT a foreign key, and deliberately NOT under RLS. This is
  -- the same exception `retention_deletions` (0022) takes, for the same
  -- reason: the row's whole purpose is to outlive the tenant whose object it
  -- names. A policy keyed on a business that has just been deleted would
  -- make the row unreachable by every credential, which is precisely the
  -- failure this table exists to prevent. It is kept safe to hold outside a
  -- tenant boundary by holding nothing worth isolating: an opaque object key
  -- and the business it belonged to, no names, no numbers, no content.
  business_id     uuid,
  storage_key     text NOT NULL,
  reason          text NOT NULL
    CHECK (reason IN ('business_deleted', 'evidence_purged')),
  attempts        integer NOT NULL DEFAULT 0,
  -- The provider's last refusal, for an operator reading a stuck queue.
  last_error      text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- One pending deletion per object. A key enqueued twice is one job, and
  -- `ON CONFLICT DO NOTHING` at the call sites relies on this.
  CONSTRAINT pending_object_deletions_key_ux UNIQUE (storage_key)
);

-- The drain reads oldest-due first; this is the index that answers it.
CREATE INDEX pending_object_deletions_due_ix
  ON pending_object_deletions (next_attempt_at);

-- 0001's ALTER DEFAULT PRIVILEGES grants both application roles full DML on
-- every new table, so what they must NOT hold needs a REVOKE. The two roles
-- do different halves of this: the application ENQUEUES, inside the tenant
-- transaction that orphaned the object; the worker DRAINS, after the object
-- is actually gone from R2. Neither needs the other's half.
REVOKE UPDATE, DELETE ON pending_object_deletions FROM rekoda_app;
REVOKE INSERT ON pending_object_deletions FROM rekoda_worker;

/**
 * Enqueue every object a business owns, then delete the business (PR-136).
 *
 * CREATE OR REPLACE on the deployed function, in a NEW migration: 0022,
 * 0109 and 0118 are history and stay untouched. Two changes from 0118:
 *
 *  1. The object keys are captured BEFORE the delete loop reaches the rows
 *     that hold them, in the same transaction. A rollback takes the enqueue
 *     with it, so the queue can never name an object whose row survived.
 *  2. `pending_object_deletions` joins `retention_deletions` in the delete
 *     loop's exclusion list. It carries a `business_id`, so without this
 *     the loop would delete the rows the function had just written - the
 *     bug would have been silent, and the objects would have stayed.
 */
CREATE OR REPLACE FUNCTION retention_delete_business(
  target uuid,
  cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  due          boolean;
  pending      text[];
  remaining    text[];
  t            text;
  removed      integer := 0;
  affected     integer;
  tenant_users uuid[];
BEGIN
  SELECT true INTO due
  FROM public.businesses b
  WHERE b.id = target
    AND b.plan IN ('trial', 'expired')
    AND b.plan_expires_at IS NOT NULL
    AND b.plan_expires_at <= cutoff
    AND b.retention_notified_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.subscription_charges c
      WHERE c.business_id = b.id AND c.status IN ('paid', 'refunded'));

  IF due IS NOT TRUE THEN
    RETURN -1;
  END IF;

  PERFORM set_config('app.business_id', target::text, true);

  /* Captured BEFORE the tenant's rows go: the only users this run may
   * later touch. Never the whole users table. */
  tenant_users := ARRAY(
    SELECT b.owner_user_id FROM public.businesses b WHERE b.id = target
    UNION
    SELECT m.user_id FROM public.memberships m WHERE m.business_id = target
  );

  /* Also captured before the rows go: everything this business put in the
   * object store. Deleting the row is not deleting the file, and after the
   * loop below there is nothing left that knows the key. */
  INSERT INTO public.pending_object_deletions (business_id, storage_key, reason)
  SELECT target, d.storage_key, 'business_deleted'
    FROM public.documents d
   WHERE d.business_id = target
  ON CONFLICT (storage_key) DO NOTHING;

  INSERT INTO public.pending_object_deletions (business_id, storage_key, reason)
  SELECT target, p.image_key, 'business_deleted'
    FROM public.products p
   WHERE p.business_id = target AND p.image_key IS NOT NULL
  ON CONFLICT (storage_key) DO NOTHING;

  INSERT INTO public.pending_object_deletions (business_id, storage_key, reason)
  SELECT target, e.media_ref, 'business_deleted'
    FROM public.payment_evidence e
   WHERE e.business_id = target AND e.media_ref IS NOT NULL
  ON CONFLICT (storage_key) DO NOTHING;

  SELECT array_agg(c.table_name::text ORDER BY c.table_name)
  INTO pending
  FROM information_schema.columns c
  JOIN information_schema.tables tb
    ON tb.table_name = c.table_name
   AND tb.table_schema = 'public'
   AND tb.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name = 'business_id'
    AND c.table_name NOT IN ('retention_deletions', 'pending_object_deletions');

  FOR i IN 1..20 LOOP
    EXIT WHEN pending IS NULL OR array_length(pending, 1) IS NULL;
    remaining := ARRAY[]::text[];
    FOREACH t IN ARRAY pending LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE business_id = $1', t) USING target;
        GET DIAGNOSTICS affected = ROW_COUNT;
        removed := removed + affected;
      EXCEPTION WHEN foreign_key_violation THEN
        remaining := array_append(remaining, t);
      END;
    END LOOP;
    pending := remaining;
  END LOOP;

  IF pending IS NOT NULL AND array_length(pending, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'retention: % still referenced for business %', pending, target;
  END IF;

  DELETE FROM public.businesses WHERE id = target;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  /* Owners and members left holding nothing — evaluated over EXACTLY the
   * users this tenant brought to the run. A person mid-onboarding on some
   * other business, a member of two shops, a user who never joined this
   * one: all structurally out of reach. */
  DELETE FROM public.users u
  WHERE u.id = ANY (tenant_users)
    AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.owner_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  INSERT INTO public.retention_deletions (business_id, reason, rows_deleted)
  VALUES (target, 'abandoned_trial', removed)
  ON CONFLICT (business_id) DO NOTHING;

  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION retention_delete_business(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_delete_business(uuid, timestamptz) TO rekoda_worker;
