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
| **Has CAC + Meta verification** | Native WABA catalogue — orders arrive automatically | Nothing, after setup |

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
