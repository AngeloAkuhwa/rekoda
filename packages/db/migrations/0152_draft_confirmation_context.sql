-- What the merchant was SHOWN, stored beside the draft they will confirm
-- (G-49, owner ruling OWN-16).
--
-- A merchant may deliberately confirm an overpayment: the invoice is settled
-- up to its balance and the excess becomes customer credit. But a
-- confirmation made stale because the balance moved between the preview and
-- the "yes" must never be turned into credit. Telling the two apart needs
-- the figures the preview actually showed, and the draft kept none of them:
-- at "yes" the handler re-read the invoice and could only compare the
-- merchant's amount with the balance as it is NOW, which cannot distinguish
-- "they meant to pay over" from "the balance fell while they were typing".
--
-- `confirmation_context` is system-owned, deterministic state, computed
-- from SQL at preview time, beside the model's command in the same way
-- `identity_link` is. It is kept OUT of `command` on purpose: `command` is
-- the model's tokenised output and passes the transient-field policy
-- (`sanitizeCommandForPersistence`); this is neither. Ids and integer kobo
-- only, never a name, number, token or text; the exact shape is validated
-- by `parseConfirmationContext` in @rekoda/core, and this check keeps any
-- other writer to an object of a known kind.
--
-- Nullable, and NULL for every existing draft and every draft that is not a
-- confirmed overpayment: absent means today's conservative treatment.
ALTER TABLE command_drafts ADD COLUMN confirmation_context jsonb;
-- The database holds the shape too, not only the reader: exactly these six
-- keys, a known kind, a uuid and non-negative whole numbers, so no later
-- writer can park text (or anything that could carry PII) in this column.
--
-- Wrapped in COALESCE(..., false) on purpose: a CHECK that evaluates to NULL
-- PASSES, and a missing key makes the terms below NULL rather than false.
-- The number casts are reached only after jsonb_typeof said "number", because
-- AND short-circuits within a CASE.
ALTER TABLE command_drafts ADD CONSTRAINT command_drafts_confirmation_context_ck CHECK (
  confirmation_context IS NULL
  OR COALESCE(
    CASE
      WHEN jsonb_typeof(confirmation_context) <> 'object' THEN false
      WHEN NOT (confirmation_context ?& ARRAY[
        'kind', 'invoiceId', 'balanceShownK', 'amountReceivedK', 'allocatedK', 'creditK'
      ]) THEN false
      WHEN (confirmation_context - ARRAY[
        'kind', 'invoiceId', 'balanceShownK', 'amountReceivedK', 'allocatedK', 'creditK'
      ]) <> '{}'::jsonb THEN false
      WHEN (confirmation_context ->> 'kind') IS DISTINCT FROM 'payment_overpayment' THEN false
      WHEN jsonb_typeof(confirmation_context -> 'invoiceId') IS DISTINCT FROM 'string' THEN false
      WHEN (confirmation_context ->> 'invoiceId')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN false
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
    END,
    false
  )
);
