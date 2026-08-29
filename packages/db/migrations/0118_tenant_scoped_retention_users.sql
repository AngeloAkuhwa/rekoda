-- Tenant retention must not delete unrelated users (launch remediation R9).
--
-- The previous definition (0022, re-created in 0109) ended with a GLOBAL
-- orphan sweep:
--
--     DELETE FROM users u
--     WHERE NOT EXISTS (... businesses ...) AND NOT EXISTS (... memberships ...)
--
-- which reads as tidy and is a tenant-boundary violation: a retention run
-- for Business A could delete a completely unrelated person who happened to
-- have no membership at that instant — the window between phone
-- verification creating their user row and onboarding creating their first
-- business is exactly such an instant. A retention function may only ever
-- touch the tenant it was invoked for.
--
-- The corrected shape: capture the users ASSOCIATED WITH THE TARGET
-- business before its rows are deleted, and afterwards re-evaluate ONLY
-- those captured users. One of them is removed only when, with the target
-- gone, they own no business and hold no membership anywhere — the same
-- eligibility rule as before, applied to a tenant-scoped population.
--
-- CREATE OR REPLACE on the deployed function, in a NEW migration: the
-- already-applied migrations are history and stay untouched.

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

  SELECT array_agg(c.table_name::text ORDER BY c.table_name)
  INTO pending
  FROM information_schema.columns c
  JOIN information_schema.tables tb
    ON tb.table_name = c.table_name
   AND tb.table_schema = 'public'
   AND tb.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name = 'business_id'
    AND c.table_name <> 'retention_deletions';

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
