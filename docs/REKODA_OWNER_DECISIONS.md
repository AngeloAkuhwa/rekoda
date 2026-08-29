# Owner decisions and the external go-live register

> **This file is a SOURCE, not a generated view.** `REKODA_DECISION_REGISTER.md`
> indexes decisions whose authority is the canonical spec or the build plan.
> The rulings here are the owner's own, made in response to what the build
> found, and this is where they live until the spec absorbs them. Where a
> ruling and an older document disagree, the ruling is later and wins; the
> older document is corrected rather than left to be discovered.

Two sections. The first is decisions that have been MADE and are enforced
somewhere in the code, each row naming where. The second is the register of
things that are OPEN, held by somebody outside this repository, with the
question that has to be answered rather than the milestone it blocks.

---

## 1. Decisions made

### 28 August 2026

| ID | Decision | Enforced by |
|---|---|---|
| OWN-1 | A usage unit is either **CONSUMABLE_MONTHLY** (spent, reset monthly, metered through `consumeUnit`) or **CAPACITY** (held, answered by counting what exists). They are not the same thing and blending them produced a real defect | `UNIT_KIND` in `@rekoda/core`; `scripts/check-boundaries.mjs` refuses a capacity unit in a meter call, in tests too (PR-116) |
| OWN-2 | Capacity is sold as a **recurring add-on, never as a one-off pack**. `API_APPLICATIONS` in particular is not a pack | Migration 0112 (`add_on_grants`, `business_add_ons`) and 0113's `usage_packs.unit` CHECK, narrowed to the thirteen consumables (PR-116, PR-117) |
| OWN-3 | `SERVICE_MESSAGE` sells 250 on trial, 5,000 on Integrate and Complete, and **zero on Chat by decision**: a Chat merchant talks to their customers from their own phone | Migration 0113; `PLAN_ALLOWANCES` in core as the rollback path (PR-117) |
| OWN-4 | `REPORT_EXPORTS` sells 10 / 50 / 100 / 200. This **supersedes ADR 0024's "report generation is not capped"** in that clause only | Migration 0113; ADR 0024 carries the scoped supersession note (PR-117) |
| OWN-5 | **Data portability is never metered, on any plan, including expired.** "expired allowance = 0 quietly contradicts the retention/portability policy" | `GET /v1/reports/portability.json`, migration 0114, and a test that proves it works for the business every other export refuses (PR-118) |
| OWN-6 | The API is a product: **Developer API Starter ₦25,000/month** (entitlement + 1 application + 25,000 requests + 25,000 deliveries), `api_application_extra` ₦5,000/month of recurring capacity, and one-off packs of 25,000 requests (₦10,000) and 25,000 deliveries (₦5,000) | Migration 0113 (PR-117) |
| OWN-7 | Provider readiness is **TechnicalSupport, CommercialApproval and ComplianceApproval, modelled independently**, with ProductionEnabled derived and everything defaulting closed. **"Do not let 'sandbox works' turn that boolean on."** | Migration 0115: three axes plus a GENERATED `production_enabled`, which no UPDATE can shortcut (PR-119) |
| OWN-8 | Kuda's restriction is stronger than the others: third-party Accept Payments processing requires PSP or MMO licensing, so **ComplianceApproval is false/unknown** until Rekoda has an approved arrangement | Migration 0115 seeds Kuda with two closed axes, commercial and compliance (PR-119) |
| OWN-9 | Mono and OPay stay production-disabled until live credentials, contract, webhook and signature validation and commercial terms are confirmed, with **TechnicalSupport true**: the adapters are real | Migration 0115 (PR-119) |
| OWN-10 | The R0A-i report runs in a **REPEATABLE READ, READ ONLY** transaction, carries a header identifying when, where and which classifier produced it, and is fingerprinted by SHA-256 | `run-r0a-i.sh`, the classifier's own transaction wrapper, migration 0116 (PR-120) |
| OWN-11 | **Remediation may never rewrite `LEGACY_PROVENANCE_UNKNOWN` into a provenance Rekoda did not historically know.** It appends later evidence with its own date and actor; what cannot be established stays unknown | `docs/runbooks/r0a-provenance.md`; the grade itself, which R0A-ii may not overwrite (PR-120) |
| OWN-12 | Approval names the approver by **immutable internal operator UUID**, not a display name or an email address, and records the report and classifier hashes | Migration 0116: `approved_by_user_id`, `source_report_sha256`, `classifier_sha256`, and a CHECK making a half-recorded approval unrepresentable (PR-120) |
| OWN-13 | The production report **does not go in Git**, and its rows are never pasted into a reasoning model. Customer names, phone numbers, bank account numbers, full narration, addresses and emails are tokenised or stripped before any of it is quoted | The runbook, the wrapper's own header, and `.gitignore` (PR-120) |
| OWN-14 | The R0A-i gate blocks **PR-006 through PR-009 and PR-115 only**. It is not a reason to stop other work | Build plan §2 and §7; every other lane proceeded (PR-116 to PR-121) |

