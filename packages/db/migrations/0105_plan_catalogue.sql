-- Plans as data (PR-099, canonical spec §30). BL2 begins.
--
-- "Commercial prices must not be hardcoded in application logic. Today's
-- allowance table is a TypeScript constant with five units and five plan ids
-- (DRIFTED); BL2 replaces it with data." This migration is step A of that
-- replacement (build plan §10): the tables exist, version 1 is seeded from
-- the constants the application still reads, and NOTHING reads these rows
-- yet. PR-100 is the cutover; PR-101 adds add-ons and usage packs.
--
-- The shape is the spec's, verbatim:
--
--   PlanVersion       a named set of entitlements and allowances, effective-dated
--   PlanPrice         a price for a plan version, in a currency, effective-dated
--   AllowanceVersion  the allowance table for a plan version
--
-- Only PlanVersion and PlanPrice carry effective dates. An allowance row is
-- an immutable attribute of its version: changing what a plan sells IS a new
-- plan version, which is what makes grandfathering meaningful. Changing what
-- a version costs, without changing what it sells, is a new price row on the
-- same version - a launch-cohort repricing must not strand the cohort on a
-- version that no longer exists.

CREATE TABLE IF NOT EXISTS plan_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id        text NOT NULL
                 CHECK (plan_id IN ('trial', 'expired', 'chat', 'integrate', 'complete')),
  version        integer NOT NULL CHECK (version >= 1),
  name           text NOT NULL,
  -- Team seats beyond the owner (pricing-model.md's "owner + N"). Commercial
  -- data like everything else here, so it versions with the plan rather than
  -- living in a constant beside the allowances it does not scale with.
  seats          integer NOT NULL CHECK (seats >= 0),
  effective_from timestamptz NOT NULL,
  -- Null means current. Closed when a successor version is published, at the
  -- successor's effective_from, so at any moment exactly one version of a
  -- plan answers "what does this plan sell today".
  effective_to   timestamptz CHECK (effective_to IS NULL OR effective_to > effective_from),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

-- At most one open version per plan. The partial unique is what makes
-- publishing a successor without closing the predecessor a database error
-- rather than a data bug someone finds at billing time.
CREATE UNIQUE INDEX IF NOT EXISTS plan_versions_open_uniq
  ON plan_versions (plan_id) WHERE effective_to IS NULL;

-- What a version grants, against the PR-012 catalogue. Complete stays the
-- PAIR (spec §3.3): its rows are REKODA_CHAT and REKODA_INTEGRATE, and no
-- REKODA_COMPLETE key exists to reference.
CREATE TABLE IF NOT EXISTS plan_version_entitlements (
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  entitlement_key text NOT NULL REFERENCES entitlements(key),
  PRIMARY KEY (plan_version_id, entitlement_key)
);

CREATE TABLE IF NOT EXISTS plan_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_versions(id),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  -- Minor units of the currency: kobo for NGN. Zero is a real price - a
  -- trial earns nothing and the margin view should say so - never a gap.
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  effective_from   timestamptz NOT NULL,
  effective_to     timestamptz CHECK (effective_to IS NULL OR effective_to > effective_from),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One open price per (version, currency, interval). History accumulates as
-- closed rows: a repricing closes the open row and appends, and the row a
-- historical charge was computed from is never touched. That is the BL2
-- gate's "a price change does not alter a historical charge", enforced by
-- shape rather than by discipline.
CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_open_uniq
  ON plan_prices (plan_version_id, currency, billing_interval)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS allowance_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  -- The seventeen canonical §4.2 units. The CHECK mirrors core's USAGE_UNITS
  -- deliberately: an eighteenth unit needs a migration here exactly as it
  -- needs a UNIT_SCALE decision there, so a unit cannot arrive half-defined.
  unit            text NOT NULL CHECK (unit IN (
                    'AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENT_GENERATION',
                    'DOCUMENTS_UNDERSTOOD', 'SERVICE_MESSAGE', 'UTILITY_TEMPLATE',
                    'AUTH_TEMPLATE', 'AUTH_INTL_TEMPLATE', 'MARKETING_TEMPLATE',
                    'CATALOGUE_ORDERS', 'PAYMENT_CONNECTIONS',
                    'FINANCIAL_ACCOUNT_CONNECTIONS', 'ACCOUNTANT_USERS',
                    'REPORT_EXPORTS', 'API_REQUEST_UNITS', 'API_APPLICATIONS',
                    'WEBHOOK_DELIVERIES')),
  -- In the units a merchant is SOLD - minutes of voice, not the seconds the
  -- meter stores. UNIT_SCALE stays in core: how a unit is counted is a
  -- counting rule, not a commercial decision, and it does not version.
  --
  -- A unit with no row is not sold on that version, which the meter reads as
  -- zero. 0 MEANS ZERO, never unlimited (owner decision, 26 Aug 2026); if an
  -- unlimited allowance is ever sold it gets its own representation.
  allowance       integer NOT NULL CHECK (allowance >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_version_id, unit)
);

-- No RLS on any of the four: one catalogue for every tenant, same as the
-- entitlements catalogue (migration 0052). And like that catalogue, the
-- application may never write it - a service that can append its own price
-- row has no pricing model left to enforce. Versioning belongs to migrations
-- and, later, to an operator surface with its own credential.
REVOKE INSERT, UPDATE, DELETE ON plan_versions FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON plan_versions FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE ON plan_version_entitlements FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON plan_version_entitlements FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE ON plan_prices FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON plan_prices FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE ON allowance_versions FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON allowance_versions FROM rekoda_worker;

