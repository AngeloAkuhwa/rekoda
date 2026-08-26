-- The metered vocabulary becomes the canonical seventeen (spec 4.2).
--
-- Five units were metered; twelve more are named here so the counter can
-- hold them the day a consumer exists. Nothing consumes the new twelve yet
-- and every plan sells zero of them, so this migration changes no merchant's
-- capacity: it changes what the meter is able to say.
--
-- The rename is a rename, not a conversion. `used` for voice stays in
-- SECONDS: a voice note is not a whole number of minutes, and dividing the
-- stored seconds by sixty would silently forgive or charge for the
-- remainder. `VOICE_MINUTES` is the unit a merchant is sold; seconds are
-- how it is counted. `@rekoda/core`'s UNIT_SCALE holds that ratio and
-- `allowanceFor` applies it, so the ceiling this column is checked against
-- moves with the name.
--
-- RLS is dropped for the length of the UPDATE and restored immediately.
-- `usage_counters` is FORCE ROW LEVEL SECURITY, which applies to the table
-- owner too, and a migration has no `app.business_id` to pin: without this
-- the UPDATE would match zero rows and report success.

ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_unit_check;

ALTER TABLE usage_counters DISABLE ROW LEVEL SECURITY;

UPDATE usage_counters SET unit = CASE unit
  WHEN 'messages'             THEN 'AI_ACTIONS'
  WHEN 'voice_seconds'        THEN 'VOICE_MINUTES'
  WHEN 'documents'            THEN 'DOCUMENT_GENERATION'
  WHEN 'documents_understood' THEN 'DOCUMENTS_UNDERSTOOD'
  WHEN 'orders'               THEN 'CATALOGUE_ORDERS'
  ELSE unit
END
WHERE unit IN ('messages', 'voice_seconds', 'documents', 'documents_understood', 'orders');

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;

ALTER TABLE usage_counters ADD CONSTRAINT usage_counters_unit_check CHECK (unit IN (
  'AI_ACTIONS',
  'VOICE_MINUTES',
  'DOCUMENT_GENERATION',
  'DOCUMENTS_UNDERSTOOD',
  'SERVICE_MESSAGE',
  'UTILITY_TEMPLATE',
  'AUTH_TEMPLATE',
  'AUTH_INTL_TEMPLATE',
  'MARKETING_TEMPLATE',
  'CATALOGUE_ORDERS',
  'PAYMENT_CONNECTIONS',
  'FINANCIAL_ACCOUNT_CONNECTIONS',
  'ACCOUNTANT_USERS',
  'REPORT_EXPORTS',
  'API_REQUEST_UNITS',
  'API_APPLICATIONS',
  'WEBHOOK_DELIVERIES'
));
