# Owner decision paper: OD-53 (1)–(5), OD-54, OD-55, OD-56

Repository `rekoda`, branch `review/pr-432`, head `0b4956ab985009291f3e3aaa4136516e0839d6e5` (PR #432, OPEN, not merged, not deployed). Written read-only on 18 Nov 2026. **Nothing here is approved.** Each "recommended" option is engineering advice for the owner to rule on. Settled matters are taken as given and not reopened: OWN-94 (7) and (8) (all remaining units revoked; a full pack refund only for an unused pack within seven days; no partial formula), OWN-89/OWN-91 (separate settlement and operator principals, OD-51.1–51.7), OWN-85 (fixed-column operator work lists), OWN-76 (no automatic settlement replay), OWN-29 (no automatic provider refund or credit) and OWN-40 (annual = monthly x 10).

## 0. The four principals at HEAD

These facts come from the migrations and `docker-compose.prod.yml`. They shape every recommendation below.

| Principal                 | What it can do at HEAD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Which process holds it                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `rekoda_app`              | SELECT, INSERT, UPDATE and DELETE on every public table by default (0001:22–24). It keeps INSERT on `audit_events` with any actor and any `source_type`; only UPDATE and DELETE are revoked (0001:27). Narrowed since: it opens only pristine pending charges and moves no charge status (guards in 0202:107–158, 0230, 0235:93–260). It lost the operator writer and `business_add_ons` (0202:89–93, 193). It holds UPDATE on the recovery and closing columns of `dead_job_exceptions` (0194:216–217), UPDATE on `jobs (state, locked_at, locked_by, run_at, max_attempts)` (0220:84) under transition guards (0223, 0227), and EXECUTE on `dead_job_enrolment_requeue` (0229:211). | **api and worker** (`env_file: .env`; only the settlement and operator URLs are blanked, compose lines 120–131 and 176–189) |
| `rekoda_worker`           | SELECT everywhere, for cross-tenant discovery (OWN-57). Writes only to the queue, the outbox and its own bookkeeping (0210). EXECUTE on the operator work-list definers (0194:203–207, 0195, 0199, 0225, 0229, 0236) and on `job_payload` (0228/0231/0234).                                                                                                                                                                                                                                                                                                                                                                                                                           | **worker and api**: `GET /v1/ops/exceptions` reads through `this.workerDb` (`health/ops.controller.ts:497–505`)             |
| `rekoda_settlement`       | Not a member of `rekoda_app` (0217:105). Holds exact grants (0217:128–168): payment columns on charges, cycle columns, `external_events (processed_at, error)`, INSERT on `audit_events`, INSERT and UPDATE on `dead_job_exceptions` **including `closed_at, closed_by, resolution`** (0217:166), and only its own two job kinds (0217:173–181). It has **no INSERT on `jobs` or `external_events`**.                                                                                                                                                                                                                                                                                 | settlement process only. It also holds `PAYSTACK_SECRET_KEY` and `VAULT_KEY`                                                |
| `rekoda_billing_operator` | Not a member of `rekoda_app` (0211:23). Holds SELECT on `businesses` and `plan_versions`, UPDATE on `updated_at` only (0221:153–169), EXECUTE on `subscription_operator_set_plan`, on the review functions and on `subscription_record_refund` (0235:538–541), and SELECT on `subscription_refunds` (0235:70).                                                                                                                                                                                                                                                                                                                                                                        | operator process only (`operator-plane/server.ts:51–59`, three routes). It has **no Paystack key**                          |

Two consequences matter below. First, the app/worker split is a split of database rights, not a process boundary: both processes hold both credentials. Second, the **API and worker hold the platform Paystack secret key**. That key authorises Paystack's own refund API (`paystack.provider.ts:214–247` reads refunds with it), so "Rekoda never refunds automatically" is enforced by code policy, not by who holds the credential.

---

## OD-53: Rekoda's own duplicate payments, refunds and reconciliation

The register says: "None blocks the code; (1), (2) and (5) bear on the first refund of a duplicate payment, (3) decides whether an engineering default stands … (4) … and (5) … are **PAID-LAUNCH BLOCKERS, NOT BUILT**: OWN-94 forbids deferring them silently; neither blocks test-mode staging."

### OD-53 (1): Who may authorise a refund of Rekoda's own billing

**Problem (register):** "Who may authorise a refund of Rekoda's own billing … Options: A, the owner only (safe, slow); B, a named operator up to a stated amount, owner above it. Recommendation: A until the first ten merchants, then B."

**Current behaviour.** Any verified operator token for `OPERATOR_BILLING_OIDC_AUDIENCE` that carries `ops:payment` can record a refund of any amount (`operator-plane/server.ts:58`; `refund-operations.ts:20–47`). The same scope also covers dead-job recovery and exception resolution (`dead-jobs.controller.ts:75,104,133`; `ops.controller.ts:567,600,639`). The database checks the shape of the actor (`^operator:[!-~]{1,255}$`, 0235:436) and the refund rules. It does not check the amount against any authority, and it does not check that the Paystack refund id is real: the id is taken on the operator's word. The audit row stores `operator:<sub>` (0235:530–535) but not the token's issuer, `jti` or issue time. The identity verifier trims `sub` (`auth/operator-identity.ts:103`, B-4). The runbook (§4) currently sends every refund to the owner.

**Options.**

- **A.** Owner only. This needs a distinct owner-only scope, because today's `ops:payment` already lets others record.
- **B.** A new `ops:refund` scope, separate from `ops:payment`. A named operator records up to a stated amount; an `ops:refund_owner` scope is required above it. The operator process enforces the threshold; the database cannot verify a token claim (OD-51.1 makes the operator process the trust anchor).
- **C.** B plus a second approver above the threshold. This adds a two-step record: request, then approve by a different subject.

**Implementation for any option.** Split the scope. Record `iss`, `sub` (refused, not trimmed, if it carries whitespace), `jti` and `iat` in the audit row. Add **Paystack corroboration**: the settlement process already holds the key and the read-only `verifyRefund` / `listRefunds` (`paystack.provider.ts:214–247`). It should verify each recorded `providerRefundId` against the charge's transaction, amount and currency, stamp the result as verified, and raise an operator exception on a mismatch. This is what makes the audit evidence verifiable. The operator's word becomes a claim that Paystack confirms or contradicts.

**Risks.** Recording a refund moves no money. Money moves when a person uses the Paystack dashboard, or when a holder of the secret key calls Paystack's API. Rekoda's refund authority is therefore really **Paystack dashboard roles and key custody**, and this ruling must name both. A false record (refund recorded, none made) hides revenue; it does not lose money. The corroboration step closes that gap.

**Recommendation.** B with the corroboration and scope split in place, and owner-only for every OD-55 exception path. I disagree mildly with the register's "A until ten merchants": the control that matters is Paystack access plus corroboration, not the count of merchants. A is acceptable if the owner prefers it until the corroboration ships.

**Release impact.** Does not block the merge or test-mode staging. Blocks paid launch (launch-readiness line 786).

**Question.** Which subjects may record a refund, up to what amount in naira, and who holds refund permission in the Paystack dashboard? _Preferred answer:_ named billing operators up to an amount the owner sets, the owner above it and for every OD-55 path, with Paystack refund permission held by the same people.

### OD-53 (2): The merchant message for a duplicate payment and its refund

**Problem (register):** "The merchant message for a duplicate payment and its refund (billing email): no approved wording exists."

**Current behaviour.**

- For `duplicate_purchase`, the billing page says "this top-up had already been paid for. No extra units were added, and our team is reviewing this second payment" (`apps/web/src/lib/payment-record-copy.ts:76–81`).
- For `duplicate_payment`, the merchant sees nothing: no charge records the second payment (runbook §6).
- The runbook prescribes the verified billing email or WhatsApp inside the 24-hour window. Any WhatsApp message outside that window needs a sixth Meta template. Under OWN-93 that template is named only in `.env` and needs Meta approval.

**Options.**

- **A.** One message, sent after the refund.
- **B.** Two messages: one when the duplicate is detected ("we received two payments; we will refund one"), and one when it is refunded.

The wording is the same for both: what was paid twice, the reference, that it was applied once, the amount refunded, and that "Paystack refunds take your bank's usual time to arrive". Do not state a number of days unless Paystack confirms one.

**Implementation.** A template fed with values that `@rekoda/core` computes (invariant 2). Once (5) exists, a billing-page row for the duplicate. Email is sent only to a verified address (OWN-83). The WhatsApp template is optional.

**Risks.** If the merchant hears nothing, they may raise a chargeback. If the message promises a refund before it is authorised, Rekoda has made a promise it may not keep.

**Recommendation.** B, email first. Send the WhatsApp version only inside the 24-hour window until a template is approved.

**Release impact.** Blocks paid launch only.

**Question.** Approve two factual messages (detected, then refunded) with no stated bank timing, on verified email and in-window WhatsApp? _Preferred answer:_ yes.

### OD-53 (3): Metering a delayed message on last month's row

**Problem (register):** a message that arrived last month may be metered on last month's row "during the first seven days of the new month, but only on a row last month already opened". A compromised API can gain "the headroom left on last month's existing rows, measured against the CURRENT plan's ceiling". "Options: A, keep seven days; B, two days."

**Current behaviour.** The database chooses the row in `rekoda_private.usage_meter_row_at` (0222:149–184). The caller's period label is honoured for the previous month while the Lagos day of the month is 7 or less, and only if the row exists. The application mirror `meterOn` (`packages/db/src/repos/usage.ts:87–100`) does **not** apply the row-exists condition. The database stays authoritative, but the two rules are not identical. The ceiling is the current entitlement (0222 `usage_reserve`).

**Options.**

- **A.** Keep seven days. Make `meterOn` mirror the row-exists rule and document the window in the spec.
- **B.** Two days.
- **C.** Derive the month from a server-recorded arrival time of the bound event (0218 binding) instead of the caller's label. This is stronger than A only if that time is set by the database: `rekoda_app` can insert `external_events` with any column value under the 0001 grants, so C needs a DB-defaulted, non-insertable timestamp first.

**Risks.** The bounded gain is unmetered model and messaging cost for one business, never another tenant's allowance or money. A holder of the API credential already writes `used` on the current month by design (0202 header, lines 36–40).

**Recommendation.** A, plus the mirror fix. C is a later hardening.

**Release impact.** None. This is an engineering default; it is not in the paid-launch list.

**Question.** Keep the seven-day window as documented policy? _Preferred answer:_ yes. This matches the owner's "documented, consistent window".

### OD-53 (4): A daily reconciliation of pending charges against Paystack verify

**Problem (register):** whether to build "a daily reconciliation of Rekoda's own pending charges against Paystack's verify endpoint, which would detect a payment withheld by a compromised API credential (and any webhook Paystack never delivered)".

**Current behaviour.** Settlement happens only when a Paystack event reaches a `billing.process` job. The API records the event; the worker's pump attributes it and enqueues the job on `rekoda_app` (`payments/paystack-pump.ts`, header). The settlement process then verifies it (`jobs/process-billing-charge.handler.ts:142`). There is no sweep. If a webhook never arrives:

- the charge stays `pending` indefinitely;
- the lost-link recovery verifies and answers the merchant `payment_received` but settles nothing (`billing/billing-checkout.service.ts:160, 449–462`).

A compromised API or worker can withhold the event or the job. The verification code is already reusable (`verifyPaystackTransaction`, `paystack.provider.ts:414–461`).

**Options.**

- **A.** Build it before paid launch (register).
- **B.** Rely on merchant complaints and the lost-link recovery.

**Recommended design (A).**

1. **Where it runs.** In the **settlement process**, on its own timer (the `sweep-schedule.ts` pattern). It must not run in the worker. The reconciliation exists to audit the credentials the API and worker hold, so its scheduling must not depend on them. On this point I disagree with "reuse the job queue" as literally stated. Reuse the `JobRunner`, the leases and the dead-job records **inside settlement only**, as a third settlement kind (`billing.reconcile`). That requires granting settlement INSERT on `jobs`, limited by the existing restrictive `settlement_only_its_kinds` policy (0217:177–181), and tests with the real principals that `rekoda_app` cannot delete, delay or complete such jobs. If that cannot be proven, keep the schedule state in a settlement-only table instead.
2. **Discovery.** A new `SECURITY DEFINER` function that returns IDs only, with EXECUTE for `rekoda_settlement` alone (OWN-57 class, ADR 0035 Amendment 1). It returns `(charge id, business id)` for charges in one of three states: pending with a live attempt (`initializing/active/ambiguous`); retired within the session lifetime (a compromised app can retire pending charges); or paid, to look for a second paid attempt. Keyset cursor with a lease (the 0199 pattern, OWN-88/89). **This is a new cross-tenant read and needs owner approval (OWN-85).**
3. **Per charge.** Verify each attempt's provider reference. Then, in one transaction, lock the business and then the charge, in the same order as the webhook path (`process-billing-charge.handler.ts:157–160`). Re-check that the charge is still `pending`, and settle through **the same function the webhook handler uses**, refactored out of the handler so it can run without an event. This preserves the price re-verification (0209, `verifiedPriceRefusal`, `billing.service.ts:1050–1063`).
4. **No double settlement.** The defences are layered:
   - the database guard: settlement moves a status only out of `pending` (0235:189);
   - the one-credit-per-purchase unique index (0214);
   - `subscription_apply_paid_charge`, which applies only a paid, unapplied charge (0200/0206);
   - the attempt moves to `paid`, so a late webhook for the same reference becomes `already_paid` (handler 100–134), and one for a different reference becomes `duplicate_payment`, which feeds (5).
     OWN-29 still governs payments that are stale.
5. **Retries and outages.** A `PaystackApiError` or timeout is never a verdict. Back off per charge (for example 15 min, 1 h, 6 h, then daily, ending after 30 days in an operator exception). Stop the pass after N consecutive provider errors, open a circuit, and alert. "Not found" counts as not paid only after the session has expired.
6. **Alerts.** Raise an alert on "Paystack paid, Rekoda pending for more than X", on "provider unreachable for more than Y", and on any mismatch. The worker's alert pass would read a fixed aggregate count under OWN-36. Better still, settlement posts its own notice, so that a compromised worker cannot suppress the alert. That would need alert egress for settlement, which is an owner choice.
7. **Refunds.** The same pass corroborates recorded refund ids (OD-53 (1)). It matches Paystack refund events on Rekoda charges, which are already flagged `billing_refund_event` (handler 78–83), against `subscription_refunds`.

**Risks.**

- Applying a settlement that has been withheld or is stale: mitigated by points 3 and 4.
- Paystack rate limits: mitigated by batch bounds.
- Verifying inside a transaction for up to 15 seconds (`REQUEST_TIMEOUT_MS`): the same as the handler today. Verifying before locking, then re-checking under the lock, is safer.

**Release impact.** Blocks paid launch (GATE 8; "never dropped from this list"). It does not block staging.

**Questions.** Build it before paid launch, in the settlement process? Approve the new settlement-only, ID-only discovery function? _Preferred answer:_ yes and yes.

### OD-53 (5): The operator surface and record-only refund for `duplicate_payment`

**Problem (register):** a second payment of the same charge "has no operator surface and no record-only refund entry … `POST /v1/ops/refund` would record the refund against the original, delivered charge". Recommendation: "B before paid launch."

**Current behaviour.** The handler verifies the second payment, moves the attempt to `duplicate_paid` if one exists, marks the event `duplicate_payment` and logs a warning (`process-billing-charge.handler.ts:108–125, 248–270`). The verified amount is not stored anywhere. `subscription_refunds.charge_id` is NOT NULL (0235:43–56), so a refund of a second payment has nowhere to be recorded.

**Options.**

- **A.** Refund by hand, with the incident note as the record.
- **B.** Build the surface and the record.

**Implementation (B).**

1. A table `subscription_duplicate_payments`: business id, charge id, second provider reference (UNIQUE), Paystack transaction id, **verified** amount, paid-at time, how it was detected (webhook or reconciliation), status, refunded amount. It is written by a settlement-only definer called from the two handler branches and from the reconciler, so a replayed event is a no-op.
2. A fixed-column worker definer that adds the rows to `GET /v1/ops/exceptions` (the Amendment 2 shape; a new cross-tenant read, OWN-85).
3. The refund record: either `subscription_refunds` gains a nullable `duplicate_payment_id` with a CHECK that exactly one parent is set, or a sibling function `subscription_record_duplicate_refund`. The billing operator alone may run it; the amount may not exceed the verified amount; the existing unique provider refund id prevents one Paystack refund being recorded twice across both kinds. No units or plan are touched.
4. A billing-page row (copy per (2)) and a merchant notice.
5. The runbook's SQL in §1 is replaced.

**Risks.** Without this, Rekoda holds money it delivered nothing for, with no record and no SLA. If an operator records a duplicate refund against the original charge, the original charge shows as refunded while the merchant keeps the plan; the runbook warns against exactly that misstatement.

**Recommendation.** B, with the same next-business-day SLA as OWN-29 (that SLA is a separate question).

**Release impact.** Blocks paid launch only.

**Questions.** Build B before paid launch? Apply the OWN-29 SLA to duplicate payments? _Preferred answer:_ yes and yes.

---

## OD-54: Audit integrity of app-plane operator actions

**Problem (register):** "`rekoda_app` has held INSERT on `audit_events` with any actor since 0001 … holds EXECUTE on `dead_job_enrolment_requeue` … and holds UPDATE on the closing columns of `dead_job_exceptions` … a holder of the application credential can forge operator audit rows and close dead-job operator items." Also B-3: settlement "could close its own dead-job records". "Options: A … accept …; B, move … to the dedicated operator process and credential … Recommendation: B before paid launch; A is acceptable for test-mode staging."

**Current behaviour.**

- The following routes run on the API, with the actor taken from the API's OIDC check and written on `rekoda_app`: recover (`health/dead-job-recovery.service.ts:50–98`, `beginRecovery` on `this.db`), resolve (`:100–118`), enrolment requeue (`:136–141`, the 0229 definer granted to `rekoda_app`), and the resolve routes for exceptions, unapplied charges and blocked renewals (`ops.controller.ts:567–675`).
- The repository code that writes `source_type 'operator'` audit rows on the app credential: `dead-jobs.ts:458`, `events.ts:804`, `subscriptions.ts:2845`.
- Since 0239, CHECK constraints refuse a malformed actor but accept any actor in the right form (0239:17–20).
- The recovery requeue of a dead job also runs on the application credential (ADR 0035 Am. 6 §5; 0238).

**Options.**

- **A.** Accept, and record as a residual.
- **B.** Move the writes, as the owner prefers.
- **B-minimal.** Only the audit guard plus revoking the column grants, with the routes left on the API. Not recommended: the API could no longer write them at all.

**Implementation (B).**

1. **Operator-only definers**, each one pinned, checking its state transition, writing its own audit row and granted only to `rekoda_billing_operator`: request recovery (and requeue the dead job); resolve a dead job; enrolment requeue (re-granted from `rekoda_app`); resolve an event exception; resolve an unapplied charge; resolve a blocked renewal.
2. **No new cross-tenant read.** The operator console already receives `businessId` from `GET /v1/ops/exceptions`. The body carries it, as `/v1/ops/refund` already does, and the definer refuses a record that does not belong to that business. The work-list reads stay on the worker credential.
3. **The Paystack pre-check at recovery.** The operator process has no Paystack key, and should not get one, because that key can move money. The handlers already verify before applying anything (`process-billing-charge.handler.ts:142`; `process-payment-event.handler.ts:118`), which satisfies OWN-76's "verifies the payment before applying anything". The pre-check can stay on the API as an advisory read with no write. The owner should confirm this reading of OWN-76.
4. **Revoke** `rekoda_app` UPDATE on the recovery and closing columns of `dead_job_exceptions` (0194:217) and on `blocked_resolved_by` / `unapplied_resolved_by`. Revoke the app's dead→pending requeue right.
5. **System closes** go through definers with a fixed actor (`system:recovery`, `system:<sweep>`), allowed only when the job is `done` and a recovery was requested. This also replaces settlement's closing UPDATE (0217:166), which answers B-3.
6. **A guard on `audit_events`.** An INSERT with `source_type = 'operator'` (or actor `operator:%`) is refused unless it runs inside an approved definer, that is, unless `current_user` is the owner. This needs tests with the real principals.
7. B-4: refuse a subject with surrounding whitespace instead of trimming it.
8. Add routes to the operator process with their scopes, route them in Caddy, and have the API answer 404 for them (`OperatorPlaneServedHere`).
9. The staging tools (0197, 0239 columns) stay on the app credential: they are test-data only and gated at boot. That is a residual the owner must accept or move.

**Residual after B.** The database owner (OD-51.5), compromise of the identity provider, and compromise of the operator process. Separately, and more serious than a forged audit row, the API and worker hold `PAYSTACK_SECRET_KEY`: whoever holds it can refund through Paystack and, if Transfers is enabled on Rekoda's Paystack account (to be confirmed with Paystack), pay out money. OD-54 does not address this. The refund corroboration in OD-53 (4) is the compensating detective control.

**Recommendation.** B before paid launch. I agree with the owner's direction.

**Release impact.** Not merge, not staging. Paid launch.

**Questions.** Move the six writes to the operator process and credential, with the audit guard? Should settlement lose its closing UPDATE? Do the staging tools stay on the app credential? Is the recovery pre-check advisory? _Preferred answers:_ yes; yes; yes (staging-only residual); yes.

---

## OD-55: Credited-pack refunds the automatic rule cannot decide, and the refund-order race

**Problem (register).** `subscription_record_refund` refuses, with no sanctioned recording path:

- "(i) a pack whose plan allowance changed since the credit";
- "(ii) refunds under ADR 0024's 'incorrect charge' and 'Rekoda service failure' rows for a used or more-than-seven-day-old pack";
- "(iii) packs credited before 0230 … and before 0235";
- "(iv) the refund-order race … the operator refund[s] in Paystack first … units used, the seven-day window passing or an allowance change between the two make the recording permanently refused while the money is already back, and a mistyped amount is also permanent."

Recommendation: "C before paid launch" for (i)–(iii), and "A, a reserve-first flow" for (iv).

**Current behaviour.**

- Eligibility is judged only when the refund is recorded (0235:475–503; 0240 adds the allowance-change history).
- The id must already exist in Paystack (0235:437).
- A replay of the same id, charge and amount is idempotent; any other combination is a permanent conflict (0235:458–468).
- The public `/refunds` page promises "Full refund of the incorrect charge", "Full or part refund" for a service failure, and "Untouched within 7 days, we refund it" (`apps/web/src/app/refunds/page.tsx:53–58, 103–106`).

**Recommended workflow for (iv): reserve first.** No step moves money automatically.

1. **Reserve.** `subscription_reserve_refund(business, reference, reason, actor, idempotency_key)`, granted to the operator alone. It judges eligibility **now**, with today's rules (unused, within seven days, unchanged allowance, full amount, per OWN-94 (8)). In the same transaction it revokes the remaining units (OWN-94 (7)), so they cannot be consumed during the race, and it fixes the amount to the charge. It enforces one open reservation per charge (a partial unique index). The same idempotency key returns the same reservation.
2. **Refund in Paystack.** A person refunds exactly the reserved amount.
3. **Attach.** `subscription_attach_refund(reservation, provider_refund_id)` records the refund. It **cannot be refused on usage or time grounds**, because eligibility was fixed at the reservation. It is refused only if the id is reused elsewhere or the reservation is closed. A retry with the same id is a no-op.
4. **Verify.** The settlement reconciler (OD-53 (4)) checks the attached id with `verifyRefund`: the refund belongs to the charge's transaction, has the reserved amount, is in NGN and has a status that counts as success. A mismatch, such as a mistyped amount in Paystack, becomes an operator exception for an owner-only correction (option C of (iv)). It is never silently absorbed (invariant 6).
5. **Uncertain outcomes.** A reservation with no id after N hours is checked with `listRefunds(transaction)`. If a refund with the reserved amount exists, it is flagged "found, not attached" for the operator to attach. Whether to attach it automatically, since it is a verified fact and moves no money, is a separate owner question.
6. **Expiry.** After a stated time, a reservation with no id **and** a provider answer showing no refund is released and its units are restored, with an audit row. A reservation is never released while the provider is unreachable or the answer is unknown; it stays open and raises an alert. Restoring units raises `bonus`, which only a definer may do (the 0202 guard).

**Policy questions, not engineering.** None of these may be invented:

- (i) **Allowance changed since the credit.** Is the pack refundable at all, and if so who decides that it was unused?
- (ii) **Does OWN-94 (8) govern the "incorrect charge" and "service failure" rows for packs?** If it does, the `/refunds` copy must say so (B: a superseding note to ADR 0024 plus aligned copy). If it does not, the full or part amount for a used pack needs an owner-only, record-only path (A), whose amount the owner states case by case, with no formula. Note that "part refund" for a service failure has no approved formula.
- (iii) **Packs credited before 0230 or 0235.** PR #432 is not deployed, so these exist only on test databases. Should they simply be refused, with a staging rebuild (the CR-1 rule)?
- Is the reservation window 24 hours, 72 hours or something else?

**Risks.** Today, once money is back, a recording can be refused forever, so Rekoda shows a pack as paid with its units still live (invariant 6). Reserve-first removes that, at the cost of revoking units before the money is back. A reservation abandoned without restoring the units would harm the merchant; step 6 bounds that.

**Recommendation.** For (iv), A. For (i)–(iii), C: an owner-only record-only path plus the ADR 0024 note and the copy fix.

**Release impact.** Not merge, not staging. Paid launch. Until then, every pack refund is owner-supervised.

**Questions.** Build reserve-first? Which window? Is there an owner-only record-only path? Does OWN-94 (8) apply to the ADR 0024 incorrect-charge and service-failure rows? _Preferred answers:_ yes; 72 hours; yes; owner to state. I make no recommendation on the last one, because it is commercial.

---

## OD-56: Which interval decides whether an annual subscriber's change is an upgrade

**Problem (register):** "The application compares the existing cycles at monthly prices (`pricingIntervalFor` …); the database's support-review functions compare at the cycle's interval (annual: the explicit annual price, else monthly x 10; `review_plan_price`, 0232) … can disagree when an explicit annual price breaks that ratio; the merchant is then answered the truthful `support_review_unavailable`. Options: A … cycle's interval …; B … monthly. Recommendation: A."

**Current behaviour.**

- `pricingIntervalFor` returns `monthly` unless the business is on a trial or expired (`billing/billing.service.ts:1162–1164`). It is used by quote, change and settlement's price check (`:307, :400, :1042`).
- `from` is always priced monthly (`:985`).
- Annual cycles are never prorated: `upgradeProrationEligibility` sends any non-standard-monthly cycle to `support_review` (`packages/core/src/billing.ts:231–241`; OWN-34/40). So for an annual subscriber the classification decides only one thing: a scheduled downgrade (`:404–414`) or a support-review request (`:419–440`).
- The database recomputes at `b.billing_interval` (0232:104–107, 197–200).
- The seed catalogue carries explicit annual rows at exactly 10 x monthly (0105:160–174), so today the two always agree.

**Consequences.**

| Scenario                                                                                                                       | A (both at the cycle's interval)                                                                | B (both at monthly)                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approved catalogue (annual = 10 x monthly)                                                                                     | Same answer as B                                                                                | Same answer as A                                                                                                                                 |
| An explicit annual discount on a higher plan, for example monthly ₦11,000 against ₦10,000 but annual ₦95,000 against ₦100,000  | "Downgrade": the richer plan is scheduled at renewal at ₦95,000. The merchant cannot get it now | "Upgrade": support review. The operator keeps the paid-through date (OD-50), even though the merchant paid more than the new plan's annual price |
| A grandfathered v1 with no explicit annual row (computed as 10 x) moving to a v2 plan with an explicit discounted annual price | Compared at what renewal will actually charge                                                   | Compared at monthly figures nobody on this cycle pays                                                                                            |
| Future repricing: annual raised, monthly unchanged                                                                             | Follows the money                                                                               | A "downgrade" can cost more at renewal                                                                                                           |

**Options.**

- **A.** Both at the cycle's interval.
- **B.** Both at monthly.
- **C.** Enforce OWN-40 in the catalogue: an annual row must equal monthly x 10, so the disagreement is impossible until the owner approves annual discounts.

**Implementation.** For A, give `pricingIntervalFor` the cycle's interval for `from` and `to`, change `changePricesKFor` to price `from` at that interval, and update settlement's price check. Under A an annual downgrade is still free and scheduled, so no charge amounts change. For B, change 0232's two functions. For C, add a CHECK or trigger on `plan_prices`.

**Risks.** A disagreement strands the merchant with `support_review_unavailable`. That is truthful but useless to them. There is no financial misstatement in either option, because annual upgrades are never charged automatically.

**Recommendation.** C now, and A as the rule for when annual discounts are approved. That is consistent with "an explicit annual price wins". I agree with the register's A. I add that OWN-40 already makes a ratio-breaking price contrary to policy, so C costs nothing today.

**Release impact.** None under the approved catalogue. It blocks publishing any annual price that is not 10 x monthly.

**Questions.** Should A be the rule? Should the catalogue refuse non-10x annual prices until discounts are approved? Under A, should a plan with more features but a lower annual price be offered as a support review rather than a scheduled downgrade? _Preferred answers:_ yes; yes; owner to decide, with support review as my lean.

---

## Consolidated questions for the owner, with preferred answers

1. **OD-53 (1).** Who may record a refund, and up to what amount? Who holds refund permission in the Paystack dashboard? _Preferred:_ named operators under a new `ops:refund` scope up to an amount the owner sets; the owner above it and for every OD-55 path; Paystack refund permission held by the same people.
2. **OD-53 (1).** Should recorded refunds be corroborated against Paystack by the settlement process? _Preferred:_ yes.
3. **OD-53 (2).** Approve two factual merchant messages (detected, then refunded), with no stated bank timing, on verified email and in-window WhatsApp? _Preferred:_ yes. Write the wording into the PR for approval.
4. **OD-53 (3).** Keep the seven-day prior-month window as documented policy, and align the application mirror? _Preferred:_ yes.
5. **OD-53 (4).** Build the reconciliation before paid launch, in the settlement process, not the worker? _Preferred:_ yes.
6. **OD-53 (4).** Approve a settlement-only, ID-only discovery function over pending, recently retired and paid charges (OWN-57 class)? _Preferred:_ yes.
7. **OD-53 (4).** Should settlement send its own alerts, which needs alert egress? _Preferred:_ yes.
8. **OD-53 (5).** Build the duplicate-payment record, the operator work-list row (a new OWN-85 read) and the record-only refund before paid launch? _Preferred:_ yes.
9. **OD-53 (5).** Apply OWN-29's next-business-day SLA to duplicate payments? _Preferred:_ yes.
10. **OD-54.** Move the six operator writes to the operator process and credential, revoke the app's column grants, and guard operator-source audit rows? _Preferred:_ yes, before paid launch. Accept A for test-mode staging.
11. **OD-54.** Remove settlement's closing UPDATE in favour of a fixed-actor definer? _Preferred:_ yes.
12. **OD-54.** Is the Paystack pre-check at recovery advisory, with verification in the job, as a reading of OWN-76? _Preferred:_ yes.
13. **OD-54.** Do the staging tools stay on the application credential as a staging-only residual? _Preferred:_ yes.
14. **OD-54 and OD-53.** Confirm with Paystack whether Transfers is enabled on Rekoda's account, and record that the API holds a key able to refund. _Preferred:_ confirm, and disable Transfers if possible.
15. **OD-55 (iv).** Build reserve-first (reserve and revoke, refund in Paystack, attach, verify) before paid launch? _Preferred:_ yes.
16. **OD-55 (iv).** Reservation window, and should a verified Paystack refund that was found but not attached be attached automatically? _Preferred:_ 72 hours; no, the operator attaches it.
17. **OD-55 (i)–(iii).** An owner-only record-only refund path, with the amount stated by the owner and all remaining units revoked? _Preferred:_ yes.
18. **OD-55 (ii).** Does OWN-94 (8) govern the ADR 0024 incorrect-charge and service-failure rows for packs? Align `/refunds` accordingly. _Owner to state; no engineering preference._
19. **OD-55 (iii).** Refuse pre-0230 and pre-0235 packs, and rebuild staging? _Preferred:_ yes.
20. **OD-56.** Should the cycle's interval (A) be the single rule in both the application and the database? _Preferred:_ yes.
21. **OD-56.** Should the catalogue refuse annual prices that are not 10 x monthly until discounts are approved? _Preferred:_ yes.
22. **OD-56.** Under A, should a plan with more features but a lower annual price go to support review instead of a scheduled downgrade? _Owner to decide; lean towards support review._

None of these blocks the merge (P12 is the owner's alone) or test-mode staging with Paystack TEST keys. Items 1–3, 5–13 and 15–19 must be ruled, and where ruled to build, built, before paid launch. Item 4 is an engineering default with no release impact. Items 20–22 must be ruled before any annual price other than 10 x monthly is published.
