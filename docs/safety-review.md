# Rekoda — Safety Review & Recommendations

**Version:** 1.0 · 19 August 2026
**Purpose:** one page the owner can review to decide what is safe to build now,
what must be confirmed in writing first, and what must never be built.
**Companion to:** `MASTER-PLAN.md` (the plan) and `adr/` (the decisions).

Everything here is drawn from ADRs 0001–0013 and from verification done against
the delivered M0 bundle and the VoiceReceipt source. Where a claim rests on an
external party's policy, it is marked **UNCONFIRMED** and appears in §2, not §1.

---

# 1. GREEN — safe to build now

No external permission needed. These are decided, verified, and carry no
regulatory or provider dependency.

## 1.1 The financial core (already built and verified)

| # | Recommendation | Status |
|---|---|---|
| G1 | **Double-entry ledger, integer kobo, balanced-or-throw.** No float ever touches money; DB columns `BIGINT`. | ✅ built · 45 tests green · property sweep 200×20 postings |
| G2 | **AI proposes, deterministic code disposes.** LLM returns a `StructuredBusinessCommand`; zod validates; `@rekoda/core` computes every figure. | ✅ built |
| G3 | **No figure in any reply that did not come from the deterministic layer.** Templates receive computed values as parameters. | ✅ rule stated |
| G4 | **Financial records are append-only.** Corrections are reversing postings or credit notes — never an `UPDATE` on an issued document. | ✅ built (`UPDATE/DELETE` revoked at the DB role level) |
| G5 | **Reconciliation refuses to guess.** Two debtors owing the same amount → no match, surfaced instead. | ✅ built |

## 1.2 Tenancy — correct already; do not rewrite

**The RLS implementation in M0 is right.** Transaction-scoped
`set_config('app.business_id', $1, true)`, fail-closed
`nullif(current_setting(...), '')::uuid` policies, `FORCE ROW LEVEL SECURITY` on
all 25 tenant tables, a non-owner app role without BYPASSRLS. Anyone proposing
to "fix" this should be shown the migration first.

What is genuinely missing, and should land in M1:

| # | Recommendation |
|---|---|
| G6 | **Lint-ban raw `db` imports outside `packages/db`** — `withBusiness()` is a guarantee only if it is the *only* path. |
| G7 | **Pooled-connection leakage test as an M1 exit criterion** — two tenants over one reused connection; assert no cross-tenant rows *and* that an unpinned query returns zero rows. This single test proves the whole tenancy design. |
| G8 | **pg-boss jobs run inside `withBusiness`** — background workers are where tenant context is forgotten first. |
| G9 | **Composite indexes** `(business_id, status)` on `invoices`/`payments` for the debtors query and reconciliation queue. |

## 1.3 Money-engine consistency (fix before M2 builds on it)

| # | Recommendation |
|---|---|
| G10 | **`computeMoney` silently clamps overpayment** (`Math.min(paid, total)`) while `applyPayment` refuses it with the exact excess. Two behaviours for one concept, and the clamp *discards a discrepancy* — the opposite of the house rule that mismatches are flagged, never fixed. "Sold for ₦100k, paid ₦150k" must raise an overpayment exception. Align on refuse + flag, with a regression test. |
| G11 | **Unit-carrying names at the parse boundary.** `computeMoney` takes naira and returns kobo but the field names do not say so. Rename to `priceNaira`/`amountPaidNaira`, or move conversion into `packages/contracts` so `core` is kobo-only. |

## 1.4 Durability

| # | Recommendation |
|---|---|
| G12 | **Continuous WAL archiving (pgBackRest → R2/B2).** Nightly dumps give a ledger a 24-hour RPO; this gives minutes, for a few dollars a month. Keep the nightly logical dump as an independent second format. |
| G13 | **`scripts/restore-drill.sh` — restore to a throwaway container, then sweep the per-business ledger-balance invariant.** Monthly and on every release tag. **Must pass before the first paying merchant.** A backup that has not been restore-drilled is not a backup. |
| G14 | **Trial-balance monitoring job** in production alerting on any business whose debits ≠ credits. |
| G15 | **Vault key custody documented**, with a fatal boot check on key fingerprint — a changed `VAULT_KEY` silently orphans the vault. |

## 1.5 Integrate — the parts that need nobody's permission

