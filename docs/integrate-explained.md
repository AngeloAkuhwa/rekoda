# Rekoda Integrate — end to end, from the vendor's side

**Version:** 1.0 · 19 August 2026
**Who this is for:** the owner, anyone joining the team, and the 5–10 concierge
merchants of M5. It explains what a vendor actually does, what Rekoda does, how
money moves, and how Rekoda earns.
**Decisions behind it:** ADRs [0012](adr/0012-integrate-without-cac.md) ·
[0013](adr/0013-rekoda-as-the-single-integration.md) ·
[0014](adr/0014-payment-verification-anti-fake-alert.md) ·
[0015](adr/0015-full-books.md)

---

## 0. The one-paragraph version

Ada sells clothes on WhatsApp. She gives Rekoda **her phone number and her bank
account number** — nothing else, no CAC, no Paystack signup, no paperwork. Rekoda
puts her catalogue on a link she shares in WhatsApp. When Jennifer orders, Rekoda
raises the invoice automatically and gives her **a temporary account number for
that order**, and the second the money lands Rekoda tells Ada **"verified"** and
issues the receipt. **Jennifer supplies nothing but a name, a phone number and a
delivery note — no BVN, no ID, no signup** (ADR 0016). The money settles into Ada's own bank
account. Ada never touched a pen. Rekoda earns from her **monthly
subscription** — not from her sales.

---

## 1. What Ada needs before she starts

| She needs | She does **not** need |
|---|---|
| A phone number with WhatsApp | CAC registration |
| A bank account in her name | A Paystack account |
| Her products (photos + prices) | A website, an app, or a card machine |
| ~15 minutes | Any accounting knowledge |

That list is the whole design constraint. Every step below exists to keep the
left column that short.

---

## 2. Onboarding — the seven steps

### Step 1 · She taps "Connect my WhatsApp Shop"
From `rekoda.app/integrate`, or a `wa.me` link, or a Rekoda person sitting with
her during the alpha.

### Step 2 · Phone verification — ~30 seconds
She enters her WhatsApp number. Rekoda sends a code **from Rekoda's own WhatsApp
number** (~₦10, not an ₦80 SMS OTP). She taps it back. Done. **No password, ever.**

### Step 3 · Business identity — ~30 seconds
> *What should Rekoda call your business?* → **Ada Fashion**
> *What kind of business?* → **Fashion & clothing**

That is enough to create the tenant: `Business`, `BusinessOwner`,
`VerifiedPhone`, `BusinessMembership`, `BusinessSettings`. **CAC/TIN is captured
only if she offers it, and never blocks her.**

### Step 4 · Her bank account — the important one
She types her account number and picks her bank. Rekoda calls Paystack's
**Resolve Account**, reads back *"Adaeze Nwosu — GTBank"*, and she confirms it is
her.

Behind the scenes this creates her **subaccount**. This is the whole reason she
needs no CAC and no Paystack signup: **Rekoda holds the Paystack relationship;
Ada is a sub-merchant underneath it** (ADR 0013).

> **Money never touches Rekoda.** Payments split at Paystack and settle to Ada's
> own bank account. Rekoda is not allowed to hold her money and is not built to —
> that is a licensing line we do not cross (safety-review R1/R2).

### Step 5 · Her catalogue — three doors, she takes whichever fits
| Her situation | What happens | What she does |
|---|---|---|
| **No catalogue yet** *(most vendors)* | Rekoda hosts her shop at **`rekoda.app/s/adafashion`** | Sends photos + prices. **In the alpha, the Rekoda team loads them for her.** |
| **Already has a WhatsApp Business catalogue** | She keeps it, and **forwards order messages** to Rekoda | One forward per order |
| **Has CAC + Meta verification** | Native WABA catalogue — orders arrive automatically (**§6b**) | Nothing, after setup |

**Door 1 is the default**, and it is better for Rekoda too: no Meta approval
queue, no display-name review, no waiting. It works the same afternoon.

