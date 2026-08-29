-- What an add-on GRANTS, and which add-ons a business holds
-- (PR-116; owner ruling, 28 August 2026; canonical spec §30, §27).
--
-- Migration 0106 gave add-ons a price and a name and nothing else, which was
-- enough while the only add-ons were an extra seat and an extra WhatsApp
-- number, both understood by whoever read the invoice. It stops being enough
-- the moment an add-on has to say "this grants the API entitlement, one
-- application of standing capacity, and twenty-five thousand requests a
-- month", because that is three different KINDS of grant and none of them is
-- a price.
--
-- The owner ruling this implements draws the line the old model blurred:
--
--   CONSUMABLE_MONTHLY  spent and reset. Messages, documents, API requests.
--   CAPACITY            held, not spent. Seats, connections, applications.
--
-- A capacity unit sold as a one-off pack is incoherent — "buy fifty more
-- applications, once" is not a sentence about standing capacity — so
-- capacity is granted by a RECURRING add-on the business holds, and the
-- ceiling is answered by counting what exists rather than by a counter that
-- resets. `UNIT_KIND` in @rekoda/core is the same table in code, and
-- scripts/check-boundaries.mjs refuses a capacity unit at `consumeUnit`.

CREATE TABLE IF NOT EXISTS add_on_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_id      text NOT NULL,
  version        integer NOT NULL,
  /*
   * Three kinds, because an add-on grants three different sorts of thing:
   *
   *   ENTITLEMENT     a capability the business may use at all (§4.1).
   *   CAPACITY        how many of a held thing it may keep at once.
   *   MONTHLY_UNITS   how much of a consumable it gets every month, on top
   *                   of the plan's own allowance and separate from a pack,
   *                   which credits one month and is gone.
   */
  grant_kind     text NOT NULL CHECK (grant_kind IN
                   ('ENTITLEMENT', 'CAPACITY', 'MONTHLY_UNITS')),
  /* Set for ENTITLEMENT, null otherwise. */
  entitlement_key text REFERENCES entitlements(key),
  /* Set for CAPACITY and MONTHLY_UNITS, null for ENTITLEMENT. */
  unit           text,
  quantity       integer CHECK (quantity IS NULL OR quantity > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (add_on_id, version) REFERENCES add_ons (add_on_id, version),
  /* Each kind carries exactly the columns it means, so a row cannot be a
   * capacity grant of nothing or an entitlement grant of four. */
  CONSTRAINT add_on_grants_shaped CHECK (
    (grant_kind = 'ENTITLEMENT'
       AND entitlement_key IS NOT NULL AND unit IS NULL AND quantity IS NULL)
    OR (grant_kind IN ('CAPACITY', 'MONTHLY_UNITS')
       AND entitlement_key IS NULL AND unit IS NOT NULL AND quantity IS NOT NULL)
  ),
  CONSTRAINT add_on_grants_ux UNIQUE (add_on_id, version, grant_kind, entitlement_key, unit)
);

CREATE INDEX IF NOT EXISTS add_on_grants_add_on_ix ON add_on_grants (add_on_id, version);

-- Catalogue, like everything else in 0105 and 0106: the application reads it
-- and may never write it. A grant changing is a commercial decision that
-- arrives as a migration, not as an application write path.
REVOKE INSERT, UPDATE, DELETE ON add_on_grants FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON add_on_grants FROM rekoda_worker;

-- ── which add-ons a business holds ─────────────────────────────────────────
-- An add-on is RECURRING (0106: `billing_interval` is monthly and nothing
-- else), so holding one is a period with a start and possibly an end, not an
-- event. `ends_at` in the future is a cancellation that has not taken effect
-- yet, which is how a merchant who cancels mid-month keeps what they paid
-- for until the period closes.
CREATE TABLE IF NOT EXISTS business_add_ons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  add_on_id   text NOT NULL,
  /*
   * The version SOLD, pinned exactly as `businesses.plan_version_id` pins a
   * plan (migration 0105). A merchant who bought the API when it included
   * twenty-five thousand requests keeps twenty-five thousand after a
   * repricing, because their row still points at the version whose grants
   * never changed.
   */
  version     integer NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (add_on_id, version) REFERENCES add_ons (add_on_id, version),
  CONSTRAINT business_add_ons_period CHECK (ends_at IS NULL OR ends_at > started_at)
);

/* One live holding per add-on per business. A merchant wanting two extra
 * applications buys a quantity, not a second identical subscription, which
 * keeps "what do they hold" a question with one answer. */
CREATE UNIQUE INDEX IF NOT EXISTS business_add_ons_live_ux
  ON business_add_ons (business_id, add_on_id) WHERE ends_at IS NULL;
CREATE INDEX IF NOT EXISTS business_add_ons_business_ix
  ON business_add_ons (business_id, started_at DESC);

ALTER TABLE business_add_ons ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_add_ons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_add_ons
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* What a business holds is the record of what they were sold, so the
 * application may add and end a holding and may never erase one: "they used
 * to hold the API" is the answer to a billing dispute. 0001's default
 * privileges granted DELETE, so it is revoked. */
REVOKE DELETE ON business_add_ons FROM rekoda_app;
REVOKE INSERT, UPDATE, DELETE ON business_add_ons FROM rekoda_worker;

COMMENT ON TABLE add_on_grants IS
  'What an add-on grants: an entitlement, standing capacity, or monthly '
  'units (owner ruling, 28 Aug 2026). Versioned with the add-on it belongs '
  'to, so a repricing never changes what an existing holder was sold.';
COMMENT ON TABLE business_add_ons IS
  'Which add-ons a business holds, with the version pinned as sold. Ending '
  'a holding is a dated fact; erasing one is not permitted.';

/* A pack sells a CONSUMABLE unit, and only ever a consumable one (owner
 * ruling, 28 Aug 2026).
 *
 * 0106 allowed any unit here, which made "buy fifty more API applications,
 * once" a sentence the catalogue could express - and it is not a sentence
 * about standing capacity at all. A pack credits `bonus` into ONE month and
 * is gone, so a pack of a held thing would grant a seat that silently
 * vanished at the month boundary. Capacity is sold as a recurring add-on,
 * through add_on_grants above, and the four capacity units are removed from
 * what a pack may name. Nothing seeded names one, so this constraint drops
 * no row. */
ALTER TABLE usage_packs DROP CONSTRAINT usage_packs_unit_check;
ALTER TABLE usage_packs ADD CONSTRAINT usage_packs_unit_check CHECK (unit IN (
  'AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENT_GENERATION', 'DOCUMENTS_UNDERSTOOD',
  'SERVICE_MESSAGE', 'UTILITY_TEMPLATE', 'AUTH_TEMPLATE', 'AUTH_INTL_TEMPLATE',
  'MARKETING_TEMPLATE', 'CATALOGUE_ORDERS', 'REPORT_EXPORTS',
  'API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES'));
