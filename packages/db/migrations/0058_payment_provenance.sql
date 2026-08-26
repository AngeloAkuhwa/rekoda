-- Provenance columns on `payments` (canonical spec §6.2, §6.3; PR-004).
--
-- The build plan calls this 0053_payment_provenance; 0053 was taken while
-- R0A-ii waited, so it is 0058. Additive: every existing row keeps NULL,
-- which is honest, because nothing has been established about it yet.
-- `verified` is untouched; it retires in PR-009, not here.

ALTER TABLE payments
  ADD COLUMN initial_confirmation_source text
    CHECK (initial_confirmation_source IS NULL OR initial_confirmation_source IN (
      'PROVIDER_VERIFIED', 'BANK_FEED_MATCH', 'MERCHANT_ATTESTED',
      'MANUAL_RECONCILIATION', 'LEGACY_PROVENANCE_UNKNOWN')),
  ADD COLUMN payment_method text
    CHECK (payment_method IS NULL OR payment_method IN (
      'CASH', 'BANK_TRANSFER', 'POS', 'CARD', 'USSD', 'WALLET', 'OTHER', 'UNKNOWN')),
  ADD COLUMN evidence_basis text,
  ADD COLUMN payment_evidence_id uuid REFERENCES payment_evidence(id);

-- `LEGACY_PROVENANCE_UNKNOWN` is legal HERE and illegal on the verification
-- event table, and that asymmetry is the whole of §6.2: it is an initial
-- historical state, never an act of verifying. `UNKNOWN` is kept as a method
-- because forcing an unestablishable instrument into OTHER would claim
-- knowledge the estate does not have.

/* ── the private schema and the privilege boundary ─────────────────────────
 * A SECURITY DEFINER function runs as its owner, so the owner IS the
 * boundary. A dedicated NON-LOGIN role: not a human's account, not the
 * superuser, nothing to steal a password for. BYPASSRLS because a manifest
 * rollback spans every tenant and pins none.                               */
DO $$ BEGIN
  CREATE ROLE rekoda_provenance_owner NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS rekoda_private;
REVOKE ALL ON SCHEMA rekoda_private FROM PUBLIC;
GRANT USAGE ON SCHEMA rekoda_private TO rekoda_provenance_owner;
-- rekoda_app and rekoda_worker get nothing, not even USAGE: an application
-- role that cannot name the schema cannot probe what lives in it.

/* ── set-once, enforced by the database rather than a comment ─────────────
 * §6.3: `initialConfirmationSource` is set once, at creation, immutable.
 * NULL → value is permitted exactly once. value → anything else is refused
 * unconditionally — for the application, for remediation, for a repair
 * script, and for a future writer nobody has thought of.
 *
 * The one exemption is the role, not a flag. Inside the SECURITY DEFINER
 * rollback below, current_user is the function's owner; nothing else runs as
 * a NOLOGIN role it holds no membership in. There is no session setting, GUC
 * or migration_mode that reaches this branch, because a general escape hatch
 * is a permanent one: the next person to need it will find it rather than
 * justify a new one.                                                       */
CREATE OR REPLACE FUNCTION rekoda_private.payments_initial_source_set_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = rekoda_private, pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.initial_confirmation_source IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_user = 'rekoda_provenance_owner' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'payments.initial_confirmation_source is set once; correction is a PaymentVerification, never a rewrite (spec 6.3)';
END $$;

DROP TRIGGER IF EXISTS payments_initial_source_set_once ON payments;
CREATE TRIGGER payments_initial_source_set_once
  BEFORE UPDATE ON payments
  FOR EACH ROW
  WHEN (OLD.initial_confirmation_source IS DISTINCT FROM NEW.initial_confirmation_source)
  EXECUTE FUNCTION rekoda_private.payments_initial_source_set_once();

/* ── the rollback's own audit ─────────────────────────────────────────────
 * Not `audit_events`: that is a tenant table with a NOT NULL business_id,
 * and a manifest rollback spans every tenant. Operator infrastructure gets
 * an operator table, in the schema the application cannot name.            */
CREATE TABLE IF NOT EXISTS rekoda_private.provenance_rollback_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id         uuid NOT NULL,
  operator            text NOT NULL,
  reason              text NOT NULL,
  rows_affected       integer NOT NULL,
  rows_skipped        integer NOT NULL,
  skipped_payment_ids uuid[] NOT NULL DEFAULT '{}',
  occurred_at         timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT, SELECT ON rekoda_private.provenance_rollback_audit TO rekoda_provenance_owner;

/* ── the named, scoped exemption ──────────────────────────────────────────
 * rollback_provenance_manifest is the ONLY path that can reset an assigned
 * initial_confirmation_source, and its whole body is auditable. A superuser
 * bypassing a trigger is not an exemption anybody designed; a function with
 * a name, a grant and a scope is.
 *
 * The skip is the part that matters. An owner may legitimately have
 * remediated a payment after the migration ran, and a rollback that
 * overwrote their correction would be a second incident caused by fixing
 * the first. A row is touched ONLY where its current value is exactly what
 * this manifest assigned; anything else is skipped, counted and returned.
 *
 * Rollback appends state. It DELETEs no verification and no manifest row:
 * it appends revocations, releases the claims, and marks the manifest
 * ROLLED_BACK, leaving a complete record of the migration and its undoing. */