### Step 6 · Payment details — automatic
Nothing for Ada to do. For each order, Rekoda generates a **temporary bank
account number for that transaction** under its own Paystack registration,
splitting proceeds to Ada's subaccount.

> **Why per-transaction and not per-customer** (ADR 0016): a *dedicated* account
> is tied to a person, and for our business category Paystack requires **BVN
> validation of that person** before issuing one. Jennifer is not going to
> validate a BVN to buy a gown, and Rekoda has no business holding her BVN.
> A per-transaction account needs none of that — **and attributes better**,
> because it can tell two orders from the same customer apart.

### Step 7 · Activate
```
WhatsApp shop link   ✓
Bank account         ✓
Payments             ✓

Rekoda Integrate Active
```
She gets her link and a WhatsApp message: *"Ada Fashion is live. Share your shop
link and I'll handle the rest."*

---

## 3. What the Rekoda team actually does in the alpha

M5 is a **concierge alpha — 5–10 merchants, hand-held** (MASTER-PLAN §5.6). Not
because self-serve is impossible, but because the first ten teach us where the
funnel breaks. Concretely, a Rekoda person:

1. **Sits with her** (or a video call) for the 15-minute setup.
2. **Loads her catalogue** — takes or cleans up the product photos, sets prices,
   writes the descriptions. This is the step vendors most often stall on.
3. **Runs one fake order end to end** in front of her — a ₦100 test — so she sees
   the invoice, the account number, the verification and the receipt happen.
4. **Watches her first three real sales** in admin and calls her if anything
   looks wrong before she notices.
5. **Sets up her accountant's access** if she has one.

Then we productise whatever we had to do by hand.

---

## 4. A real sale — Jennifer buys from Ada

### The customer's experience
```
Jennifer opens Ada's link         rekoda.app/s/adafashion
   ↓
Picks 2 Black Gowns + 1 Handbag   ₦105,000
   ↓
Enters name, phone, delivery note
   ↓
Sees: "Transfer ₦105,000 to
       Wema Bank 7042318856
       — for this order, expires in 2 hours"
   ↓
Transfers from her own bank app
```
Jennifer never installs anything, never creates an account, and never learns
Rekoda exists. **The shop is Ada's — Ada's name, Ada's logo.**

### What Rekoda does, in order
| # | Event | Rekoda's action |
|---|---|---|
| 1 | Order submitted | `OrderPlaced` → creates Order, **Invoice INV-2026-000318**, receivable, inventory reservation, audit event |
| 2 | Customer needs to pay | Generates a **temporary account number for this invoice**, split → Ada's subaccount. No customer KYC, no BVN, nothing stored about Jennifer beyond what she typed |
| 3 | Jennifer transfers | Paystack fires `charge.success`, `channel: "dedicated_nuban"` |
| 4 | Webhook arrives | Signature → idempotency → tenant → `PaymentConfirmed` |
| 5 | Matching | **Attribution is free** — the account the money arrived into *is* this invoice. No guessing between two customers who owe ₦105,000, and no confusion between two orders from Jennifer herself |
| 6 | Reconciliation | Expected ₦105,000 = received ₦105,000 → **MATCHED** |
| 7 | Posting | Invoice → PAID · **Receipt issued** · receivable → ₦0 · stock −3 · balanced ledger entries · audit |
| 8 | Ada is told | *"✅ ₦105,000 received — verified. Jennifer, 12:41. Receipt RCP-2026-000201 sent."* |

**Elapsed: seconds.** Ada did nothing.

### Two things I want you to notice

**The fake-alert problem disappears here.** Ada is not looking at a screenshot
Jennifer sent her. She is looking at Rekoda saying the money *actually landed*.
If Jennifer sends a forged alert and no money moved, Rekoda says **"not seen"**
and Ada holds the goods (ADR 0014).