-- The grandfathering pin (BL2 gate: "a grandfathered business keeps its
-- pinned plan version"). Null means the business floats on the current open
-- version of `businesses.plan`; a pin holds it to the version it was sold.
-- Additive and unwritten in this PR - the writers arrive with the PR-100
-- cutover, launch-cohort pinning with them (pricing-model.md commercial
-- rule 5: the launch cohort keeps launch pricing for at least 12 months).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS
  plan_version_id uuid REFERENCES plan_versions(id);

-- ── Version 1: the constants, as data ────────────────────────────────────
--
-- Seeded from packages/core/src/allowances.ts and entitlements.ts exactly as
-- they stand, so PR-100 can prove data-equals-constant before any reader
-- moves. The effective date is the first of the current billing month: every
-- existing business predates the catalogue and must resolve to version 1.

INSERT INTO plan_versions (plan_id, version, name, seats, effective_from) VALUES
  ('trial',     1, 'Free Trial',       1, '2026-08-01T00:00:00Z'),
  ('expired',   1, 'Expired',          0, '2026-08-01T00:00:00Z'),
  ('chat',      1, 'Rekoda Chat',      1, '2026-08-01T00:00:00Z'),
  ('integrate', 1, 'Rekoda Integrate', 2, '2026-08-01T00:00:00Z'),
  ('complete',  1, 'Rekoda Complete',  3, '2026-08-01T00:00:00Z')
ON CONFLICT (plan_id, version) DO NOTHING;

INSERT INTO plan_version_entitlements (plan_version_id, entitlement_key)
SELECT v.id, e.key
FROM plan_versions v
JOIN (VALUES
  ('trial',     'REKODA_CHAT'),
  ('trial',     'REKODA_INTEGRATE'),
  ('chat',      'REKODA_CHAT'),
  ('integrate', 'REKODA_INTEGRATE'),
  ('complete',  'REKODA_CHAT'),
  ('complete',  'REKODA_INTEGRATE')
) AS e(plan_id, key) ON e.plan_id = v.plan_id AND v.version = 1
ON CONFLICT DO NOTHING;

-- PLAN_PRICES_K, plus the annual prices pricing-model.md quotes (10 times
-- monthly, two months free) which the constant never carried. Trial and
-- expired get an explicit monthly zero: nobody is billed for either, and a
-- zero row says so where a missing row would only imply it.
INSERT INTO plan_prices
  (plan_version_id, currency, billing_interval, amount_minor, effective_from)
SELECT v.id, 'NGN', p.billing_interval, p.amount_minor, v.effective_from
FROM plan_versions v
JOIN (VALUES
  ('trial',     'monthly', 0),
  ('expired',   'monthly', 0),
  ('chat',      'monthly',   990000::bigint),
  ('chat',      'annual',   9900000::bigint),
  ('integrate', 'monthly',  1990000::bigint),
  ('integrate', 'annual',  19900000::bigint),
  ('complete',  'monthly',  2990000::bigint),
  ('complete',  'annual',  29900000::bigint)
) AS p(plan_id, billing_interval, amount_minor)
  ON p.plan_id = v.plan_id AND v.version = 1
ON CONFLICT DO NOTHING;

-- PLAN_ALLOWANCES, sold units only. `expired` has no rows: it sells nothing,
-- and absence is how this table says zero.
INSERT INTO allowance_versions (plan_version_id, unit, allowance)
SELECT v.id, a.unit, a.allowance
FROM plan_versions v
JOIN (VALUES
  ('trial',     'AI_ACTIONS',            50),
  ('trial',     'VOICE_MINUTES',         10),
  ('trial',     'DOCUMENT_GENERATION',   25),
  ('trial',     'DOCUMENTS_UNDERSTOOD',  10),
  ('trial',     'CATALOGUE_ORDERS',      10),
  ('chat',      'AI_ACTIONS',           400),
  ('chat',      'VOICE_MINUTES',         60),
  ('chat',      'DOCUMENT_GENERATION',  100),
  ('chat',      'DOCUMENTS_UNDERSTOOD',  50),
  ('chat',      'UTILITY_TEMPLATE',      25),
  ('integrate', 'DOCUMENT_GENERATION',  500),
  ('integrate', 'CATALOGUE_ORDERS',     300),
  ('integrate', 'UTILITY_TEMPLATE',     100),
  ('complete',  'AI_ACTIONS',          1200),
  ('complete',  'VOICE_MINUTES',        120),
  ('complete',  'DOCUMENT_GENERATION',  750),
  ('complete',  'DOCUMENTS_UNDERSTOOD', 200),
  ('complete',  'CATALOGUE_ORDERS',     300),
  ('complete',  'UTILITY_TEMPLATE',     150)
) AS a(plan_id, unit, allowance) ON a.plan_id = v.plan_id AND v.version = 1
ON CONFLICT DO NOTHING;

COMMENT ON TABLE plan_versions IS
  'What one version of one plan sold (canonical spec §30). Append-only in '
  'practice: a change to what a plan sells is a new version, and closing '
  'effective_to is the only edit an existing row ever takes.';
COMMENT ON TABLE plan_prices IS
  'What one plan version cost, in a currency, over a period (spec §30). A '
  'repricing closes the open row and appends; historical rows are never '
  'touched, so a historical charge always finds the price it was computed '
  'from.';
COMMENT ON TABLE allowance_versions IS
  'The allowance table for one plan version, in sold units (spec §30). A '
  'unit with no row is not sold: zero, never unlimited.';
COMMENT ON COLUMN businesses.plan_version_id IS
  'The grandfathering pin (spec §30). Null floats on the current open '
  'version of businesses.plan; non-null holds the business to the version '
  'it was sold. Unwritten until the PR-100 cutover.';
