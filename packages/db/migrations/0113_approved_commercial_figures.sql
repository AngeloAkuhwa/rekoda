-- The commercial figures the owner approved on 28 August 2026 (PR-117).
--
-- Every number here is a decision this build declined to invent and waited
-- for. They arrive as DATA, into version 1 of the catalogue, because
-- version 1 has never been sold: the product is pre-launch, live payment
-- credentials and the Meta approvals are still open (W0), so completing
-- version 1's table is filling in the launch offer rather than repricing
-- something a merchant holds. The first repricing after a real sale opens
-- version 2, as the catalogue discipline requires.

-- ── 1. Two plan units get their figures ────────────────────────────────
--
-- SERVICE_MESSAGE is a free-form reply outside the 24-hour window, so it is
-- the unit a merchant spends TALKING TO THEIR OWN CUSTOMERS. Chat is zero
-- on purpose and not by omission: a Chat merchant talks to customers from
-- their own phone, and the plan sells them the assistant, not an outbound
-- channel. Integrate and Complete run the storefront conversation, which is
-- where the volume is.
--
-- REPORT_EXPORTS is a produced file: generated, downloaded, gone. It is
-- CONSUMABLE_MONTHLY (PR-116). The ladder is deliberately gentle, because
-- an export is cheap to serve and refusing one feels like being locked out
-- of your own books. Data PORTABILITY is a different thing and is never
-- metered - see PR-118 and docs/privacy.
INSERT INTO allowance_versions (plan_version_id, unit, allowance)
SELECT v.id, a.unit, a.allowance
FROM plan_versions v
JOIN (VALUES
  ('trial',     'SERVICE_MESSAGE',  250),
  ('integrate', 'SERVICE_MESSAGE', 5000),
  ('complete',  'SERVICE_MESSAGE', 5000),
  ('trial',     'REPORT_EXPORTS',    10),
  ('chat',      'REPORT_EXPORTS',    50),
  ('integrate', 'REPORT_EXPORTS',   100),
  ('complete',  'REPORT_EXPORTS',   200)
) AS a(plan_id, unit, allowance) ON a.plan_id = v.plan_id AND v.version = 1
ON CONFLICT DO NOTHING;

-- `chat` sells no SERVICE_MESSAGE and `expired` sells neither. Both are
-- absent rather than written as zero, which is 0105's convention: a missing
-- row reads as zero, and naming only what a plan sells keeps the table
-- readable against the pricing page.

-- ── 2. The API is sold as an add-on, because §27 puts it in no plan ─────
--
-- Developer API Starter is the whole product in one purchase: the
-- entitlement that opens the door, one application to hold, and a month's
-- requests and deliveries. The four grants are four rows rather than four
-- columns because they are different KINDS (PR-116) and a merchant may buy
-- more of some without the others.
INSERT INTO add_ons
  (add_on_id, version, name, billing_interval, price_minor, currency, effective_from)
VALUES
  ('developer_api_starter', 1, 'Developer API Starter', 'monthly',
   2500000, 'NGN', '2026-08-01T00:00:00Z'),
  ('api_application_extra', 1, 'One extra API application', 'monthly',
   500000, 'NGN', '2026-08-01T00:00:00Z')
ON CONFLICT (add_on_id, version) DO NOTHING;

INSERT INTO add_on_grants (add_on_id, version, grant_kind, entitlement_key, unit, quantity)
VALUES
  ('developer_api_starter', 1, 'ENTITLEMENT',   'REKODA_API', NULL, NULL),
  ('developer_api_starter', 1, 'CAPACITY',      NULL, 'API_APPLICATIONS',   1),
  ('developer_api_starter', 1, 'MONTHLY_UNITS', NULL, 'API_REQUEST_UNITS',  25000),
  ('developer_api_starter', 1, 'MONTHLY_UNITS', NULL, 'WEBHOOK_DELIVERIES', 25000),
  -- Recurring capacity, never a pack: a second application is something the
  -- merchant HOLDS for as long as they pay, and a one-off block of units
  -- cannot say that (owner ruling, 28 Aug 2026).
  ('api_application_extra', 1, 'CAPACITY',      NULL, 'API_APPLICATIONS',   1)
ON CONFLICT DO NOTHING;

-- The seat add-on has been sellable since 0106 and granted nothing, because
-- until 0112 there was nowhere to say what it grants. It is +1 seat.
INSERT INTO add_on_grants (add_on_id, version, grant_kind, entitlement_key, unit, quantity)
VALUES ('extra_seat', 1, 'CAPACITY', NULL, 'ACCOUNTANT_USERS', 1)
ON CONFLICT DO NOTHING;

-- `extra_waba_number` is left ungranted deliberately. An additional
-- WhatsApp number is not one of the seventeen units - there is nothing to
-- count - and its price is "Custom initially" (0106), so it stays a
-- conversation rather than a self-service grant.

-- ── 3. Top-ups for the two API consumables ─────────────────────────────
--
-- Only the consumables. There is no pack of applications, and 0112's
-- narrowed CHECK on usage_packs.unit means there cannot be one.
INSERT INTO usage_packs
  (pack_id, version, label, unit, quantity, price_minor, currency, effective_from)
VALUES
  ('api_requests_25k', 1, '25,000 extra API requests', 'API_REQUEST_UNITS',
   25000, 1000000, 'NGN', '2026-08-01T00:00:00Z'),
  ('webhook_deliveries_25k', 1, '25,000 extra webhook deliveries', 'WEBHOOK_DELIVERIES',
   25000, 500000, 'NGN', '2026-08-01T00:00:00Z')
ON CONFLICT (pack_id, version) DO NOTHING;