**Verification and settlement are different things, and we say so.** Rekoda
confirms the money arrived **in seconds**. Paystack then settles it to Ada's bank
on its normal schedule (typically next business day). Ada must understand both
timings from day one — *"confirmed now, in your bank tomorrow"* — or she will
think something is broken.

---

## 5. Invoices and receipts without touching a pen

Both are generated from **stored transaction data**, never typed and never
written by AI:

| Document | Trigger | Contains |
|---|---|---|
| **Invoice** | Order placed | Sequential number, Ada's branding, items, total, due terms |
| **Receipt** | Payment **verified** | Sequential number, amount actually received, balance if partial |
| **Financial snapshot** | Asked for, or monthly | Sales, received, expenses, outstanding, unreconciled |

Each carries a sequential number, an immutable snapshot and a **SHA-256 hash**,
and can be checked by anyone at `rekoda.app/verify/{number}` — which is how a
*Rekoda* receipt is provably not a forged one (ADR 0014).

**A receipt is only ever issued for a real, verified payment.** Never for an
invoice someone marked paid. That rule is what makes the receipts worth
anything.

Partial payment behaves honestly: ₦60,000 against a ₦105,000 order →
invoice `PARTIALLY_PAID`, receipt for ₦60,000, receivable ₦45,000, reconciliation
`PARTIAL_MATCH`. **Never silently closed.**

---

## 6. Her dashboard — the QuickBooks comparison

She asks Rekoda *"send my dashboard"* and gets a **one-time magic link**. No
password, no app. It opens a session and the link dies.

| | QuickBooks | Rekoda |
|---|---|---|
| Where work happens | In the app, at a desk | **In WhatsApp**, wherever she is |
| Data entry | She types it | It arrives from orders and payments |
| Login | Email + password | Magic link from her WhatsApp |
| Books | Full accounting | **Full accounting** — see below |
| Learning curve | Weeks | None |

**She gets real books** (ADR 0015), not just a sales list:

* **Trial balance** — the proof the ledger is sound
* **Profit & loss** — *am I making money?*
* **Balance sheet** — what a lender or an investor asks for
* **Cash flow** — what she actually feels
* Plus transactions, invoices, receipts, payments, expenses, customers,
  products & inventory, and the **Reconciliation** queue

The lens matters: **her default view is cash basis** — money actually received —
because a vendor who sold ₦500,000 on credit has not "made ₦500,000" in any sense
she recognises. Her **accountant** can flip to accrual. Same ledger, two lenses,
plain-English labels.

Her accountant gets **their own delegated magic link** — read + export, never
settings, never deletions — and Excel exports of everything. That accountant is
also a growth channel: one accountant typically brings 10–30 merchants.

---

## 6b. The WABA upgrade — for merchants who have CAC (ADR 0012 rung A2)

**This is the upgrade, not the mainline.** Everything above works with no Meta
involvement at all. This section is what a *registered* merchant gets if she
wants orders to originate inside WhatsApp's own catalogue UI rather than a
Rekoda link.

### What she must clear first — four external gates
| Gate | Who decides | Needs CAC? |
|---|---|---|
| Meta business verification | Meta | **Yes** — a utility bill alone is not accepted |
| Display-name review | Meta | Follows verification |
| Catalogue approval | Meta Commerce Manager | — |
| Payment setup | Paystack | Already done in Step 4 |

Until verification passes she is capped at **250 unique customers / 24 hrs** on
**two numbers**, and her **business name is not visible** — customers see a phone
number. Unverified accounts also face deactivation after roughly 30 days. That
is why this is an upgrade for the registered, not a path for everyone.

### How the catalogue actually connects — the wiring

**First, the thing that makes this survivable: Coexistence.**

Historically, porting a number to the WhatsApp Business API **disconnected it
from the WhatsApp Business App** — the vendor lost the app interface, and in
many cases chat history and groups with it. For a market vendor who runs her
entire business inside that app, that is not a migration, it is a demolition.

