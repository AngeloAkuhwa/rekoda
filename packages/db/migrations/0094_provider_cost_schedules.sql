-- ProviderCostSchedule (spec §17, §19.1, §24, §29; P3, PR-072).
--
-- A rate card is an OBSERVATION with a date on it, not a domain truth
-- (spec §24: "every such multiple is an effective-dated observation of a
-- published rate card, derived at runtime from ProviderCostSchedule,
-- never a stored constant"). This table is where those observations
-- live: what a provider charged, per product, as it stood on a date.
-- PaymentCharge estimates cite a row (§19.1's provider_cost_schedule_id,
-- promised an FK by 0083 "a reference today, an FK then" — delivered
-- below), and PlatformCostEvent rows DERIVED_FROM_RATE_CARD will cite
-- one too (§29, BL2). Ratios and estimates are DERIVED from the row in
-- force; nothing downstream writes a multiple down.
--
-- GLOBAL reference data, same construction as provider_capabilities
-- (0093): what providers charge the PLATFORM is not tenant state, so no
-- RLS — and read-only to both runtime roles, because a rate observation
-- arrives with a migration or an operator's hand when a card publishes,
-- never through an application write path.
--
-- Two bases, because provider rate cards come in exactly these shapes:
--   PER_UNIT            a price per message/call/unit, quoted in micros
--                       of the card's currency (Meta quotes USD)
--   PERCENT_PLUS_FLAT   a percentage of the amount plus a flat fee, with
--                       an optional cap and an optional waive-the-flat
--                       threshold (Paystack's collection pricing)
-- A row that mixes the shapes, or omits its own basis's fields, is
-- unrepresentable.

CREATE TABLE provider_cost_schedules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_type           text NOT NULL,
  /* §29's cost vocabulary — the same words PlatformCostEvent will use. */
  cost_type               text NOT NULL CHECK (cost_type IN (
    'MESSAGING', 'AI_INFERENCE', 'OCR', 'PAYMENT_FEE',
    'BANK_FEED', 'STORAGE', 'TELEPHONY'
  )),
  /* The provider's own product the rate prices: a §4.2 message category,
   * a collection channel, a model name. */
  provider_product        text NOT NULL,
  /* Which published card this observation came from, so a cost report
   * can name its source (e.g. 'meta-ng-2026-08'). */
  version                 text NOT NULL,
  effective_from          date NOT NULL,

  basis                   text NOT NULL CHECK (basis IN ('PER_UNIT', 'PERCENT_PLUS_FLAT')),
  /* PER_UNIT: micros of `currency` per unit. Zero is a real price
   * (a service message today), never "unknown". */
  unit_price_micros       bigint,
  /* PERCENT_PLUS_FLAT: parts-per-million of the amount... */
  percent_ppm             integer,
  /* ...plus this flat fee in minor units... */
  flat_minor              bigint,
  /* ...the whole fee capped here (null: uncapped)... */
  cap_minor               bigint,
  /* ...and the flat part waived below this amount (null: never waived). */
  waive_flat_under_minor  bigint,

  currency                text NOT NULL,
  /* Where the observation came from, in words. */
  note                    text,
  observed_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_cost_schedules_ux
    UNIQUE (provider_type, provider_product, effective_from),
  CONSTRAINT provider_cost_schedules_basis_coherent CHECK (
    (basis = 'PER_UNIT'
      AND unit_price_micros IS NOT NULL
      AND percent_ppm IS NULL AND flat_minor IS NULL
      AND cap_minor IS NULL AND waive_flat_under_minor IS NULL)
    OR
    (basis = 'PERCENT_PLUS_FLAT'
      AND percent_ppm IS NOT NULL AND flat_minor IS NOT NULL
      AND unit_price_micros IS NULL)
  ),
  CONSTRAINT provider_cost_schedules_nonnegative CHECK (
    coalesce(unit_price_micros, 0) >= 0
    AND coalesce(percent_ppm, 0) >= 0
    AND coalesce(flat_minor, 0) >= 0
    AND coalesce(cap_minor, 0) >= 0
    AND coalesce(waive_flat_under_minor, 0) >= 0
  )
);

REVOKE INSERT, UPDATE, DELETE ON provider_cost_schedules FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON provider_cost_schedules FROM rekoda_worker;

/* 0083 promised this FK the day the table arrived. An estimate that
 * cites a schedule now cites a schedule that exists. */
ALTER TABLE payment_charges
  ADD CONSTRAINT payment_charges_cost_schedule_fk
  FOREIGN KEY (provider_cost_schedule_id) REFERENCES provider_cost_schedules (id);

/* The observations Rekoda currently models, from the two canonical
 * cards already in the repository — seeded so the table is born agreeing
 * with them, and tested against the in-code card so the two cannot
 * drift apart silently.
 *
 * Paystack collection pricing (docs/pricing-model.md, external cost
 * stack, researched 16 Aug 2026): local cards 1.5% + N100 capped N2,000
 * with the N100 waived below N2,500; transfers/DVA 1% capped N300. */
INSERT INTO provider_cost_schedules
  (provider_type, cost_type, provider_product, version, effective_from,
   basis, percent_ppm, flat_minor, cap_minor, waive_flat_under_minor, currency, note)
VALUES
  ('paystack', 'PAYMENT_FEE', 'collection_local_card', 'paystack-ng-2026-08', '2026-08-16',
   'PERCENT_PLUS_FLAT', 15000, 10000, 200000, 250000, 'NGN',
   '1.5% + N100, capped N2,000, N100 waived below N2,500 (docs/pricing-model.md external cost stack)'),
  ('paystack', 'PAYMENT_FEE', 'collection_transfer_dva', 'paystack-ng-2026-08', '2026-08-16',
   'PERCENT_PLUS_FLAT', 10000, 0, 30000, NULL, 'NGN',
   '1%, capped N300 (docs/pricing-model.md external cost stack)');

/* Meta WhatsApp messaging, rate card meta-ng-2026-08 (the same card
 * @rekoda/core models in META_COST_SCHEDULE; USD micros per message,
 * re-verified 24 Aug 2026). SERVICE_MESSAGE is genuinely zero today and
 * chargeable from 1 Oct 2026 — a new observation row when it prices,
 * never an edit to this one. */
INSERT INTO provider_cost_schedules
  (provider_type, cost_type, provider_product, version, effective_from,
   basis, unit_price_micros, currency, note)
VALUES
  ('meta', 'MESSAGING', 'SERVICE_MESSAGE', 'meta-ng-2026-08', '2026-08-24',
   'PER_UNIT', 0, 'USD', 'Free Meta-side today; chargeable from 1 Oct 2026'),
  ('meta', 'MESSAGING', 'UTILITY_TEMPLATE', 'meta-ng-2026-08', '2026-08-24',
   'PER_UNIT', 6700, 'USD', 'Order updates, receipts, billing and retention notices'),
  ('meta', 'MESSAGING', 'AUTH_TEMPLATE', 'meta-ng-2026-08', '2026-08-24',
   'PER_UNIT', 14500, 'USD', 'Sign-in codes, Nigeria-registered WABA'),
  ('meta', 'MESSAGING', 'AUTH_INTL_TEMPLATE', 'meta-ng-2026-08', '2026-08-24',
   'PER_UNIT', 75000, 'USD', 'The same sign-in code when the WABA is registered outside Nigeria'),
  ('meta', 'MESSAGING', 'MARKETING_TEMPLATE', 'meta-ng-2026-08', '2026-08-24',
   'PER_UNIT', 51600, 'USD', 'Priced so the day something sends one it is visible; excluded from V1 plans');
