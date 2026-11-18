# Paid-launch implementation plan after PR #432 (OD-53 to OD-56)

Status: **PLAN, for the owner's rulings. Nothing here is approved, built or scheduled.** Written
18 Nov 2026 with the closeout of PR #432. OWN-94 stays authoritative: this plan does not change its
scope or sequencing, and any change to either needs the owner's approval. The questions, current
behaviour and evidence are in `docs/audits/pr-432/owner-decisions-od53-56.md` (cited below as Q1 to
Q22); the owner's preferred directions of 18 Nov 2026 are restated here as directions, not rulings.

## 1. Three gates, kept apart

| Gate                                 | What must be true                                                                                                                                                                                                                                                | Where it is decided                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **G1. PR #432 merges**               | Exact-head CI green; 0 unresolved threads; no known BLOCKING or IMPORTANT in-scope defect; P1 to P11 done by the owner; **P12 given by the owner on the exact final SHA**; ADR 0035 Amendment 6 accepted or the owner's written choice to merge with it PROPOSED | the owner (P12)                      |
| **G2. Test-mode staging acceptance** | G1; deploy D1 to D13 green; the staging acceptance journeys run on Paystack TEST keys, Meta templates approved where a step needs one; the D8 drill passes on the new schema                                                                                     | the owner, on staging evidence       |
| **G3. Paid production launch**       | G2; every item in §3 ruled and, where ruled to build, merged, deployed to staging and accepted there; live-provider verification (G-05, G-06) with explicit `LIVE_MODE_ALLOWED = YES`; production deploy only on an explicit owner instruction                   | the owner, separately from G1 and G2 |

No item in §3 is marked complete because PR #432 merges. OD-53 (4) pending-charge reconciliation
and OD-53 (5) individual duplicate-payment recovery are **mandatory G3 blockers**.

## 2. Rulings needed before any G3 work starts

The engineering below can be designed against the preferred directions, but these need an explicit
owner ruling first; none is invented here.

1. **Refund threshold (Q1):** the amount up to which a named `ops:refund` operator may record a
   refund, and who holds refund permission in the Paystack dashboard. No figure is proposed.
2. **Merchant messages (Q3):** approval of the exact wording of "duplicate payment verified" and
   "refund confirmed" (drafts in §5). No bank processing time is stated.
3. **Reservation window (Q16):** 72 hours is proposed, subject to approval.
4. **Refund policy categories (Q17, Q18):** whether the ordinary seven-day unused-pack rule leaves
   Rekoda free to correct its own incorrect charges and to remedy its own service failures, and the
   ADR 0024 and `/refunds` text in §4. No partial-refund formula is proposed or approved.
5. **Exceptional owner path (Q17):** an owner-only record path with verified provider evidence and a
   full audit trail; whether it may record an amount the owner states.
6. **Legacy packs (Q19):** refuse ordinary automatic eligibility for packs credited before 0230 or
   0235, with the owner path as their recovery; confirm the staging rebuild.
7. **OD-56 ambiguous plan (Q22):** a plan with more features but a lower annual price goes to support
   review (preferred) rather than a scheduled downgrade.
8. **Paystack account (Q14):** confirm whether Transfers is enabled and which account permissions can
   be removed.
9. **Settlement alert egress (Q7):** settlement sending its own alerts needs outbound HTTPS from that
   container (a deployment change).

Q2, Q4 to Q6, Q8 to Q13, Q15, Q20 and Q21 have preferred answers the owner has endorsed as directions;
each still needs a recorded ruling (an OWN entry) before its PR merges.

## 3. Implementation sequence (separate PRs after #432)

Each PR is one item of the closeout train (single flight), RED before GREEN, exact-head CI, an
independent review and the owner's merge decision. Dependencies are stated; nothing is parallel.