| # | Recommendation |
|---|---|
| G16 | **Rekoda storefront `/s/{handle}`** as the default order-capture path. No Meta involvement, no verification queue, no approval gate, no CAC. Works day one — and you own the schema instead of parsing Meta's. |
| G17 | **Order forwarding** for merchants already running a WhatsApp Business App catalogue. **Collect real forwarded-order specimens from live vendors before writing the parser** — do not build against a guessed format. |
| G18 | **Chat ships publicly first; Integrate follows.** Chat depends on one WhatsApp number — yours. |
| G24b | **Vendor CAC is a benefit, never a gate.** Rekoda's own CAC carries the platform relationship; the vendor needs **BVN or NIN + a Resolve Account name match**, which is what CBN actually requires and is *better* safety than a registration number — CAC says a business exists on paper, BVN says which human receives the money. Merchants who *do* have CAC unlock Meta verification, a native WABA catalogue, DVAs, and optionally a "Registered business" badge. **The customer is verified by nobody** (R25). |
| G25 | **Build toward Paystack Connect's *platform-managed* flow** (ADR 0013 rev 2). Merchant supplies a bank account only — no CAC, no Paystack signup, no lifetime cap. The *standard* flow (merchant opens their own Starter Business) stays available as a zero-liability preference, but is **not the default**: Starter is capped at **₦2M lifetime collections**, so it fails exactly the merchants who succeed, roughly four months in. Phase by trust — concierge alpha first, self-serve once the R28 controls exist. |

## 1.6 Honest claims — cheap to keep, expensive to lose

| # | Recommendation |
|---|---|
| G19 | **Never say "AI never sees any name."** Say what is true: *identities are tokenised, audio never leaves our infrastructure, AI providers receive minimised pseudonymised context under no-training terms.* |
| G20 | **`RECORDED` vs `VERIFIED` never blurred**, and both presented as *normal*. |
| G21 | **"Needs Attention" contains only genuine mismatches.** A queue that counts every cash sale trains merchants to ignore the badge within a week — and that badge is what sells the top tier. |
| G22 | **Documents are professional commercial invoices, not government-validated e-invoices.** Never claim otherwise. Nigeria's e-invoicing mandate reaches small businesses **1 July 2027**; tell merchants ahead of time. |
| G23 | **VAT defaults OFF.** Charging VAT while unregistered is an offence — enable only on confirmed registration. |
| G24 | **Rekoda never messages a merchant's customers on WhatsApp.** Overdue digests go privately to the merchant. |

---

# 2. AMBER — build only after written confirmation

Each of these is sound *if* an external party confirms it. Ask plainly; do not
infer permission from the fact that an API accepts the call.

| # | Ask whom | Exactly what to ask | What it gates |
|---|---|---|---|
| ~~A1a/b/d~~ | ~~Paystack~~ | ✅ **ANSWERED from documentation, 19 Aug.** PwT carries `split_code`/`subaccount` (channel on the standard charge — the split engine sits above it). Fee is the **local rate 1.5% + ₦100 cap ₦2,000**, *not* the DVA 1%/₦300. The ~1,000 ceiling is **per platform**, attaches to customers not subaccounts, and does not reach transient accounts. |
| **A1c** | **Paystack** | Can a platform **delegate sub-merchant KYC to Paystack while staying on the platform-managed flow** — their rigour *without* the ₦2M Starter cap? | A meaningful simplification if real; no harm if not. |
| **A1e** | **Paystack (empirical)** | Run one live PwT charge with a `split_code` and confirm `charge.success` returns a **populated `split` object, not `{}`**. Assert on a field *inside* `split` — same class as the `plan: {}` truthiness trap. | Closes the last doubt on the platform model. |
| ~~A1b~~ | ~~Paystack~~ | ~~Is aggregation permitted? Who bears chargebacks?~~ | ✅ **ANSWERED from documentation.** Paystack **Connect** is the supported product for sub-merchant aggregation. Liability follows the flow: **standard** = sub-merchant onboards to Paystack, Paystack does KYC, **sub-merchant bears risk**; **platform-managed** = Rekoda onboards, **Rekoda bears risk**. |
| A2 | **Nigerian fintech counsel** | Does split-settled aggregation *without fund custody* sit outside licensable activity — and exactly where is the line? **Include this:** Paystack **acquired Ladder Microfinance Bank in Jan 2026** and runs it as **Paystack Microfinance Bank**, so what Paystack itself may hold has changed since this plan was drafted. | Whether ADR 0013 can be Accepted at all. **The only open question that could still move the architecture.** |
| A3 | **Mono** | Is merchant self-account linking for reconciliation supported under your CBN Open Banking participation? | ADR 0012 rung B0 — the complement that catches money arriving at accounts Rekoda did not issue |
| A4 | **Flutterwave / Monnify** | Confirm the unregistered / sole-proprietor onboarding tier (BVN + NIN, no CAC). | ADR 0012 rung B1 — the escape hatch if A1/A2 fail |
| A5 | **Paystack** | DVA provisioning for a typical *registered* small business; is the ceiling negotiable? | ADR 0009 / rung B2 — upgrade path only, no longer blocking |
| ~~A6~~ | ~~Meta~~ | ✅ **MOOT — rung A2 retired ([ADR 0018](adr/0018-retire-waba-catalogue-capture.md)).** Coexistence does not deliver catalog/order events to the Cloud API app, and Nigeria may be ineligible for Coexistence entirely. If A2 is ever revisited, the **first** test is empirical: push a **+234 number through Embedded Signup** and see whether it throws a country error — eligibility first, webhooks second. |

