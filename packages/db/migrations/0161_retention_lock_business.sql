-- G-103 post-merge review: the retention deletion locks the business row it judges.

/**
 * G-103 post-merge review. 0160 made "ever paid" a durable column, but the
 * function still decided "due" with a plain read. A payment applied in a
 * transaction that had not committed yet was invisible to that read, so a
 * merchant who paid inside the window could still be deleted (the deletes
 * below only waited for the payment's row locks, then carried on).
 *
 * The one change from 0160: the eligibility read is `FOR UPDATE OF b`. It
 * waits for a concurrent payment or plan change on the business, then
 * re-evaluates the committed row, where `plan` and `ever_paid_at` (set in
 * the same transaction by applyCycle / setPlan) now refuse it. Everything
 * else is as 0160. CREATE OR REPLACE; 0122 and 0160 stay history.
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
      WHERE c.business_id = b.id AND c.status IN ('paid', 'refunded'))
  FOR UPDATE OF b;

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