### Earlier

| ID | Decision | Recorded in |
|---|---|---|
| OWN-0a | The eight rulings of 26 August 2026 (products collapsed, the plan table corrected, and the rest) | Build plan amendment 1.11 |
| OWN-0b | The commercial terms of 21 August 2026 | ADR 0024 |

---

## 2. The external go-live register

Nothing here is engineering work. Each row is held by somebody outside this
repository, and each carries the QUESTION rather than a status, because a
register of statuses tells you nothing about what to do next.

Two of these are more visible than the others, and that is exactly why the
quiet ones are on the same list: tax and accounting sign-off must not vanish
because Meta and Paystack are louder.

### W0 · Meta

Three permissions, tracked separately **because each is needed for a
different reason**. Meta's Embedded Signup materials recommend starting
before the implementation is finished, so this is a calendar gate, not a
code gate.

| Permission | Why Rekoda needs it | State |
|---|---|---|
| `business_management` | App Review and Advanced Access are required to RELEASE Embedded Signup | OPEN |
| `whatsapp_business_management` | the same release requirement | OPEN |
| `whatsapp_business_messaging` | actually sending Cloud API messages, which the other two do not cover | OPEN |

**The billing mode is a separate and material decision, and the default is
not obvious.** Embedded Signup lets a Tech Provider share its line of credit
with a client's WABA: the businesses pay the provider, and the provider
receives Meta's aggregated invoice. The policy, in order:

1. Ask Meta which billing modes Rekoda can use for this Tech Provider setup.
2. **Prefer merchant-direct billing** if Meta supports it cleanly for the
   intended onboarding model.
3. If Meta requires or allows Rekoda credit-line billing, **do not enable it
   commercially** until Rekoda has usage metering, merchant billing
   recovery, spending ceilings, suspension rules, credit-risk controls and
   working-capital modelling.

Without those, Rekoda could be funding thousands of merchants' WhatsApp
bills before collecting a naira of it.

### P · Paystack

The technical capability is real: Paystack supports subaccounts, split
settlement, and attaching a subaccount or split to a Dedicated Virtual
Account. But DVA availability is limited to registered businesses in
Nigeria and Ghana that have completed go-live, which is potentially material
for Rekoda's target merchants.

**Get the written answers before switching the production path.** Twelve
questions, and they are written down here so that a partial answer is
visibly partial:

1. Can Rekoda represent or onboard many merchants under one platform relationship?
2. What is the exact KYC required for each merchant or subaccount?
3. Can business-name and sole-proprietor merchants participate?
4. What happens to informal merchants without the required registration?
5. Can Pay with Transfer and DVA operate with those merchant subaccounts?
6. Does settlement go directly to each merchant's bank?
7. Can Rekoda avoid custody or holding of merchant funds?
8. Who may bear transaction fees?
9. Can Rekoda take a separately disclosed platform or service fee?
10. Does this model classify Rekoda as a marketplace, aggregator, payment
    intermediary or another regulated category in Paystack's view?
11. What volume, risk or reserve limits apply?
12. What must Rekoda complete before live keys and production activation?

**Until those answers arrive, the existing merchant-key path stays disabled
or fallback.**

### L · Legal and corporate facts

Task #40. These come from the actual corporate records and are never
invented; the pages are built and waiting for the values.

| Field | State |
|---|---|
| legal entity name | OPEN |
| CAC / RC registration number | OPEN |
| registered or business address | OPEN |
| general support / contact email | OPEN |
| privacy / data-protection contact email | OPEN |
| customer-facing contact phone or support channel | OPEN |

Where task #40's own schema names these fields differently, its schema wins.

### T · Tax, fiscalisation and accounting sign-off

On the register deliberately. Neither blocks engineering, and neither may
quietly disappear because the two rows above are more visible.

| Item | Question | State |
|---|---|---|
| Tax and fiscalisation | What Nigerian tax and fiscalisation obligations attach to Rekoda's own invoicing, and to the invoices Rekoda generates on merchants' behalf | OPEN |
| Finance and accounting sign-off | A qualified review of the statements Rekoda produces and of Rekoda's own books before merchants rely on either | OPEN |

### R · The R0A-i report

| Item | Question | State |
|---|---|---|
| Provenance report | Run, reviewed, reconciled, remediation population understood, and explicitly approved, per `docs/runbooks/r0a-provenance.md` | **OPEN — blocks PR-006 to PR-009 and PR-115, and nothing else** |