**Standing rule:** until A1–A4 return, **keep every rung of ADR 0012's ladder
alive.** Ladder B must never have exactly one working rung.

---

# 3. RED — do not build, do not claim, do not assume

These are the ones that end the company rather than cost a sprint.

## 3.1 Regulatory

| # | Never |
|---|---|
| R1 | **Never hold customer funds.** A **PSSP licence (₦100M CBN deposit) does not permit fund custody at all** — only an **MMO (₦2B deposit)** may. The platform model is lawful *precisely because* funds split at Paystack and settle directly to merchant banks. |
| R2 | **Never build escrow, wallets, "hold until delivery", or payout scheduling.** Every one of these parks money and crosses into licensed territory. If someone asks for "just hold it for two days" — that is the line. |
| R3 | **Never claim government e-invoicing validation** (see G22). |
| R4 | **Never charge VAT for an unregistered merchant** (see G23). |

## 3.2 Correctness

| # | Never |
|---|---|
| R5 | **Never let AI produce an authoritative number** — not a total, not a balance, not a report figure. AI phrases sentences around numbers the ledger computed. |
| R6 | **Never mutate a money column on an issued document.** Reversals and credit notes only. |
| R7 | **Never silently absorb a discrepancy** — the overpayment clamp in G10 is exactly this bug. |
| R8 | **Never skip, disable or quarantine a failing test to get green.** |
| R21 | **Never accept a screenshot, image, or forwarded alert as payment evidence.** A forged transfer alert is exactly the input an LLM can be talked into believing. It may open a lookup; it may never move a payment to `VERIFIED`. The refusal is a deterministic template, not an AI sentence. |
| R22 | **Never show `VERIFIED` without a provider-confirmed event**, and never let silence read as verification. Three states always: `VERIFIED` · `RECORDED (not verified)` · `NOT SEEN`. One false green tick destroys the only thing the feature sells. |
| R23 | **Never claim "Rekoda stops fraud."** Say "Rekoda confirms when money has actually arrived in your account." Rekoda cannot see a transfer to an account it does not observe, and the `NOT SEEN` state must be explained on the pricing page, not discovered mid-sale. |
| R24 | **Never expose PII or a bare-sequential lookup on `/verify/{documentNumber}`.** Issuer, number, date, total, validity only — number **plus check token**, rate-limited, merchant-disableable. |
| R25 | **Never take on KYC of a merchant's customers.** Rekoda's KYC boundary is the **sub-merchant**, full stop. Per-customer Dedicated Virtual Accounts require **BVN validation of the end customer** for our business category — so they are out of the retail path. Use **per-transaction** transfer accounts (ADR 0016). Any design that asks a shopper for identity documents is the wrong design. |
| R26 | **Never store a customer's BVN.** There is no Rekoda feature that needs it. If one is ever proposed, it is a licensing and NDPA question before it is a product question. |
| R27 | **Never misdeclare Rekoda's Paystack business category** to escape a stricter compliance rule. Declare honestly and design within whatever applies. |
| R28 | **Never mitigate sub-merchant fraud by withholding settlement.** Escrow, delayed payout, or parking money "pending review" all mean holding customer funds — the licensing line in R1/R2. Under fraud pressure someone **will** propose it. The permitted controls act on limits and visibility only: KYC before activation (BVN/NIN + Resolve Account name match), velocity and ticket limits by trust tier, anomaly alerts, settlement-account change as a re-verification event, and a per-sub-merchant kill switch that stops *future* collections rather than holding existing ones. |

