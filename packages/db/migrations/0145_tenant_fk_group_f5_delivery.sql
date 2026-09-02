-- Group F, part five and last: delivery and reconciliation plumbing.
--
-- The final three of the fourteen relationships that re-running the R1 audit's
-- own question against the finished schema turned up (0141 through 0144
-- before). With these, group F closes at fourteen of fourteen, and every
-- single-column foreign key from a tenant-owned child to a tenant-owned parent
-- in this schema now carries the tenant.
--
--   webhook_deliveries.endpoint_id      -> webhook_endpoints
--   webhook_deliveries.outbox_event_id  -> outbox_events
--   bank_line_matches.line_id           -> bank_statement_lines
--
-- The first two are the outbound edge of the product. A delivery names the
-- endpoint it is sent TO and the event whose payload it carries, and neither
-- said whose they were: one merchant's business event could have been
-- delivered to another merchant's URL. That is exfiltration by plumbing rather
-- than by query, which is exactly the shape a weak key hides.
--
-- The third is the reconciliation join. A match says a bank line and a posting
-- are the same money; a line belonging to another merchant makes that claim
-- across two sets of books.
--
-- The usual checks, run rather than assumed: business_id is NOT NULL on both
-- children and all three reference columns are NOT NULL, so none of these
-- constraints is ever skipped. None of the three parents exposed UNIQUE
-- (business_id, id), so this adds all three first, additively. No existing row
-- points across a tenant. NOT VALID then VALIDATE here, and each weaker key
-- dropped only after its stronger one is valid.
--
-- ON DELETE, read from the originals rather than reconstructed: 0111 declared
-- both webhook keys as plain REFERENCES with no delete action, and 0037
-- declared `bank_line_matches.line_id` with ON DELETE CASCADE. Each composite
-- below carries exactly what its predecessor carried - the cascade kept where
-- it existed, and none invented where it did not.
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_business_id_ux UNIQUE (business_id, id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_business_id_ux UNIQUE (business_id, id);
ALTER TABLE bank_statement_lines ADD CONSTRAINT bank_statement_lines_business_id_ux UNIQUE (business_id, id);

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_endpoint_business_fk
  FOREIGN KEY (business_id, endpoint_id) REFERENCES webhook_endpoints (business_id, id) NOT VALID;
ALTER TABLE webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_endpoint_business_fk;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_endpoint_id_fkey;

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_outbox_business_fk
  FOREIGN KEY (business_id, outbox_event_id) REFERENCES outbox_events (business_id, id) NOT VALID;
ALTER TABLE webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_outbox_business_fk;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_outbox_event_id_fkey;

-- ON DELETE CASCADE preserved from 0037: deleting a bank line still takes its
-- match with it, unchanged.
ALTER TABLE bank_line_matches
  ADD CONSTRAINT bank_line_matches_line_business_fk
  FOREIGN KEY (business_id, line_id) REFERENCES bank_statement_lines (business_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE bank_line_matches VALIDATE CONSTRAINT bank_line_matches_line_business_fk;
ALTER TABLE bank_line_matches DROP CONSTRAINT bank_line_matches_line_id_fkey;
