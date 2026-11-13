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
- **`duplicate_payment`**: the same charge is paid again under a different Paystack session. The
  charge stays paid once; the extra payment is flagged for a person.

In both cases no units, plan or entitlement are granted twice. What remains is money the merchant
paid Rekoda that Rekoda did not deliver anything for.

## 1. Find it

`GET /v1/ops/exceptions` (operator token, scope `ops:payment`) lists `unappliedCharges`. Each row
has the charge reference, the business, the reason, `resolveBy` and `overdue`. A
`duplicate_purchase` or `duplicate_payment` row is this runbook's case. The dead-job and stranded
event lanes of the same endpoint are not.

## 2. Establish the original purchase

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
2. Record it in Rekoda: `POST /v1/ops/refund` with `businessId`, `reference` (the set-aside
   reference), `amountK` (the kobo refunded) and `reason`. This writes the refunded amount, moves the
   charge to `refunded` when the whole amount is back, and writes an audit row naming the verified
   operator. It does not move money and does not touch the plan.
3. Close the exception: `POST /v1/ops/exceptions/charges/<reference>/resolve` with a resolution that
   names the Paystack refund id.

Both calls are audited with the operator's verified identity (`operator:<sub>`), never a name sent
in the body.

## 6. Tell the merchant

The billing page shows the charge as paid twice until it is refunded, then as refunded. Tell the
merchant directly, through the billing email on file: what was paid twice, that the pack was
delivered once, the amount refunded, and that Paystack refunds take the bank's usual time to arrive.
The wording of that message is an **OPEN OWNER DECISION** (no approved template exists yet). Never
send it on WhatsApp outside a 24-hour window as free text (Meta's rules).

## What this runbook does not cover

- Refunds of a merchant's own customers' payments (the merchant's books): a different procedure,
  not covered here.
- A payment that settlement could not verify (`price_not_verified`): the payment is held; check the
  pricing source (`docs/runbooks/deploy.md`, "Pricing source") before deciding.
