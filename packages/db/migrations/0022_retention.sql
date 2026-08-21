-- Enforcing the published retention schedule (ADR 0024, /privacy#retention).
--
-- The schedule states MAXIMUMS, which makes them promises about dates rather
-- than intentions. This is what keeps them.
--
-- ── why a function and not a repo ───────────────────────────────────────────
--
-- Deleting a tenant is the most dangerous operation in this system, and the
-- question is not "can the worker do it" but "what exactly can the worker
-- do". Handing `rekoda_worker` the privileges to empty a tenant would mean a
-- compromised worker could empty ANY tenant, including a paying one.
--
-- So the capability is not "delete a business". It is "delete a business the
-- schedule says is due", and the predicate lives INSIDE the function where no
-- caller can pass around it. The worker may execute it and can do nothing
-- else; a wrong id simply returns false.
--
-- SECURITY DEFINER is needed for a second reason too: `audit_events`,
-- `ledger_entries` and `inventory_movements` are append-only for both
-- application roles, deliberately, and a retention deletion is the one thing
-- that must be able to remove them. That exception is written here, once,
-- rather than by relaxing a REVOKE that protects everything else.

-- The record of a deletion, kept AFTER the tenant is gone.
--
-- No foreign key to `businesses`, on purpose: the row it would reference is
-- the row being deleted. No RLS either, for the same reason `users` has none
-- and for one more: this table is the proof that a deletion happened, and a
-- proof only the deleted tenant could read would prove nothing.
--
-- It holds an id, a reason and a date. Nothing about what the business sold,
-- who its customers were, or what it was called.
CREATE TABLE IF NOT EXISTS retention_deletions (
  business_id  uuid PRIMARY KEY,
  reason       text NOT NULL CHECK (reason IN ('abandoned_trial', 'merchant_request')),
  /** How many rows went, so a deletion that removed nothing is visible. */
  rows_deleted integer NOT NULL DEFAULT 0,
  deleted_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON retention_deletions TO rekoda_worker;

-- When the merchant was warned. The schedule promises notice before deletion,
-- and a promise of notice needs somewhere to record that notice was given.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS retention_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS businesses_retention_ix
  ON businesses (plan, plan_expires_at)
  WHERE plan IN ('trial', 'expired');

/**
 * Delete one business, if and only if the schedule says it is due.
 *
 * Due means: on a trial or expired plan, past its date by the retention
 * window, warned, and having NEVER paid us anything. The last condition is
 * the one that matters most - a business that ever completed a subscription
 * charge has books it is entitled to keep for the financial retention period,
 * and no abandoned-trial rule may touch it.
 *
 * The table list is discovered rather than written down. A hard-coded list
 * goes stale the first time somebody adds a table, and the failure mode is
 * orphaned rows carrying a deleted merchant's data - which is exactly the
 * outcome this function exists to prevent. Foreign keys decide the order:
 * a delete that cannot go yet raises, is caught, and is retried next pass.
 *
 * If any table still refuses after the passes are exhausted, the whole thing
 * raises and rolls back. Nothing half-deleted, and a loud log line.
 */
CREATE OR REPLACE FUNCTION retention_delete_business(
  target uuid,
  cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  due       boolean;
  pending   text[];
  remaining text[];
  t         text;
  removed   integer := 0;
  affected  integer;
BEGIN
  SELECT true INTO due
  FROM businesses b
  WHERE b.id = target
    AND b.plan IN ('trial', 'expired')
    AND b.plan_expires_at IS NOT NULL
    AND b.plan_expires_at <= cutoff
    AND b.retention_notified_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM subscription_charges c
      WHERE c.business_id = b.id AND c.status IN ('paid', 'refunded'));

  IF due IS NOT TRUE THEN
    RETURN -1;
  END IF;

  /* The policies compare against this GUC, and FORCE ROW LEVEL SECURITY
   * applies them to the owner as well. Setting it here means every statement
   * below is scoped to exactly one tenant by the database rather than by the
   * WHERE clause being written correctly. */
  PERFORM set_config('app.business_id', target::text, true);

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
        EXECUTE format('DELETE FROM %I WHERE business_id = $1', t) USING target;
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

  DELETE FROM businesses WHERE id = target;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  /* Owners left holding nothing. A person who never converted a trial should
   * not remain on file as a phone number forever, and one who runs another
   * business is untouched. */
  DELETE FROM users u
  WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.owner_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  INSERT INTO retention_deletions (business_id, reason, rows_deleted)
  VALUES (target, 'abandoned_trial', removed)
  ON CONFLICT (business_id) DO NOTHING;

  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION retention_delete_business(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_delete_business(uuid, timestamptz) TO rekoda_worker;
