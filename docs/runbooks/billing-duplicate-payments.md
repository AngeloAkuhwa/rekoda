# Runbook: a merchant paid twice for one pack, or for one charge

Status: written in the MVP readiness review of PR #432 (13 Nov 2026). Reflects the code at that
PR's head. Nothing here moves money automatically: Rekoda never refunds on its own, and the
refund itself is a Paystack dashboard action taken by a person (ADR 0024, `docs/safety-review.md`).

## When this happens

Rekoda's own billing (a merchant paying Rekoda for a plan or a usage pack) can receive two verified
payments for one logical purchase:

- **`duplicate_purchase`** (migration 0214): a pack purchase is offered on more than one Paystack
  link (a link expired and was replaced, or the merchant opened two tabs). Both links carry the same
  `purchase_id`. The first verified payment credits the units; the database's unique index
  `subscription_charges_one_credit_per_purchase_ux` allows only one credited charge per business and
  purchase. The second verified payment is recorded as `paid` and set aside with
  `unapplied_reason = 'duplicate_purchase'`. The merchant's billing page shows it as **paid twice**.
- **`duplicate_payment`**: the same charge is paid again under a different Paystack session (a lost
  link was replaced and both sessions were paid). The charge stays paid once. The second payment is
  NOT recorded as a charge: settlement marks the Paystack event processed with reason
  `duplicate_payment`, moves the checkout attempt to `duplicate_paid` when there is one (a payment
  made through the charge's own reference has no attempt row), and logs a warning naming the charge
  reference and the business. It does not appear in the unapplied-charge queue.

In both cases no units, plan or entitlement are granted twice. What remains is money the merchant
paid Rekoda that Rekoda did not deliver anything for.

## 1. Find it

- **`duplicate_purchase`:** `GET /v1/ops/exceptions` (operator token, scope `ops:payment`) lists
  `unappliedCharges`. Each row has the charge reference, the business, the reason, `resolveBy` and
  `overdue`. A row with reason `duplicate_purchase` is this runbook's case.
- **`duplicate_payment`:** no operator endpoint lists it yet (a gap, recorded as OD-53 (5) in
  `docs/REKODA_LAUNCH_READINESS.md`). Find it from the settlement process's warning ("was paid twice
  ... refund the duplicate"), or as the database owner:

  ```sql
  SELECT a.business_id, c.reference AS charge, a.provider_reference AS second_payment, a.updated_at
    FROM subscription_charge_attempts a
    JOIN subscription_charges c ON c.id = a.charge_id
   WHERE a.status = 'duplicate_paid'
   ORDER BY a.updated_at DESC;
  ```

  A second payment with no attempt row is marked on its event only; list those too:

  ```sql
  SELECT business_id, external_id AS paystack_event, processed_at
    FROM external_events
   WHERE provider = 'paystack' AND error = 'duplicate_payment'
   ORDER BY processed_at DESC;
  ```

## 2. Establish the original purchase (`duplicate_purchase`; for `duplicate_payment` the original is the one paid charge)

For the set-aside reference, as the database owner on the host (read only):

```sql
SELECT reference, purchase_id, kind, pack_id, quantity, amount_k, status, paid_at,
       paid_amount_k, provider_reference, units_credited_at, unapplied_reason
  FROM subscription_charges
 WHERE business_id = '<business>'
   AND purchase_id = (SELECT purchase_id FROM subscription_charges WHERE reference = '<set-aside ref>')
 ORDER BY created_at;
```

Exactly one row of the purchase has `units_credited_at` set: that is the purchase that was
delivered. The set-aside row is the second payment.

## 3. Keep the evidence

Before anything else, record in the incident note (never in a chat channel, never a screenshot of a
customer's details):

- both Rekoda references and both `provider_reference` values (Paystack transaction ids);
- the Paystack dashboard's view of both transactions (amount, currency, status, paid-at time),
  checked against `paid_amount_k` and `paid_at` above;
- the row from step 2 showing which charge was credited.

A screenshot is never payment evidence (invariant 10). The Paystack transaction is.

## 4. Decide

A second payment for something already delivered is refundable in full. It is not a renewal, an
upgrade or a credit toward a later purchase unless the merchant asks for that in writing.

**Who authorises:** the owner (Angelo) authorises each refund of Rekoda's own billing. Whether a
delegated operator may authorise one, and up to what amount, is an **OPEN OWNER DECISION**
(`docs/REKODA_LAUNCH_READINESS.md`, OD-51 readiness review). Until it is ruled, every refund goes to
the owner.

## 5. Refund and record

1. Refund the second transaction in the Paystack dashboard (full amount). This is the only step that
   moves money.
2. **`duplicate_payment` only: do NOT call `POST /v1/ops/refund`.** The only charge it can name is
   the original, delivered one, and the call would record that charge as refunded while the merchant
   keeps the plan. Record the Paystack refund id in the incident note and on the business's support
   record instead; Rekoda has no record-only entry for a second payment of the same charge yet
   (OD-53 (5)). Skip to section 6.
3. `duplicate_purchase`: record it in Rekoda: `POST /v1/ops/refund` with `businessId`, `reference` (the set-aside
   reference), `amountK` (the kobo refunded) and `reason`. This writes the refunded amount, moves the
   charge to `refunded` when the whole amount is back, and writes an audit row naming the verified
   operator. It does not move money and does not touch the plan.
4. Close the exception: `POST /v1/ops/exceptions/charges/<reference>/resolve` with a resolution that
   names the Paystack refund id.

Both calls are audited with the operator's verified identity (`operator:<sub>`), never a name sent
in the body.

## 6. Tell the merchant

For `duplicate_purchase`, the billing page shows the charge as paid twice until it is refunded, then
as refunded. For `duplicate_payment`, the billing page shows nothing of the second payment (no charge
records it), so the message below is the merchant's only record of it. Tell the merchant directly,
through the billing email on file: what was paid twice, that the plan or pack was delivered once,
the amount refunded, and that Paystack refunds take the bank's usual time to arrive.
The wording of that message is an **OPEN OWNER DECISION** (no approved template exists yet). Never
send it on WhatsApp outside a 24-hour window as free text (Meta's rules).

## What this runbook does not cover

- Refunds of a merchant's own customers' payments (the merchant's books): a different procedure,
  not covered here.
- A payment that settlement could not verify (`price_not_verified`): the payment is held; check the
  pricing source (`docs/runbooks/deploy.md`, "Pricing source") before deciding.