**Meta's Coexistence feature (rolled out May 2025) removes that cost.** One
number runs on the **Business App and the Cloud API simultaneously**: existing
chats stay in the app, contacts are preserved, and new messages **mirror both
ways in real time** over webhooks. Activation runs through Embedded Signup and
needs nothing technical from the vendor.

> **Rekoda's A2 path must use Coexistence, never a straight migration.** Ada
> keeps chatting to her customers in the app she already knows; Rekoda gets API
> visibility alongside her. If a future implementation quietly migrates a number
> instead, it has taken her business away to gain a webhook.

**Her catalogue already lives in Meta.** The WhatsApp Business App catalogue is
backed by a **Commerce Manager** product catalog under her Meta Business
Portfolio. She is not creating anything new — Rekoda is being granted access to
what exists.

### The connection, step by step

| # | Where | What happens |
|---|---|---|
| 1 | Rekoda | She taps **"Connect WhatsApp"** → launches **Embedded Signup**, a Meta-hosted popup |
| 2 | Meta popup | She logs in with the Facebook account that owns her WhatsApp Business |
| 3 | Meta popup | For an existing Business App number, Meta offers **Coexistence** — she confirms in the app |
| 4 | Meta popup | She grants scopes: `whatsapp_business_management`, `whatsapp_business_messaging`, and catalogue access |
| 5 | Popup → Rekoda | Returns **WABA ID**, **business phone number ID**, and an **exchangeable token code** |
| 6 | Rekoda server | Exchanges the code for a **customer-scoped business token**; stores it **encrypted, per-WABA** |
| 7 | Rekoda server | Calls **`debug_token`** to confirm the granted scopes and exactly which WABA `target_ids` the token covers — never assume the popup granted what was asked |
| 8 | Rekoda server | **Registers her phone number** for Cloud API use |
| 9 | Rekoda server | **Subscribes Rekoda's app to webhooks on her WABA** — ⭐ *this is the step that makes Rekoda able to see anything* |
| 10 | Rekoda server | Reads her **Commerce Manager catalog** via the Graph API and maps every product |

### Product mapping — the join that makes orders legible

```
RekodaProductId  ↔  product_retailer_id      (her SKU inside Meta's catalog)
                    catalog_id               (which catalogue it came from)
```

Without this mapping an incoming order is a list of opaque IDs. With it, an
order resolves to real products with Rekoda's own prices and stock.

### Then tracking is automatic

```
Customer browses her catalogue inside WhatsApp
        ↓  adds to cart, sends the order
Meta posts an `order` webhook to Rekoda's subscribed endpoint
        ↓
order { catalog_id, product_items[{ product_retailer_id, quantity, item_price }] }
        ↓
Rekoda resolves each product_retailer_id → its own product
Rekoda RECOMPUTES the totals itself (never trusts item_price off the wire)
        ↓
OrderPlaced → identical to §4 from here
```

