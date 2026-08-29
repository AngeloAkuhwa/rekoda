-- The public API's foundation: applications, keys, per-key rate limits
-- (PR-109, canonical spec §27).
--
-- Spec §27 makes the public API "a separate commercial entitlement", so the
-- credential that opens it needs its own record — a session cannot stand in
-- for it. A session belongs to a PERSON and dies with them; an API key
-- belongs to an APPLICATION the merchant registered and outlives every
-- individual sign-in.
--
-- Three shapes, and the split is deliberate:
--
--   api_applications    what the merchant registered and named. The unit the
--                       API_APPLICATIONS meter counts (spec §4.2).
--   api_keys            a credential FOR an application. Rotatable without
--                       re-registering; revocable one at a time.
--   api_key_rate_windows  the per-key ceiling, one row per key per minute,
--                       with the limit in the WHERE clause the way every
--                       other ceiling in this estate is enforced.
--
-- The interesting decision is at the bottom of this file: these tables are
-- under RLS like every other business-owned table, and the one read that
-- CANNOT be pinned — resolving a bearer token before its tenant is known —
-- goes through a single SECURITY DEFINER function instead of leaving a
-- credential table outside the policy.

CREATE TABLE IF NOT EXISTS api_applications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name        text NOT NULL,
  -- Disabling an application refuses every key it issued, in one act. A
  -- merchant who suspects an integration does not want to hunt keys.
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One name per business, so a double-tapped "Register" is one application
-- rather than two identical rows the merchant then cannot tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS api_applications_business_name_ux
  ON api_applications (business_id, lower(name));

CREATE TABLE IF NOT EXISTS api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  application_id uuid NOT NULL REFERENCES api_applications(id),
  -- The public half: `rk_live_` plus eight hex characters. Shown in the
  -- dashboard, safe in a log line, and identifiable enough that a secret
  -- scanner can recognise a leaked Rekoda key on sight.
  prefix         text NOT NULL,
  -- SHA-256 of the WHOLE token. The token itself exists exactly once, in
  -- the response that minted it; there is no column it could be read from
  -- and no support path that can recover it.
  token_hash     text NOT NULL,
  label          text,
  -- Requests per minute for this key. Per key rather than per business, so
  -- one noisy integration cannot spend another's headroom.
  rate_limit_per_minute integer NOT NULL DEFAULT 120
                   CHECK (rate_limit_per_minute > 0),
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_token_hash_ux ON api_keys (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_ux ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS api_keys_application_ix ON api_keys (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_keys_business_ix ON api_keys (business_id, created_at DESC);

-- The ceiling, counted the way `ai_quota_counters` counts: one row per key
-- per minute, incremented by an UPDATE whose WHERE carries the limit. A
-- read-then-decide rate limiter is not a ceiling — two requests arriving
-- together both see 119 against 120 and both proceed.
CREATE TABLE IF NOT EXISTS api_key_rate_windows (
  api_key_id   uuid NOT NULL REFERENCES api_keys(id),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  window_start timestamptz NOT NULL,
  calls        integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (api_key_id, window_start)
);

-- ── tenancy ────────────────────────────────────────────────────────────────
-- Business-owned rows, so they live under the same policy as every other
-- business-owned row (0001). Nothing here is reference data and nothing
-- here is cross-tenant by nature EXCEPT the resolve below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_applications', 'api_keys', 'api_key_rate_windows']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)
         WITH CHECK (business_id = nullif(current_setting(''app.business_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;

-- The worker has no business with API credentials. 0001's default privileges
-- granted it full DML on every future table, so the narrowing is explicit.
REVOKE SELECT, INSERT, UPDATE, DELETE ON api_applications FROM rekoda_worker;
REVOKE SELECT, INSERT, UPDATE, DELETE ON api_keys FROM rekoda_worker;
REVOKE SELECT, INSERT, UPDATE, DELETE ON api_key_rate_windows FROM rekoda_worker;

-- A key is minted and revoked; it is never edited into a different key.
-- UPDATE is needed for exactly two columns (`last_used_at`, `revoked_at`),
-- which is why it survives, but DELETE does not: a revoked key must stay
-- readable, because "which key was that, and when did we kill it" is the
-- first question asked after a leak.
REVOKE DELETE ON api_keys FROM rekoda_app;
REVOKE DELETE ON api_applications FROM rekoda_app;

-- ── the one read that cannot be pinned ─────────────────────────────────────
-- Authentication happens before the tenant is known: the caller presents a
-- bearer token and the business it belongs to is the ANSWER, not an input.
-- 0001 solved this class for sessions by leaving the table outside RLS
-- entirely. That is not good enough here, because unlike a session an API
-- key is also a merchant-managed object — listed, labelled and revoked from
-- the dashboard — so the table must be under the policy for every one of
-- those reads.
--
-- So the cross-tenant reach is a FUNCTION rather than an unprotected table,
-- the same move migration 0004 made when it turned "may claim any tenant's
-- job" into a role: bounded, named, visible in \df, and granted to exactly
-- one role. It answers only when handed the exact SHA-256 of a live token,
-- returns at most one row, and returns no secret — not the hash it was
-- given, not the label, nothing a caller could not have already known.
--
-- search_path is pinned pg_catalog, pg_temp and every reference is
-- schema-qualified (migration 0109): a SECURITY DEFINER body that resolves
-- `api_keys` through a caller-controlled search_path is the temp-table
-- shadowing class, and this is the exact shape that class needs.
CREATE OR REPLACE FUNCTION api_key_resolve(hash text)
RETURNS TABLE (
  id                    uuid,
  business_id           uuid,
  application_id        uuid,
  prefix                text,
  rate_limit_per_minute integer,
  last_used_at          timestamptz,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  application_status    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT k.id,
         k.business_id,
         k.application_id,
         k.prefix,
         k.rate_limit_per_minute,
         k.last_used_at,
         k.expires_at,
         k.revoked_at,
         a.status
    FROM public.api_keys k
    JOIN public.api_applications a ON a.id = k.application_id
   WHERE k.token_hash = hash
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION api_key_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_resolve(text) TO rekoda_app;

COMMENT ON TABLE api_applications IS
  'A registered consumer of the public API (canonical spec §27). The unit '
  'the API_APPLICATIONS meter counts.';
COMMENT ON TABLE api_keys IS
  'Bearer credentials for the public API. SHA-256 only — the token exists '
  'once, in the response that minted it.';
COMMENT ON FUNCTION api_key_resolve(text) IS
  'The single cross-tenant read the API keys tables allow: resolve a token '
  'hash to the tenant it authenticates. Returns no secret.';
