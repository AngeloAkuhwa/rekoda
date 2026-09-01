-- Group E of the tenant-composite foreign keys, the platform edge
-- (remediation R1 ruling 1; A was 0132, B 0133, C 0134, D 0135).
--
-- `waba_catalogue_items` is the same worked example group C contained. The
-- table already carries the correct composite key for `product_id`, added
-- when it was created, and the connection edge beside it was left
-- single-column. One table, both forms, and nothing about the second is
-- harder than the first: a catalogue row could name another merchant's
-- WhatsApp Business Account connection, which is the account a sync would
-- then write products into.
--
-- Group E's other two relationships are `platform_cost_events`, which are not
-- in this migration and are not forgotten. They are held for a separate
-- decision: MATCH FULL, the shape first proposed for them, rejects any row
-- mixing null and non-null key values, including the (tenant present, payment
-- absent) shape every unattributed cost row already has.
--
-- Same procedure and the same checks, run rather than assumed: business_id
-- and waba_connection_id are both NOT NULL on the child, so the constraint is
-- always checked; waba_connections exposes UNIQUE (business_id, id); no
-- existing row points across a tenant; NOT VALID then VALIDATE here; the
-- weaker key dropped only after the stronger one is valid.
ALTER TABLE waba_catalogue_items
  ADD CONSTRAINT waba_catalogue_items_connection_business_fk
  FOREIGN KEY (business_id, waba_connection_id) REFERENCES waba_connections (business_id, id) NOT VALID;
ALTER TABLE waba_catalogue_items VALIDATE CONSTRAINT waba_catalogue_items_connection_business_fk;
ALTER TABLE waba_catalogue_items DROP CONSTRAINT waba_catalogue_items_waba_connection_id_fkey;
