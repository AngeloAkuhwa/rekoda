-- Add-ons and usage packs as data (PR-101, canonical spec §30).
--
-- The last two commercial shapes §30 names, on the same discipline as the
-- plan catalogue (0105): versioned, effective-dated, seeded from the
-- constants the application still holds as its rollback path, read-only to
-- both app roles, one open version per key.
--
--   AddOn      a recurring capability purchased alongside a plan
--   UsagePack  a one-off block of units
--
-- A pack purchase is one-off, so a row here is the OFFER, not a holding:
-- what a merchant bought lives in subscription_charges (kind add_on), and
-- the version in force when the charge was opened decides what settling it
-- credits - a repricing between purchase and webhook must not change what
-- was bought.

CREATE TABLE IF NOT EXISTS usage_packs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The stable key charges reference (subscription_charges.pack_id).
  pack_id        text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  label          text NOT NULL,
  unit           text NOT NULL CHECK (unit IN (
                   'AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENT_GENERATION',
                   'DOCUMENTS_UNDERSTOOD', 'SERVICE_MESSAGE', 'UTILITY_TEMPLATE',
                   'AUTH_TEMPLATE', 'AUTH_INTL_TEMPLATE', 'MARKETING_TEMPLATE',
                   'CATALOGUE_ORDERS', 'PAYMENT_CONNECTIONS',
                   'FINANCIAL_ACCOUNT_CONNECTIONS', 'ACCOUNTANT_USERS',
                   'REPORT_EXPORTS', 'API_REQUEST_UNITS', 'API_APPLICATIONS',
                   'WEBHOOK_DELIVERIES')),
  -- In SOLD units (minutes of voice), like allowance_versions. UNIT_SCALE
  -- stays in code: how a unit is counted is not a commercial decision.
  quantity       integer NOT NULL CHECK (quantity > 0),
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz CHECK (effective_to IS NULL OR effective_to > effective_from),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_packs_open_uniq
  ON usage_packs (pack_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS add_ons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_id        text NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  name             text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly')),
  -- Null means not self-service purchasable: pricing-model.md sells the
  -- additional WhatsApp number "Custom initially", and a null price is that
  -- fact as data rather than a sentinel somebody has to know about.
  price_minor      bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from   timestamptz NOT NULL,
  effective_to     timestamptz CHECK (effective_to IS NULL OR effective_to > effective_from),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (add_on_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS add_ons_open_uniq
  ON add_ons (add_on_id) WHERE effective_to IS NULL;

-- Same rule as 0105 and 0052: the application reads the catalogue and may
-- never write it.
REVOKE INSERT, UPDATE, DELETE ON usage_packs FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON usage_packs FROM rekoda_worker;
REVOKE INSERT, UPDATE, DELETE ON add_ons FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON add_ons FROM rekoda_worker;

-- Version 1: docs/pricing-model.md's add-on table, verbatim, in sold units.
INSERT INTO usage_packs
  (pack_id, version, label, unit, quantity, price_minor, currency, effective_from)
VALUES
  ('messages_100', 1, '100 extra WhatsApp messages', 'AI_ACTIONS',
   100, 250000, 'NGN', '2026-08-01T00:00:00Z'),
  ('voice_30min', 1, '30 extra voice minutes', 'VOICE_MINUTES',
   30, 150000, 'NGN', '2026-08-01T00:00:00Z'),
  ('documents_50', 1, '50 extra document generations', 'DOCUMENT_GENERATION',
   50, 200000, 'NGN', '2026-08-01T00:00:00Z'),
  ('orders_50', 1, '50 extra Integrate orders', 'CATALOGUE_ORDERS',
   50, 500000, 'NGN', '2026-08-01T00:00:00Z')
ON CONFLICT (pack_id, version) DO NOTHING;

INSERT INTO add_ons
  (add_on_id, version, name, billing_interval, price_minor, currency, effective_from)
VALUES
  ('extra_seat', 1, 'Extra accountant or delegate seat', 'monthly',
   150000, 'NGN', '2026-08-01T00:00:00Z'),
  ('extra_waba_number', 1, 'Additional WhatsApp number', 'monthly',
   NULL, 'NGN', '2026-08-01T00:00:00Z')
ON CONFLICT (add_on_id, version) DO NOTHING;

COMMENT ON TABLE usage_packs IS
  'One-off blocks of units (canonical spec §30). Versioned and '
  'effective-dated: settling a charge credits the version in force when the '
  'charge was opened, so a repricing never changes what was bought.';
COMMENT ON TABLE add_ons IS
  'Recurring capabilities purchased alongside a plan (spec §30). A null '
  'price_minor means not self-service purchasable. The extra seat is here '
  'rather than in usage_packs because a seat is standing capacity, not a '
  'quantity consumed.';
