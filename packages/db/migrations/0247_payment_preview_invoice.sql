-- Every chat payment preview records the invoice it SHOWED (OD-57, owner ruling OWN-101).
--
-- "Ada paid 20k" names a customer and no invoice number. The preview resolved Ada's newest open
-- invoice and showed it, but the draft kept nothing of it, so the "yes" resolved her newest open
-- invoice AGAIN. An invoice issued to Ada between the two took the payment, and the invoice the
-- merchant was shown still showed as owing. Now the preview stores the invoice and the figures it
-- showed beside the draft, and the "yes" books to that invoice or is refused and asked again.
--
-- A second kind for `confirmation_context` (0152), `payment_invoice`: exactly four keys, a uuid
-- and two non-negative whole numbers of kobo, the amount at most the balance and above zero.
-- Ids and integer kobo only, as 0152 requires: no name, number, token or text. The 0152 kind
-- (`payment_overpayment`) is held to exactly what it was. NULL stays allowed: every draft that
-- is not a payment, and every payment draft previewed before this migration (asked again at
-- "yes", never resolved afresh).
--
-- Additive for the running release: it writes only `payment_overpayment` contexts, which still
-- pass, and it reads a `payment_invoice` context as none (its earlier behaviour). The constraint
-- is replaced in one transaction; the existing rows hold only NULL or the 0152 kind.
ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_confirmation_context_ck;
-- Wrapped in COALESCE(..., false) on purpose, as 0152 is: a CHECK that evaluates to NULL PASSES,
-- and a missing key makes the terms below NULL rather than false. The number casts are reached
-- only after jsonb_typeof said "number", because AND short-circuits within a CASE.
ALTER TABLE command_drafts ADD CONSTRAINT command_drafts_confirmation_context_ck CHECK (
  confirmation_context IS NULL
  OR COALESCE(
    CASE
      WHEN jsonb_typeof(confirmation_context) <> 'object' THEN false
      WHEN jsonb_typeof(confirmation_context -> 'invoiceId') IS DISTINCT FROM 'string' THEN false
      WHEN (confirmation_context ->> 'invoiceId')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
      WHEN (confirmation_context ->> 'kind') = 'payment_overpayment' THEN
        CASE
          WHEN NOT (confirmation_context ?& ARRAY[
            'kind', 'invoiceId', 'balanceShownK', 'amountReceivedK', 'allocatedK', 'creditK'
          ]) THEN false
          WHEN (confirmation_context - ARRAY[
            'kind', 'invoiceId', 'balanceShownK', 'amountReceivedK', 'allocatedK', 'creditK'
          ]) <> '{}'::jsonb THEN false
          WHEN jsonb_typeof(confirmation_context -> 'balanceShownK') <> 'number'
            OR jsonb_typeof(confirmation_context -> 'amountReceivedK') <> 'number'
            OR jsonb_typeof(confirmation_context -> 'allocatedK') <> 'number'
            OR jsonb_typeof(confirmation_context -> 'creditK') <> 'number' THEN false
          ELSE
            (confirmation_context ->> 'balanceShownK')::numeric >= 0
            AND (confirmation_context ->> 'balanceShownK')::numeric
              = trunc((confirmation_context ->> 'balanceShownK')::numeric)
            AND (confirmation_context ->> 'amountReceivedK')::numeric >= 0
            AND (confirmation_context ->> 'amountReceivedK')::numeric
              = trunc((confirmation_context ->> 'amountReceivedK')::numeric)
            AND (confirmation_context ->> 'allocatedK')::numeric >= 0
            AND (confirmation_context ->> 'allocatedK')::numeric
              = trunc((confirmation_context ->> 'allocatedK')::numeric)
            AND (confirmation_context ->> 'creditK')::numeric >= 0
            AND (confirmation_context ->> 'creditK')::numeric
              = trunc((confirmation_context ->> 'creditK')::numeric)
        END
      WHEN (confirmation_context ->> 'kind') = 'payment_invoice' THEN
        CASE
          WHEN NOT (confirmation_context ?& ARRAY[
            'kind', 'invoiceId', 'balanceShownK', 'amountShownK'
          ]) THEN false
          WHEN (confirmation_context - ARRAY[
            'kind', 'invoiceId', 'balanceShownK', 'amountShownK'
          ]) <> '{}'::jsonb THEN false
          WHEN jsonb_typeof(confirmation_context -> 'balanceShownK') <> 'number'
            OR jsonb_typeof(confirmation_context -> 'amountShownK') <> 'number' THEN false
          ELSE
            (confirmation_context ->> 'balanceShownK')::numeric
              = trunc((confirmation_context ->> 'balanceShownK')::numeric)
            AND (confirmation_context ->> 'amountShownK')::numeric
              = trunc((confirmation_context ->> 'amountShownK')::numeric)
            AND (confirmation_context ->> 'amountShownK')::numeric > 0
            AND (confirmation_context ->> 'amountShownK')::numeric
              <= (confirmation_context ->> 'balanceShownK')::numeric
        END
      ELSE false
    END,
    false
  )
);