**Rekoda connects to Meta Cloud API directly — Twilio is optional** (ADR 0017;
Twilio's ~₦7.25/message surcharge is ~29% of the Integrate plan).

### Two consequences worth planning for

**Cost:** from 1 Oct 2026 every message **sent through the API** is charged.
Messages Ada sends **from the app herself are not**. So under Coexistence, Rekoda
should let her converse in the app and reserve API sends for what only Rekoda can
do — confirmations, documents, verified-payment alerts (ADR 0011).

**Unconfirmed:** whether catalogue **order** webhooks reach the API app while a
number is in Coexistence mode. Message mirroring is documented; *order* messages
specifically are not confirmed in what could be read from here, and
`developers.facebook.com` is egress-blocked in this environment. **Verify before
building A2** — if orders do not flow under Coexistence, the choice becomes
"migrate and lose the app" versus "stay on the storefront", and the storefront
wins that argument every time.

### Catalogue mapping
Her products live in **Meta Commerce Manager**. Rekoda maps them both ways:

```
RekodaProductId  ↔  product_retailer_id   (her SKU in Meta's catalogue)
```

Price and stock changes flow from Rekoda outward, so the ledger and the shopfront
never disagree.

### The order arrives
A customer browses her catalogue in WhatsApp, adds to cart, and sends the order.
Meta delivers a webhook containing an `order` object:

```
order
├── catalog_id
└── product_items[]
    ├── product_retailer_id   → mapped to RekodaProductId
    ├── quantity
    └── item_price
```

Rekoda resolves each `product_retailer_id` to its own product, **recomputes the
totals itself** (never trusting `item_price` from the wire), and from there the
path is **identical to §4** — `OrderPlaced` → invoice → per-transaction transfer
account → verified payment → receipt → stock → ledger.

**One pipeline, two doors.** The catalogue is just another way an order enters.

## 7. How Rekoda makes money

**Subscription only, at V1.**

| Plan | Price | For |
|---|---|---|
| Rekoda Chat | ₦9,900/mo | Talks to Rekoda; no catalogue |
| **Rekoda Integrate** | **₦19,900/mo** | **Ada — WhatsApp shop, automatic capture** |
| Rekoda Complete | ₦29,900/mo | Shop **and** cash/offline sales in one set of books |
| Add-ons | ₦1,500–₦5,000 | Extra messages, voice, documents, orders, delegates |

**Rekoda does not take a cut of Ada's sales, and Paystack's fees are hers, shown
transparently.** Paystack's per-customer-account charge (1%, capped ₦300) is
configured with `bearer_type` so it sits with the sub-merchant, exactly as
MASTER-PLAN Part 8 requires.

**Why no transaction rake, even though Connect makes it easy?** Three reasons,
and I would hold this line at V1:

1. **It muddies the trust story.** *"Your money goes straight to your bank, we
   never touch it"* is the strongest sentence in the pitch. A rake invites the
   question *"so you do touch it?"*
2. **It invites the licensing question** we have deliberately engineered around
   (safety-review R1/R2).
3. **This market is far more sensitive to a per-sale cut than to a flat monthly
   fee.** A vendor doing ₦2M/month reads 0.5% as ₦10,000 — and resents it in a
   way she does not resent ₦19,900.

It stays available as a later lever once the subscription model is proven.

**What Ada is really buying at ₦19,900:** not invoices. She is buying *never
being fake-alerted again*, *never re-typing an order*, and *books she can take to
a bank*. One prevented fake alert on a ₦50,000 sale pays for two and a half
months.

---

## 8. What Rekoda honestly does not do for her

Being straight about this is what stops churn in month two:

* **Cash sales are not automatic.** A walk-in paying cash is invisible to any
  system. She tells Rekoda by voice note — *"sold one gown for ₦45k cash"* — and
  that is **Rekoda Chat**, which is why **Complete** exists.
* **Payments to her personal account are not verified.** If a customer transfers
  straight to her GTBank number instead of the Rekoda-issued one, Rekoda cannot
  see it until she links that account (open banking), and even then it is minutes,
  not seconds — fine for books, **not** for the counter.
* **The order's account number expires.** It is issued for that order and lapses
  after a few hours. If the customer pays late, the invoice stays open and Ada
  taps once for a fresh number — an expired number never means a cancelled
  order.
* **Products must be loaded once.** The team does it in the alpha; after that it
  is her job.
* **Rekoda does not file her taxes.** These are management accounts. Nigeria's
  e-invoicing mandate reaches small businesses **1 July 2027** and we will tell
  merchants before it does.
* **Rekoda never messages her customers on WhatsApp.** Overdue digests go to
  *her*, privately.

---

## 9. The whole thing in one picture

```
ADA (once, ~15 min)                   JENNIFER (every order)
  phone → OTP                           opens rekoda.app/s/adafashion
  business name                         picks items → ₦105,000
  bank account ──┐                      gets an account number FOR THIS ORDER
  products       │                      transfers from her bank app
                 │                              │
                 ▼                              ▼
        Paystack subaccount        Temporary txn account (split → Ada)
                 └──────────────┬───────────────┘
                                ▼
                     charge.success webhook
                                ▼
              signature → idempotency → tenant → PaymentConfirmed
                                ▼
                    RECONCILIATION → MATCHED
                                ▼
     Invoice PAID · Receipt issued · Stock −3 · Ledger balanced · Audit
                                ▼
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  "✅ ₦105,000            Dashboard              P&L · Balance sheet
   verified"              (magic link)           Cash flow · Excel
        │                       │                       │
        ▼                       ▼                       ▼
      ADA                     ADA                  HER ACCOUNTANT

  Money settles to ADA'S OWN BANK. Rekoda earns ₦19,900/month.
```

---

# 10. What we know, and how we know it — the confidence register

This section exists so a future session (or a future you) never mistakes an
inference for a fact. Everything above is one of four things. **Read the fourth
category before committing engineering time.**

## 10.1 Verified — I ran it or read the primary artefact

| Claim | How |
|---|---|
| M0 is real: 45 tests pass (39 core + 6 contracts) | Cloned the bundle, `pnpm install && pnpm test` |
| Typecheck, lint, and `pnpm demo:m0` are green; trial balance ₦160,000 = ₦160,000 | Ran them |
| RLS is already correct — transaction-scoped `set_config(…, true)`, fail-closed `nullif(…)`, `FORCE RLS` on 25 tables, non-owner role | Read `packages/db/migrations/0001_rls.sql` and `src/client.ts` line by line |
| `computeMoney` silently clamps overpayment while `applyPayment` refuses it | Read `packages/core/src/money.ts:118` |
| VoiceReceipt is real: **118 tests pass**, ~10,500 LOC, 15 service modules | Extracted the zip, `npm install`, ran the suite |
| The gitleaks CI failure was a root-commit range bug, not a secret | Read the job log; reproduced locally with gitleaks 8.24.3 and the exact CI command |
| 21st.dev connector works and returns installable shadcn components | Called it |
| `ui-ux-pro-max` ships only `SKILL.md` to remote sessions — no search data | Listed the skill directory |
| paystack.com, support.paystack.com, developers.facebook.com are egress-blocked | `curl` → `CONNECT tunnel failed, response 403`; github hosts return 200 |

## 10.2 Documented — from vendor documentation, read via search, not the primary page

**This is the important caveat: the two domains that matter most — `paystack.com`
and `developers.facebook.com` — are blocked by this environment's egress policy.**
Everything below comes from search results quoting those docs, from Paystack's
public GitHub docs repo, or from BSP/partner documentation. It is good evidence,
but it is **second-hand**, and the exact wording should be re-checked against the
primary pages when browsing is available.

| Claim | Confidence |
|---|---|
| Paystack **Connect** exists for platforms onboarding sub-merchants | High — consistent across sources |
| Two flows: **standard** (sub-merchant onboards to Paystack, Paystack does KYC, sub-merchant bears risk) vs **platform-managed** (platform onboards, platform bears risk, needs only bank details) | High |
| A sub-merchant needs **no Paystack account**; onboarding needs a bank account validated via **Resolve Account** | High |
| **Multi-split has no maximum subaccount count**; `bearer_type` sets who pays Paystack's fee | High |
| **Starter Business**: ID + BVN + personal bank account, **no CAC**; **₦2M lifetime cap** (₦3M with Truecaller); **no Transfers**, so no DVAs | High |
| **DVA requires a customer record**, and **BVN validation** for Betting / Financial services / General services categories; validated name is used to name the account | High — this is what killed per-customer DVAs |
| **Pay with Transfer** generates **randomised, temporary** accounts tied to the transaction, `account_expires_at` 15 min–8 hrs, enabled by default in Nigeria | High |
| DVA fee 1% capped ₦300; ~1,000 accounts per business; registered businesses only | High |
| **Meta**: Embedded Signup is the default path since April 2026; Tech Providers onboard and **directly manage client WABAs**; enrolment mandatory for ISVs | High |
| **Meta**: unverified business = **250 unique customers/24h**, 2 numbers, **display name not visible** | High |
| **Meta**: service messages become chargeable **1 Oct 2026** at the utility rate, flat, no volume discount; Nigeria utility ≈ $0.0067 | High |
| Order webhook shape: `order { catalog_id, product_items[{ product_retailer_id, quantity, item_price }] }` | Medium-high — consistent across three BSP docs |
| **Embedded Signup returns WABA ID + phone number ID + exchangeable code**; server then exchanges for a customer-scoped token, registers the number, and **subscribes the app to that WABA's webhooks** | High |
| **Coexistence** (Meta, since May 2025) runs the Business App and Cloud API on **one number**, preserving chats and contacts, mirroring messages both ways, activated via Embedded Signup | High |
| Without Coexistence, porting a number to the API **disconnects the WhatsApp Business App** | High |
| **Meta may deactivate unverified WABAs after ~30 days** | **Low-medium — weakest claim in the plan.** Sourced from BSP help pages, never from Meta directly. Flagged as unconfirmed in ADR 0012. |
| CBN requires **BVN or NIN** for virtual accounts (not CAC) | High |
| **PSSP** = ₦100M CBN deposit and **does not permit holding customer funds**; only **MMO** (₦2B) may | High — multiple legal sources |
| Intuit Payments Inc. is a **licensed money transmitter** and underwrites merchants, never payors; Xero integrates Stripe/GoCardless rather than processing | High |

## 10.3 Designed — my architecture and reasoning, not anyone's documentation

These are **judgements**, and they are the parts most worth arguing with:

* The **two-ladder structure** (capture / collection) and the storefront as default.
* **Platform-managed as the destination** rather than the standard flow — reasoned from the ₦2M cap plus the transfer-vs-card risk argument.
* **Per-transaction accounts over per-customer DVAs** — follows from the documented BVN requirement, but the *conclusion* is mine.
* The **fake-alert product design**: push-first, three states, screenshot refusal, `/verify/{doc}` with a check token.
* **Cash-basis default over an accrual ledger.**
* All **cost arithmetic** — the ₦5,800/merchant Twilio figure, the 29% share, the 39–60% margin band. The *rates* are documented; the *multiplications and the allowance assumptions* are mine.
* The **KYC-boundary rule** ("Rekoda's boundary is the sub-merchant"). Intuit's practice corroborates it; the rule is my formulation.

**One designed claim deserves singling out as under-evidenced:** I asserted that
**Nigerian NIP transfers are effectively irreversible**, and used it to argue that
platform-managed chargeback risk is small. That is widely believed and consistent
with how transfers work, but **I did not verify it against a CBN or bank source.**
It is load-bearing for the risk argument in ADR 0013 rev 2. **Verify it before
relying on it.**

## 10.4 RESOLVED 19 Aug 2026 — owner ran these down against primary sources

The owner checked each open question against Meta's and Paystack's own
documentation. **Three came back clean, one flipped an architecture decision, and
one claim of mine was unsupported.** Recorded here because the reasoning matters
more than the verdicts.

| # | Question | Verdict |
|---|---|---|
| **1** | Do per-transaction transfer accounts carry `subaccount`/`split_code`? | **✅ YES.** PwT is a **channel on the standard charge**, not a separate product. `split_code`, `subaccount`, `transaction_charge`, `bearer` are top-level params on **Create Charge**, siblings of `bank_transfer`; `bank_transfer` is likewise a value in `channels[]` on Initialize Transaction. **The split engine sits above the channel** — funds settle straight to each subaccount. **The platform model holds.** *Still owed one empirical check — see below.* |
| **2** | PwT fee rate | **❌ Local rate: 1.5% + ₦100**, capped ₦2,000, ₦100 waived under ₦2,500. The **1%/₦300** column is **DVA-specific**; a PwT temporary account is not a DVA. On a ₦105,000 order: **₦1,675 vs ₦300**. That gap is the price of not asking her customer for a BVN. |
| **3** | Rekoda's Paystack business category / BVN rule | Already designed for the strict case; a softer answer only relaxes things. |
| **4** | Delegate sub-merchant KYC to Paystack on the platform flow? | Still open — a simplification if yes, no harm if no. |
| **5** | Does the ~1,000 ceiling touch transient accounts? | **Settled, and against DVAs.** The limit is **per platform** — 1,000 across *all* merchants' customers, raisable only by emailing support. Accounts attach to **customers**, not subaccounts, so **subaccounts do not each carry a pool** and "DVA per vendor" does not escape it. DVAs also require a registered business in NG/GH that has completed go-live. Transient accounts are not assigned, so the ceiling does not reach them. |
| **6** | Counsel on split-settled aggregation | Still open — gates ADR 0013 → Accepted. |
| **7** | Meta unverified-WABA deactivation | **❌ MY CLAIM WAS UNSUPPORTED — retired.** See ADR 0012. Meta's messaging-limits doc does not gate scaling on verification; Vonage states there is **no time limit to the unverified stage**. The "30 days" traces to BSP help centres with no Meta citation. |
| **8** | Do catalogue `order` webhooks reach the API app under Coexistence? | **❌ NO — and Nigeria may be ineligible for Coexistence at all.** Meta's own feature table marks business tools (catalog, orders, status) **Not supported** on the Cloud API side post-onboarding. **A2 is retired — [ADR 0018](adr/0018-retire-waba-catalogue-capture.md).** |

### The one check still owed on question 1

Run a **live PwT transaction with a `split_code`** and confirm `charge.success`
returns a **populated `split` object, not `{}`**. A parameter being *accepted*
and settlement actually *splitting* are two different facts, and only the webhook
proves the second.

**This is the same class of bug as the `plan: {}` trap already in the VoiceReceipt
port map** — Paystack returns empty objects that are **truthy in JavaScript**.
Assert on a *field inside* `split`, never on the object's truthiness. That trap
has bitten this codebase's predecessor once already; it should not bite twice.

### One external change worth carrying

**Paystack acquired Ladder Microfinance Bank in January 2026** and operates it as
**Paystack Microfinance Bank**. Any licensing analysis that turns on what
Paystack itself is permitted to hold has moved since this plan was drafted — flag
it for counsel (open question 6), because it may change what a
platform-managed arrangement can look like.

## 10.4b Still unconfirmed

| # | Question | If the answer is bad |
|---|---|---|
| # | Question | Why it still matters |
|---|---|---|
| 4 | Can sub-merchant KYC be delegated to Paystack on the platform-managed flow? | A simplification if yes; no harm if no. |
| 6 | **Counsel:** is split-settled aggregation without custody outside licensable activity — and does Paystack's own MFB licence change the answer? | Gates ADR 0013 → Accepted. **The only remaining question that could still move the architecture.** |
| 1b | Does `charge.success` return a populated `split` object on a live PwT charge? | Empirical, one transaction, and it closes the last doubt on the platform model. |

## 10.5 The honest summary

**The mainline flow — storefront → order → invoice → per-transaction transfer
account → verified payment → receipt → ledger → dashboard — is coherent, and
every component of it is documented as existing.** What has *not* been done is
confirming that those components compose the way I have assumed, with one
specific join (question 1) carrying real weight.

Nothing here needs a merchant, a licence or a lawyer to start building: `packages/core`,
the storefront, the ledger, the documents and the dashboard are all unaffected by
every open question above. **Send Paystack the four questions and start building
the parts that do not depend on the answers.**
