-- G-22: the fee estimated for an order must come from the mechanism that
-- collected it. The live mechanism is Pay-with-Transfer (a temporary account
-- per order, ADR 0016), which Paystack prices at the LOCAL rate, 1.5% + N100
-- capped N2,000 with the N100 waived below N2,500. The 1% capped N300 rate
-- (`collection_transfer_dva`) is for dedicated virtual accounts, which Rekoda
-- does not use; the order path read it, so a N105,000 order was estimated at
-- N300 instead of N1,675.
--
-- A new product row rather than reusing `collection_local_card`: a PwT transfer
-- is its own provider product, and a card rate that changes later must not move
-- it silently. Same observed card (paystack-ng-2026-08), appended as a new
-- observation, never an edit (provider_cost_schedules is append-only).
INSERT INTO provider_cost_schedules
  (provider_type, cost_type, provider_product, version, effective_from,
   basis, percent_ppm, flat_minor, cap_minor, waive_flat_under_minor, currency, note)
VALUES
  ('paystack', 'PAYMENT_FEE', 'collection_transfer_pwt', 'paystack-ng-2026-08', '2026-08-16',
   'PERCENT_PLUS_FLAT', 15000, 10000, 200000, 250000, 'NGN',
   'Pay-with-Transfer is priced at the local rate: 1.5% + N100, capped N2,000, N100 waived below N2,500 (ADR 0016, G-22)');
