-- G-103: a business that was ever on a paid plan is never an abandoned trial.
--
-- Retention read "never paid" as "no paid or refunded subscription charge".
-- A plan set by hand (the operator path, G-62) writes no charge, so once
-- that paid plan lapsed the business was warned at 60 days and its books
-- deleted at 90. `ever_paid_at` is the durable fact instead: set by every
-- path that puts a business on a paid plan, never cleared, and backfilled
-- here from paid charges and from the operator's `plan_changed` audit rows
-- (either side of the change naming a paid plan).

ALTER TABLE businesses ADD COLUMN ever_paid_at timestamptz;

UPDATE businesses b
SET ever_paid_at = evidence.first_paid
FROM (
  SELECT business_id, min(at) AS first_paid FROM (
    SELECT c.business_id, c.created_at AS at
    FROM subscription_charges c
    WHERE c.status IN ('paid', 'refunded')
    UNION ALL
    SELECT a.business_id, a.created_at AS at
    FROM audit_events a
    WHERE a.action = 'plan_changed'
      AND (coalesce(a.new_value ->> 'plan', 'trial') NOT IN ('trial', 'expired')
        OR coalesce(a.old_value ->> 'plan', 'trial') NOT IN ('trial', 'expired'))
  ) facts
  GROUP BY business_id
) evidence
WHERE b.id = evidence.business_id;

-- A paid plan held right now is evidence too (a plan set before audit rows).
UPDATE businesses
SET ever_paid_at = coalesce(cycle_started_at, now())
WHERE ever_paid_at IS NULL AND plan NOT IN ('trial', 'expired');

/**
 * The deletion function, CREATE OR REPLACE on the deployed one (0122 is
 * history and stays untouched). One change from 0122: a business with
 * `ever_paid_at` set is never due, whatever its charges say.
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
    AND b.ever_paid_at IS NULL
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
