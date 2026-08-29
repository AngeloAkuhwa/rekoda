-- The tax model: codes, rates, treatments, point policies
-- (spec §13; F2, PR-078).
--
-- "No hardcoded tax assumptions. Nigeria-first configuration." Until now
-- VAT has been a rate PARAMETER handed to `computeVat` by whoever calls
-- it. This migration makes the tax model DATA, per business:
--
--   tax_codes   what kinds of tax standing exist for this business, each
--               with its TREATMENT (how a line under it behaves) and its
--               TAX POINT POLICY (§13: WHEN the tax event occurs — which
--               is not automatically the revenue-recognition point, and
--               keeping the two separate is this section's whole point)
--   tax_rates   effective-dated observations of the statutory rate, the
--               same derived-never-stored construction as 0094: Nigeria
--               moved VAT from 5% to 7.5% in February 2020, and the next
--               Finance Act moves it again with a ROW, not a code edit
--
-- The §13 entities TaxEvent and TaxLiability arrive with PR-079's
-- separated calculator; FiscalisationProvider stays architecture until
-- the compliance work opens.
--
-- OPEN COMPLIANCE: this is CONFIGURATION, seeded with Nigeria's current
-- published figures. No statutory-compliance claim may appear in
-- marketing or product copy without approved review.

CREATE TABLE tax_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  /* STANDARD_RATE · ZERO_RATED · EXEMPT — the merchant's configured
   * vocabulary, unique per business. */
  code           text NOT NULL,
  label          text NOT NULL,
  /* How a line under this code behaves. ZERO_RATED and EXEMPT differ in
   * VAT law (input-credit recovery), so both exist even though both
   * charge nothing. */
  treatment      text NOT NULL CHECK (treatment IN (
    'TAXABLE', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE'
  )),
  /* §13: WHEN the tax event occurs for lines under this code. */
  point_policy   text NOT NULL DEFAULT 'ON_INVOICE_ISSUE' CHECK (point_policy IN (
    'ON_INVOICE_ISSUE', 'ON_PAYMENT_RECEIPT', 'ON_FULFILMENT'
  )),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_codes_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT tax_codes_code_ux UNIQUE (business_id, code)
);

CREATE TABLE tax_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  tax_code_id    uuid NOT NULL,
  /** Basis points: 750 is Nigeria's 7.5% VAT. Zero is a real rate. */
  rate_bps       integer NOT NULL CHECK (rate_bps >= 0),
  effective_from date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_rates_code_fk
    FOREIGN KEY (business_id, tax_code_id) REFERENCES tax_codes (business_id, id),
  /* One observation per code per effective date; the rate in force at a
   * date is DERIVED (latest at or before it), never stored. */
  CONSTRAINT tax_rates_ux UNIQUE (business_id, tax_code_id, effective_from)
);

CREATE INDEX tax_rates_code_ix ON tax_rates (business_id, tax_code_id, effective_from);

ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_codes
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_rates
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* ── seed every existing business with Nigeria's current configuration ──
 * The same three codes `seedTaxModel` gives a new business at creation,
 * idempotent by the natural keys. STANDARD_RATE carries the published
 * rate history the estate can already cite: 5% until 1 Feb 2020, 7.5%
 * since (Finance Act 2019). ZERO_RATED and EXEMPT charge nothing and
 * need no rate rows — an absent observation IS the zero. */
INSERT INTO tax_codes (business_id, code, label, treatment)
SELECT b.id, c.code, c.label, c.treatment
FROM businesses b
CROSS JOIN (VALUES
  ('STANDARD_RATE', 'VAT (standard rate)', 'TAXABLE'),
  ('ZERO_RATED', 'Zero-rated', 'ZERO_RATED'),
  ('EXEMPT', 'VAT exempt', 'EXEMPT')
) AS c(code, label, treatment)
WHERE NOT EXISTS (
  SELECT 1 FROM tax_codes t WHERE t.business_id = b.id AND t.code = c.code
);

INSERT INTO tax_rates (business_id, tax_code_id, rate_bps, effective_from)
SELECT t.business_id, t.id, r.rate_bps, r.effective_from::date
FROM tax_codes t
CROSS JOIN (VALUES
  (500, '2015-01-01'),
  (750, '2020-02-01')
) AS r(rate_bps, effective_from)
WHERE t.code = 'STANDARD_RATE'
  AND NOT EXISTS (
    SELECT 1 FROM tax_rates x
    WHERE x.business_id = t.business_id AND x.tax_code_id = t.id
      AND x.effective_from = r.effective_from::date
  );