CREATE OR REPLACE FUNCTION rekoda_private.rollback_provenance_manifest(
  p_manifest_id uuid,
  p_operator    text,
  p_reason      text
) RETURNS TABLE (rows_affected integer, rows_skipped integer, skipped_payment_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rekoda_private, pg_catalog, pg_temp
AS $$
DECLARE
  v_status   text;
  v_affected integer;
  v_skipped  uuid[];
BEGIN
  IF p_operator IS NULL OR btrim(p_operator) = '' THEN
    RAISE EXCEPTION 'an operator is required; an unattributed rollback is not an audit record';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required; a missing reason is a refusal, not a blank field';
  END IF;

  /* Scope is validated HERE, by the function, never trusted from a caller. */
  SELECT status INTO v_status
  FROM public.migration_manifests WHERE id = p_manifest_id
  FOR UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'manifest % does not exist', p_manifest_id;
  END IF;
  IF v_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'manifest % is %, and only a COMPLETED migration can be rolled back',
      p_manifest_id, v_status;
  END IF;

  /* Skips computed BEFORE the update: a row whose current value is not what
   * this manifest assigned was changed by somebody since, and their change
   * survives. Reported, never silent. */
  SELECT coalesce(array_agg(i.payment_id ORDER BY i.payment_id), '{}')
  INTO v_skipped
  FROM public.migration_manifest_items i
  JOIN public.payments p ON p.id = i.payment_id
  WHERE i.manifest_id = p_manifest_id
    AND p.initial_confirmation_source IS DISTINCT FROM i.new_initial_source;

  WITH restored AS (
    UPDATE public.payments p
    SET initial_confirmation_source = i.old_initial_source
    FROM public.migration_manifest_items i
    WHERE i.manifest_id = p_manifest_id
      AND p.id = i.payment_id
      AND p.initial_confirmation_source IS NOT DISTINCT FROM i.new_initial_source
    RETURNING p.id
  )
  SELECT count(*)::integer INTO v_affected FROM restored;

  /* The verifications the migration wrote are revoked, never deleted, and
   * their claims are released in the same transaction — §6.4's shape, run
   * in bulk. ON CONFLICT keeps a re-run from double-revoking. */
  INSERT INTO public.payment_verification_revocations
    (business_id, verification_id, reason, actor_id)
  SELECT i.business_id, i.verification_id,
         'manifest rollback: ' || p_reason, p_operator
  FROM public.migration_manifest_items i
  WHERE i.manifest_id = p_manifest_id AND i.verification_id IS NOT NULL
  ON CONFLICT (verification_id) DO NOTHING;

  DELETE FROM public.payment_verification_claims c
  USING public.migration_manifest_items i
  WHERE i.manifest_id = p_manifest_id
    AND i.verification_id IS NOT NULL
    AND c.verification_id = i.verification_id;

  UPDATE public.migration_manifests
  SET status = 'ROLLED_BACK',
      rolled_back_at = now(),
      rolled_back_by = p_operator,
      reason = p_reason
  WHERE id = p_manifest_id;

  INSERT INTO rekoda_private.provenance_rollback_audit
    (manifest_id, operator, reason, rows_affected, rows_skipped, skipped_payment_ids)
  VALUES (p_manifest_id, p_operator, p_reason,
          v_affected, coalesce(array_length(v_skipped, 1), 0), v_skipped);

  RETURN QUERY SELECT v_affected, coalesce(array_length(v_skipped, 1), 0), v_skipped;
END $$;

/* ── ownership and privilege ──────────────────────────────────────────────
 * PostgreSQL grants EXECUTE to PUBLIC by default, and not revoking it is
 * the single most common way a definer function becomes a public one. */
ALTER FUNCTION rekoda_private.rollback_provenance_manifest(uuid, text, text)
  OWNER TO rekoda_provenance_owner;
REVOKE EXECUTE ON FUNCTION rekoda_private.rollback_provenance_manifest(uuid, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rekoda_private.rollback_provenance_manifest(uuid, text, text)
  TO rekoda;
-- Never rekoda_app, never rekoda_worker. They also hold no USAGE on the
-- schema, so the function is doubly out of their reach.

/* What the owner role itself may touch: exactly what the body needs. */
GRANT SELECT, UPDATE ON payments TO rekoda_provenance_owner;
GRANT SELECT, UPDATE ON migration_manifests TO rekoda_provenance_owner;
GRANT SELECT ON migration_manifest_items TO rekoda_provenance_owner;
GRANT SELECT, INSERT ON payment_verification_revocations TO rekoda_provenance_owner;
GRANT SELECT, DELETE ON payment_verification_claims TO rekoda_provenance_owner;
GRANT SELECT ON payment_verifications TO rekoda_provenance_owner;