## 3.3 Data

| # | Never |
|---|---|
| R9 | **Never store bank *debit* transactions.** Open banking ingests **credits only, above a threshold**, for reconciliation only. A personal account exposes the merchant's own spending. |
| R10 | **Never bundle training consent into the ToS.** Using corrected transcripts as training data needs explicit, specific, separately-obtained, revocable consent under NDPA — not a pre-ticked box, not a condition of use. Until that flow ships, **retain nothing**. |
| R11 | **Never log a message body, a customer name, or a token→identity mapping.** |
| R12 | **Never rehydrate PII outside the authorised output layer** — not in core, not in jobs, not in logs. |
| R13 | **Never let bank statement data or the customer→NUBAN map reach the AI zone.** Zone 1 only. |

## 3.4 Commercial

| # | Never |
|---|---|
| R14 | **Never compete at ₦2,000–3,000/month.** **Kippa had traction, product-market fit and $8.4M and still died — on monetising small merchants.** Someone well-funded already failed commercially in the adjacent space in this exact market. Price against an accountant's afternoon. |
| R15 | **Never re-price a grandfathered cohort.** Store the plan price on the business row; never read the current price list for an existing subscriber. If COGS rises, **cut the allowance, not the promise**. |
| R16 | **Never interrupt a merchant mid-transaction** for a limit. Soft limits; hard-stop document generation only, between transactions, always naming the upgrade path. |
| R17 | **Never hold a merchant's history behind payment.** Records stay exportable. |

## 3.5 Dependency

| # | Never |
|---|---|
| R18 | **Never let ladder B have one working rung.** All merchants under one Paystack account means one compliance action takes **everyone** down at once — where the merchant-owned-key model failed one merchant at a time. Keep B0/B1 live as an escape hatch, with sub-merchant KYC, per-merchant velocity limits and anomaly alerts. |
| R19 | **Never let a provider's payload shape leak into the reconciliation engine.** Mono was acquired by Flutterwave in Jan 2026 — one group at two rungs. Keep a second aggregator behind `BusinessConnection`. |
| R20 | **Never publish a marketing claim the implementation has not yet earned** — the STT fallback ladder changes the privacy page **in the same release**, not afterwards. |

---

# 4. The five that matter most

If only five things survive this review:

1. **Never hold funds** (R1/R2) — the only item here that is criminal rather than merely expensive.
2. **Launch on Connect's standard flow (G25), not the platform-managed flow.** It carries zero transaction liability for Rekoda and needs no CAC from the merchant. Take on the platform-managed flow — and its risk — only when the ₦2M ceiling or DVA demand forces it, and only after A1 and A2 are answered.
3. **Restore drill passes before the first paying merchant** (G13) — a ledger that cannot be restored is not a ledger.
4. **Pooled-connection leakage test** (G7) — one test that proves tenant isolation end to end.
5. **Don't price at ₦2–3k** (R14) — the failure mode that killed the best-funded predecessor.

---

# 5. Review triggers — diarise these

| When | Do what |
|---|---|
| **1 September 2026** | **Release-gating.** Meta publishes post-October service-message rates → re-run both COGS scenarios and re-confirm the ₦9,900 tier *before* any public pricing page goes live. |
| **1 October 2026** | Meta begins charging for service messages — verify billing matches the model. |
| **Before first paying merchant** | Restore drill passes (G13). |
| **Before M5 starts** | A1–A4 answered. |
| **First 50 paying merchants** | Replace pricing assumptions with `usage_events` telemetry; re-examine allowances against real P50/P95. |
| **1 July 2027** | Nigerian e-invoicing reaches small businesses — plan the compliance release. |
