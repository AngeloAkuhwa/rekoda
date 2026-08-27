-- ProviderCapability (spec §17, §18; P3, PR-068).
--
-- "An adapter existing in the codebase is not the same as it being
-- available to a merchant" (§18). This table is where that sentence
-- becomes data: WHAT each provider may do on this platform, and — where
-- it may not — WHICH external blocker says so, in the build plan's own
-- words. The resolver reads it; nobody hardcodes a default provider ever
-- again.
--
-- GLOBAL reference data, deliberately: which providers the PLATFORM may
-- offer is not tenant state (each merchant's own standing lives on their
-- connection's four §17.1 axes). No RLS for the same reason the chart's
-- role vocabulary has none — there is no tenant to scope by — and
-- read-only to both runtime roles: capability changes are OPEN
-- COMMERCIAL / OPEN COMPLIANCE decisions that arrive as migrations or an
-- operator's hand, never as an application write path.

CREATE TABLE provider_capabilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type  text NOT NULL,
  /* §18's three ports: a provider that does two things has two rows. */
  capability     text NOT NULL CHECK (capability IN ('COLLECT', 'FEED', 'PAYOUT')),
  status         text NOT NULL DEFAULT 'BLOCKED' CHECK (status IN ('AVAILABLE', 'BLOCKED')),
  /* WHY it is blocked — the external blocker by name. Null once available. */
  reason         text,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_capabilities_ux UNIQUE (provider_type, capability),
  CONSTRAINT provider_capabilities_reasoned CHECK (
    (status = 'BLOCKED' AND reason IS NOT NULL) OR (status = 'AVAILABLE')
  )
);

REVOKE INSERT, UPDATE, DELETE ON provider_capabilities FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON provider_capabilities FROM rekoda_worker;

/* The platform's standing today, per the build plan's external-blockers
 * table. Paystack COLLECT is AVAILABLE at the platform level — the estate
 * already transacts on it, and each merchant's own §47 written
 * confirmation is a PER-CONNECTION commercial gate (commercial_status),
 * not a platform capability. Everything else waits on its named blocker,
 * and unblocking is a DATA change. */
INSERT INTO provider_capabilities (provider_type, capability, status, reason) VALUES
  ('paystack', 'COLLECT', 'AVAILABLE', NULL),
  ('mono', 'COLLECT', 'BLOCKED', 'OPEN COMMERCIAL: Mono production terms (build plan, external blockers)'),
  ('mono', 'FEED', 'BLOCKED', 'OPEN COMMERCIAL: Mono production terms (build plan, external blockers)'),
  ('opay', 'COLLECT', 'BLOCKED', 'OPEN COMMERCIAL: OPay production access (build plan, external blockers)'),
  ('opay', 'FEED', 'BLOCKED', 'OPEN COMMERCIAL: OPay production access (build plan, external blockers)'),
  ('kuda', 'COLLECT', 'BLOCKED', 'OPEN COMPLIANCE: Kuda regulatory and commercial approval (build plan, external blockers)'),
  ('kuda', 'FEED', 'BLOCKED', 'OPEN COMPLIANCE: Kuda regulatory and commercial approval (build plan, external blockers)');
