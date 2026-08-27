-- The per-WABA template registry, made law (spec §24, §4.2; W1/W2, PR-060).
--
-- 0084 created the table with its category vocabulary borrowed from Meta
-- PLUS 'SERVICE'. That fourth value was a mistake in waiting: SERVICE is a
-- free-form message inside the 24-hour window (§4.2's SERVICE_MESSAGE unit),
-- and a TEMPLATE is precisely the thing one sends because there is no window
-- to be inside. A template registered as SERVICE would be a row whose
-- metering unit cannot be derived, discovered at send time by the merchant
-- it refuses.

/* Nothing may hold the value the vocabulary is about to lose. The estate
 * has no writer that produces 'SERVICE' (upsertTemplate's callers are the
 * PR-058 suites), so this counts rather than migrates — 0064 discipline. */
DO $$
DECLARE stray bigint;
BEGIN
  SELECT count(*) INTO stray FROM waba_templates WHERE category = 'SERVICE';
  IF stray > 0 THEN
    RAISE EXCEPTION 'cannot tighten template categories: % SERVICE rows', stray;
  END IF;
END;
$$;

ALTER TABLE waba_templates
  DROP CONSTRAINT waba_templates_category_check;

/* Meta's three template categories, exactly. The §4.2 unit is DERIVED from
 * this at send time (templateUnitFor in @rekoda/core), never stored — the
 * same value on two rows must never meter to two different units. */
ALTER TABLE waba_templates
  ADD CONSTRAINT waba_templates_category_check
    CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION'));

/* Why Meta refused or paused it — the merchant's next action lives in this
 * text ("add a footer", "too promotional"). Advisory prose from the
 * provider, never parsed, never a routing input. */
ALTER TABLE waba_templates
  ADD COLUMN rejection_reason text;
