-- Security review hardening (PR-106, S1).
--
-- Seven database-layer fixes from the S1 adversarial review. Each closes a
-- gap where a control was STATED (in a comment, in a neighbouring table)
-- but not delivered by the schema. None changes application behaviour; each
-- narrows a privilege the runtime never legitimately uses.

-- ── 1. Kill the temp-table shadowing class (review finding: SECURITY
-- DEFINER + unqualified reads) ───────────────────────────────────────────
--
-- PostgreSQL searches pg_temp FIRST for a relation unless pg_temp is named
-- LATER in search_path. A role that can CREATE TEMP TABLE can therefore
-- shadow an unqualified `businesses` / `accounting_periods` / `ledger_*`
-- read inside a SECURITY INVOKER trigger or a SET search_path=public
-- function, defeating the very invariants the database is meant to make
-- unrepresentable. Neither app nor worker role has any legitimate need to
-- create temp tables. Revoking the privilege removes the whole class at
-- once, beneath every individual trigger.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM rekoda_app', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM rekoda_worker', current_database());
END $$;

-- And pin the one SECURITY DEFINER function that read its guard tables
-- unqualified to the estate's known-good form (migration 0058): pg_temp
-- LAST so it is never searched first, and every public reference
-- schema-qualified so a shadow cannot resolve even if the privilege above
-- were ever restored. The body is otherwise identical to migration 0022.
CREATE OR REPLACE FUNCTION retention_delete_business(
  target uuid,
  cutoff timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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

  DELETE FROM public.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.owner_user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  INSERT INTO public.retention_deletions (business_id, reason, rows_deleted)
  VALUES (target, 'abandoned_trial', removed)
  ON CONFLICT (business_id) DO NOTHING;

  RETURN removed;
END;
$$;

-- ── 2. The public shop read must not expose UNPUBLISHED shops ─────────────
--
-- `shop_public_read USING (true)` let any authenticated tenant SELECT every
-- other merchant's reserved-but-unpublished row - slug, display name,
-- tagline, and the owner's WhatsApp number. The repo filtered on
-- `published_at IS NOT NULL`, which is exactly the promise the table's own
-- header said it had replaced with a boundary. The owner still reads their
-- own draft through the FOR ALL tenant-write policy (which covers SELECT
-- under the pin), so this only removes the cross-tenant leak.
DROP POLICY shop_public_read ON shops;
CREATE POLICY shop_public_read ON shops
  FOR SELECT
  USING (published_at IS NOT NULL);

-- ── 3. retention_deletions is proof-of-deletion; the app may not rewrite it ─
--
-- The 0001 default privileges left both roles holding full DML on it. It is
-- the evidence a deletion happened; the merchant-facing role gets no write.
REVOKE INSERT, UPDATE, DELETE ON retention_deletions FROM rekoda_app;
REVOKE UPDATE, DELETE ON retention_deletions FROM rekoda_worker;

-- ── 4. Statutory tax rates are immutable observations (§13) ───────────────
--
-- Like exchange_rate_snapshots (0069) and provider_cost_schedules (0094):
-- the in-force value is DERIVED from effective-dated rows, never edited.
-- Rewriting a historical rate silently changes every VAT figure and tax
-- point reconstructed from it.
REVOKE UPDATE, DELETE ON tax_rates FROM rekoda_app;
REVOKE UPDATE, DELETE ON tax_codes FROM rekoda_app;

-- ── 5. A tenant may not attribute a platform cost to another tenant ───────
--
-- platform_cost_events has no RLS (the margin engine sweeps every tenant on
-- the worker credential), and the app keeps INSERT for the usage bridge -
-- but business_id came straight from the caller with nothing tying it to
-- the pinned tenant, so an app path could append an immutable, undeletable
-- cost fact against any other business id. A BEFORE INSERT trigger closes
-- it: when a tenant is pinned, the row's business_id must be that tenant;
-- an unpinned writer (the worker, a future settlement-fee path) is
-- unaffected. Pinned search_path so the trigger cannot itself be shadowed.
CREATE OR REPLACE FUNCTION platform_cost_events_tenant_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  pinned text := nullif(current_setting('app.business_id', true), '');
BEGIN
  IF pinned IS NOT NULL AND (NEW.business_id IS NULL OR NEW.business_id <> pinned::uuid) THEN
    RAISE EXCEPTION 'platform_cost_events: a pinned tenant may only attribute cost to itself';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_cost_events_tenant_write_check
  BEFORE INSERT ON platform_cost_events
  FOR EACH ROW EXECUTE FUNCTION platform_cost_events_tenant_write();

-- ── 6. A numbered, ledger-linked bill may not be hard-deleted (§31.9) ─────
--
-- Every neighbouring fact table in the 0088-0108 range revokes DELETE and
-- cites invariant 9; bills was the one that did not, so a numbered payable
-- with a ledger_transaction_id could be erased, orphaning its posting and
-- holing the bill sequence. `voided` is the intended terminal state.
REVOKE DELETE ON bills FROM rekoda_app;
REVOKE DELETE ON bills FROM rekoda_worker;
