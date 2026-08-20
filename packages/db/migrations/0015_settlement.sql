-- Settlement tracking (docs/payments-v1.md §26–28).
--
-- Settlement status has lived on `payments` since 0011; what was missing is
-- WHEN the money actually reached the merchant's bank. `settled_at` is the
-- provider's effective date for the settlement batch that carried this
-- payment — stamped by the polling sweep, never by a webhook alone, because
-- Paystack's settlement webhooks are best-effort while GET /settlement is
-- authoritative.
ALTER TABLE payments ADD COLUMN settled_at timestamptz;
