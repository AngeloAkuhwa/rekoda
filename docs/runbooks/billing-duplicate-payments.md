# Runbook: a merchant paid twice for one pack, or for one charge

Status: written in the MVP readiness review of PR #432 (13 Nov 2026); refund recording updated for
migration 0230 (15 Nov 2026, OWN-94) and for migration 0235 (17 Nov 2026: one record per Paystack refund, keyed by
its refund id; PR #432, CODE COMPLETE, not merged, not deployed). Nothing here moves money automatically: Rekoda never refunds on its own, and the
refund itself is a Paystack dashboard action taken by a person (ADR 0024, `docs/safety-review.md`).

## When this happens

Rekoda's own billing (a merchant paying Rekoda for a plan or a usage pack) can receive two verified
payments for one logical purchase:

- **`duplicate_purchase`** (migration 0214): a pack purchase is offered on more than one Paystack
  link (a link expired and was replaced, or the merchant opened two tabs). Both links carry the same
  `purchase_id`. The first verified payment credits the units; the database's unique index
  `subscription_charges_one_credit_per_purchase_ux` allows only one credited charge per business and
  purchase. The second verified payment is recorded as `paid` and set aside with
  `unapplied_reason = 'duplicate_purchase'`. The merchant's billing page shows it under **Payment received, not applied**, explaining that it was already paid for and no extra units were added.
- **`duplicate_payment`**: the same charge is paid again under a different Paystack session (a lost
  link was replaced and both sessions were paid). The charge stays paid once. The second payment is
  NOT recorded as a charge: settlement marks the Paystack event processed with reason
  `duplicate_payment`, moves the checkout attempt to `duplicate_paid` when there is one (a payment
  made through the charge's own reference has no attempt row), and logs a warning naming the charge
  reference and the business. It does not appear in the unapplied-charge queue.

In both cases no units, plan or entitlement are granted twice. What remains is money the merchant
paid Rekoda that Rekoda did not deliver anything for.

## 1. Find it

- **`duplicate_purchase`:** `GET /v1/ops/exceptions` (operator token, scope `ops:read`) lists
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
(`docs/REKODA_LAUNCH_READINESS.md`, OD-53 (1)). Until it is ruled, every refund goes to
the owner.

## 5. Refund and record

> **Before refunding a CREDITED pack in Paystack, check that Rekoda can record it (OD-55 (iv)).**
> Eligibility is judged only when the refund is recorded, and the recording needs the Paystack
> refund id, so the money goes back first. If the pack is not eligible at that moment the
> recording is refused for good while the money is already back. Check, immediately before
> refunding: the pack is unused, it was credited less than seven days ago, and nothing changed the
> business's plan, plan version or add-on holdings since the credit (0240). Type the amount once,
> exactly: a corrected second call conflicts with the recorded refund id. Until the owner rules
> OD-55, a pack refund is an owner-supervised manual procedure.

1. Refund the second transaction in the Paystack dashboard (full amount). This is the only step that
   moves money.
2. **`duplicate_payment` only: do NOT call `POST /v1/ops/refund`.** The only charge it can name is
   the original, delivered one, and the call would record that charge as refunded while the merchant
   keeps the plan. Record the Paystack refund id in the incident note and on the business's support
   record instead; Rekoda has no record-only entry for a second payment of the same charge yet
   (OD-53 (5)). Skip to section 6.
3. `duplicate_purchase`: record it in Rekoda: `POST /v1/ops/refund` with `businessId`, `reference` (the set-aside
   reference), `amountK` (the kobo refunded), `reason` (one of `duplicate_charge`,
   `incorrect_amount`, `service_failure`, `unused_add_on`, `suspension_error`; use
   `duplicate_charge` here) and `providerRefundId` (the refund id Paystack shows for the refund
   made in step 1; required since 0235):

   ```sh
   curl -sS -X POST https://<api host>/v1/ops/refund \
     -H "authorization: Bearer <billing-audience token with ops:payment>" \
     -H 'content-type: application/json' \
     -d '{"businessId":"<business id>","reference":"<set-aside reference>","amountK":<kobo refunded>,"reason":"duplicate_charge","providerRefundId":"<Paystack refund id>"}'
   ```

   A repeat with the same `providerRefundId`, charge and amount is safe: it records nothing new and
   answers `"replayed":true` with what was recorded, so if the first call's outcome is unknown (a
   timeout), send it again. The same id with another amount, charge or business is refused. Two
   genuine partial refunds have two Paystack ids and are both recorded, up to the charge. Since migration 0230 this route is served by the **operator
   process** (Caddy sends it to `operator:3002`): the token must be issued for
   `OPERATOR_BILLING_OIDC_AUDIENCE` and carry `ops:payment`; an API-audience token is refused,
   and an API host answers 404. It writes the refunded amount, moves the charge to `refunded`
   when the whole amount is back, and writes an audit row naming the verified operator. It does
   not move money and does not touch the plan. The set-aside charge was never credited, so no
   units are revoked. (A refund of a CREDITED pack is a different case: only in full, of an
   unused pack, within seven days of its credit, and since 0235 and 0240 only while the plan
   allowance is the one recorded when the pack was credited and no plan, plan-version or add-on
   change has been recorded since; its units are revoked in the same step;
   anything else is refused. A partial refund of a pack is not approved: OWN-94. A refused
   credited-pack refund, a pack whose allowance changed since its credit, a used or older pack
   refunded under the "incorrect charge" or "service failure" terms, or a pack credited before
   0235 **cannot be recorded in Rekoda** until the owner rules OD-55
   (`docs/REKODA_LAUNCH_READINESS.md`): do not refund such a pack in Paystack without the owner's
   written instruction, and if one has been refunded, record the Paystack refund id in the
   incident note, because Rekoda's record will still show the pack paid with its units.)

4. Close the exception: `POST /v1/ops/exceptions/charges/<reference>/resolve` with a resolution that
   names the Paystack refund id.

Both calls are audited with the operator's verified identity (`operator:<sub>`), never a name sent
in the body.

## 6. Tell the merchant

For `duplicate_purchase`, the billing page shows the charge as paid twice until it is refunded, then
as refunded. For `duplicate_payment`, the billing page shows nothing of the second payment (no charge
records it), so the message below is the merchant's only record of it. Tell the merchant directly,
through the billing email on file **only if it is verified** (`billing_email_verified_at` is set; an
unverified address is never a destination, OWN-83), otherwise on WhatsApp inside the merchant's
24-hour window or with an approved template: what was paid twice, that the plan or pack was delivered once,
the amount refunded, and that Paystack refunds take the bank's usual time to arrive.
The wording of that message is an **OPEN OWNER DECISION** (OD-53 (2); no approved template exists yet). Never
send it on WhatsApp outside a 24-hour window as free text (Meta's rules).

## What this runbook does not cover

- Refunds of a merchant's own customers' payments (the merchant's books): a different procedure,
  not covered here.
- A payment that settlement could not verify (`price_not_verified`): the payment is held; check the
  pricing source (`docs/runbooks/deploy.md`, "Pricing source") before deciding.
