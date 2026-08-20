-- Where the sale happened, separate from how it reached Rekoda
-- (docs/rekoda-chat-v1.md §27–29). Nullable by design: Rekoda never demands
-- a channel per transaction. source_type (already present) stays the
-- captured-via fact; this is the commercial one, and the dashboard's
-- "today's sales by channel" comes from it.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sale_source text
  CHECK (sale_source IS NULL OR sale_source IN (
    'physical_store', 'instagram', 'facebook', 'tiktok',
    'whatsapp_catalogue', 'website', 'phone', 'marketplace',
    'event', 'other'));

-- "How much did I make from Instagram this month?" is a tenant-scoped scan
-- by source; partial so the (common) untagged rows cost nothing.
CREATE INDEX IF NOT EXISTS invoices_business_source_ix
  ON invoices (business_id, sale_source)
  WHERE sale_source IS NOT NULL;