| PR  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends on                  | Gate | Rulings            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---- | ------------------ |
| C1  | **OD-53 (4) pending-charge reconciliation, in the settlement process.** A settlement-only, ID-only discovery function (pending, recently retired and paid charges; OWN-57 class, ADR 0035 amendment); each candidate verified with Paystack and applied through the same settlement path and invariants as the webhook (one charge applied once; an event replayed, a webhook missing, a provider outage or a retry never applies twice or changes a plan wrongly); bounded retries with backoff and a circuit breaker on provider errors; durable per-charge state so a restart resumes; an alert when the breaker opens or candidates age (alert egress per ruling 9) and the operator recovery path | #432                        | G3   | Q5, Q6, Q7         |
| C2  | **OD-53 (5) individual duplicate-payment records.** A record per verified duplicate payment of one charge; an operator work list (OWN-85 read); an idempotent record-only refund keyed by the Paystack refund id; the two merchant messages (ruling 2) on verified email and in-window WhatsApp; OWN-29's next-business-day internal target                                                                                                                                                                                                                                                                                                                                                            | C1 (shares discovery)       | G3   | Q3, Q8, Q9         |
| C3  | **OD-53 (1) and (2), OD-55 reserve-first refunds.** `ops:refund` scope with named operators and the ruled threshold; reserve the approved amount and revoke the units durably before the provider refund; operator executes in Paystack; attach the provider refund id; settlement verifies the provider result and finalises idempotently; a reservation is never released while the provider is unreachable or the outcome uncertain; a verified but unattached refund goes to an operator, never auto-finalised; the owner-only exceptional path (ruling 5); settlement corroborates every recorded refund (Q2)                                                                                     | C2                          | G3   | Q1, Q2, Q15 to Q19 |
| C4  | **OD-54 operator-plane hardening.** Move the six privileged operator writes to the operator process and credential; revoke the application's grants for them; guard operator-source audit rows; replace settlement's direct exception closing with fixed-actor definer functions; keep the recovery pre-check advisory with verification in the job; staging tools stay on the application credential under the staging-only safeguards                                                                                                                                                                                                                                                                | #432 (independent of C1–C3) | G3   | Q10 to Q13         |
| C5  | **OD-56 annual classification.** The cycle's interval as the single rule in the application and the database; the catalogue refuses annual prices that are not 10 x monthly until a discount is approved; the ambiguous case per ruling 7. Tests: grandfathered pricing, explicit annual prices, future repricing, support-review creation, paid-through date preserved                                                                                                                                                                                                                                                                                                                                | #432                        | G3   | Q20 to Q22         |
| C6  | **OD-53 (3)** align the application mirror of the seven-day prior-month metering window with the database rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | #432                        | G3   | Q4                 |

## 4. Proposed ADR 0024 and `/refunds` changes (for explicit approval; NOT applied)

ADR 0024 is Accepted and immutable: the change is a superseding amendment or an owner ruling, written
only after approval. Proposed rows for its refund table (`docs/adr/0024-the-commercial-terms.md`,
"Refunds"):

| Situation                                        | Outcome (proposed)                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add-on pack, completely unused, within 7 days    | Refundable (unchanged). Automatic eligibility only for a pack whose credit and allowance were recorded (0230, 0235, 0240); others go to the owner's exceptional path.                                           |
| Duplicate or incorrect charge (including a pack) | Full refund of the incorrect charge (unchanged), **whether or not the pack was used and whenever it is found**: the seven-day unused rule applies only to a correct pack purchase the merchant no longer wants. |
| Material Rekoda service failure we cannot remedy | Full or prorated refund as appropriate (unchanged), **including a pack, decided by the owner on recorded evidence**; no formula is set.                                                                         |

Proposed `/refunds` wording (`apps/web/src/app/refunds/page.tsx`), only after the ADR change:

- "You were charged twice, or charged the wrong amount" → "Full refund of the incorrect charge. This
  applies to add-on packs too, used or not."
- "Rekoda failed you and we could not put it right" → "Full or part refund, depending on how much you
  lost. This applies to add-on packs too."
- The two pack rows stay as they are.

## 5. Draft merchant messages (ruling 2)

- Detected: "We received two payments for {reference}. You were only meant to pay once, so we are
  refunding {amount} to the card or account you paid with. You do not need to do anything."
- Refunded: "We have refunded {amount} for the second payment of {reference}. Your bank will show it
  when it processes the refund."

Both carry figures computed by `@rekoda/core` from integer kobo; neither names a processing time.

## 6. The Paystack secret key in the API and worker processes (threat model, OD-54)

- **Fact:** the API, the worker and settlement hold `PAYSTACK_SECRET_KEY` (the platform key). The API
  and the worker also hold the `rekoda_app` and `rekoda_worker` database credentials.
- **What a compromise of the API or worker process can do with the key:** anything the Paystack
  account allows that key to do: initialise and verify transactions, list customers and transactions,
  create refunds, and, if Transfers is enabled on the account, initiate transfers to recipients. No
  code convention prevents this: "Rekoda never refunds automatically" is a property of the code we
  run, not of the credential, and a compromised process does not run our code.
- **What the database still prevents:** recording a refund in Rekoda (billing operator only, 0230),
  recording a payment as settled (settlement only, after its own verify), changing a plan (operator or
  settlement only). A refund initiated at Paystack by a compromised process would therefore not be
  reflected in Rekoda's books until reconciled (C1, C3).
- **Mitigations to rule on (Q14):** disable Transfers on the account if Paystack allows; restrict the
  dashboard roles that can refund; alert on Paystack refund and transfer webhooks that no operator
  recorded (C3); consider whether the API needs the key at all once checkout initialisation moves
  behind settlement (a design question for C3, not proposed here).
