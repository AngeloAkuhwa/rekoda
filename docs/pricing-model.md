# Rekoda V1 — Commercial & Pricing Model

**Status:** Adopted for launch, with the adjustments recorded at the end.
**Basis:** External-cost research as of 16 August 2026; internal planning FX ₦1,450/$
(CBN ~₦1,357/$, Wise ~₦1,393/$ at time of research — the buffer absorbs FX movement
and card/billing spreads).

## The ladder

```
                  FREE TRIAL
              ₦0 · 30 days · 5 document generations
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
    REKODA CHAT               REKODA INTEGRATE
     ₦9,900/mo                  ₦19,900/mo
    (₦99,000/yr)               (₦199,000/yr)
          │                         │
          └────────────┬────────────┘
                       ▼
                REKODA COMPLETE
              ₦29,900/mo (₦299,000/yr)
```

Annual = 10× monthly (effectively two months free). **Do not compete at
₦2,000–3,000/month** — the reconciliation loop is priced against an
accountant's afternoon, not against an invoice template.

## What each plan includes

### Free Trial — ₦0, 30 days from activation

> **Corrected 19 Aug 2026 — the original 5-document trial was self-defeating.**
> The trial allowed **25 recorded transactions but only 5 documents**. Since a
> sale typically produces an invoice _and_ a receipt, the document credit was
> exhausted at roughly the **third transaction**, leaving 22 transactions that
> generate no invoice and no receipt — i.e. the merchant hits the wall before
> ever seeing the thing they would be paying for.
>
> It also gates the wrong resource. §"External cost stack" establishes that
> **documents cost essentially nothing** (compute + storage) while **messages
> and voice are the real COGS**. Capping the free thing and giving away the
> expensive thing is backwards on both counts.

1 business · 1 owner · **25 document credits** (matched to the transaction
allowance, so every trial transaction can produce its invoice and receipt) ·
**50 WhatsApp messages** · **10 voice minutes** · 25 recorded transactions ·
dashboard, customers, products, basic summary · Integrate connection allowed
during trial · Paystack processing fees always separate.

**Messages and voice remain the binding constraints** — they are what actually
cost money, and they cap trial COGS at roughly the same ₦800–₦1,200 the original
model assumed. Documents are an abuse-control ceiling, not a value gate.

### Rekoda Chat — ₦9,900/month

_Talk to Rekoda. Your records build themselves._
1 business · owner + 1 accountant/delegate · **400 messages** ·
**60 voice minutes** · **100 document generations** · 25 utility reminders ·
unlimited PDF/Excel reports · unlimited-reasonable customers & products · sales,
expenses, purchases, suppliers, inventory, partial payments, customer
balances, invoices, receipts, dashboard, AI financial questions, magic-link
dashboard, manual payment matching. **No** automatic Paystack
reconciliation, **no** catalogue connection. Statuses shown honestly:
_Payment Recorded_ (merchant said so) vs _Payment Verified_ (Paystack
confirmed).

### Rekoda Integrate — ₦19,900/month

_Connect your WhatsApp shop. Rekoda handles the money trail automatically._
1 business · 1 WhatsApp Business number/WABA · 1 catalogue · 1 Paystack
connection · owner + 2 delegates · **800 messages** · **60 voice minutes** ·
**300 catalogue orders** · **500 document generations** · 100 utility
templates · unlimited reports · automatic order capture → customer records →
invoices → payment verification → receipts → inventory → reconciliation, with
unmatched/short-payment/exception detection. Voice carries the same hour Chat
has: the ladder never walks backwards, so a Chat merchant who opens a shop
keeps every habit they built. (Corrected 24 Aug 2026 — this section previously
said "no voice bookkeeping" and "200 orders" while the enforced allowance was
already 300; `packages/core/src/allowances.ts` is the single source of truth.)

### Rekoda Complete — ₦29,900/month

_However you sell, Rekoda keeps the complete money trail._
Chat + Integrate combined: **1,200 messages** · **120 voice minutes** ·
**300 orders** · **750 documents** · 150 utility templates · unlimited reports ·
3 delegates · daily/weekly/monthly summaries · priority support · branded
documents. This is the plan growing merchants should land on — offline and
online reality in one consolidated financial position.

## Add-on packs (launch overage model)

| Add-on                                  | Price            |
| --------------------------------------- | ---------------- |
| +100 WhatsApp messages                  | ₦2,500           |
| +30 voice minutes                       | ₦1,500           |
| +50 document generations                | ₦2,000           |
| +50 Integrate orders + related capacity | ₦5,000           |
| Extra accountant/delegate               | ₦1,500/month     |
| Additional WhatsApp number              | Custom initially |

No unlimited CONSUMABLE usage at launch — real merchant behaviour is unknown,
and packs protect against the ₦9,900-payer who scripts 30,000 messages.
Reports are not a consumable: a PDF or a workbook costs compute and costs no
provider a naira, and metering the one habit worth encouraging would be
charging a merchant to look at their own accounts (ADR 0024).

> **Payment-processing fee, confirmed 19 Aug 2026.** Collection runs on
> **Pay with Transfer**, charged at Nigeria's **local rate: 1.5% + ₦100, capped
> ₦2,000**, with the ₦100 waived below ₦2,500. The **1% capped ₦300** rate is
> **Dedicated-Virtual-Account-specific** and does _not_ apply — a PwT temporary
> account is not a DVA (ADR 0016). On a ₦105,000 order that is **₦1,675**, not
> ₦300. The merchant bears it, so `/pricing` must say so plainly. The cheaper
> DVA rate would require customer BVN validation, a per-platform 1,000-account
> ceiling and a registered business — **the trade is worth it, and it is
> disclosed, not buried.**
>
> **Reconciliation note, 19 Aug 2026.** The cost stack below was researched on
> 16 Aug 2026 and several lines are now superseded by decisions taken since.
> Where they conflict, **the ADR wins**:
>
> | Original assumption                                                | Superseded by                                                                                                                                        |
> | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Twilio ₦7.25/msg both directions for Chat                          | **ADR 0002/0011** — Chat is Meta-direct; Twilio applies to the Integrate WABA path only                                                              |
> | Free-form replies and utility templates free inside the 24h window | **ADR 0011** — Meta charges for **every service message from 1 Oct 2026**, flat, no volume discount (~₦10/outbound in Nigeria)                       |
> | Twilio Verify ~₦80+/OTP                                            | **ADR 0002** — OTP over Rekoda's own WhatsApp number (~₦10), SMS fallback only                                                                       |
> | OpenAI transcription ~₦6.53/min                                    | **ADR 0027** (24 Aug) — hosted transcription IS the launch configuration, costed at a $0.006/min ceiling; ADR 0008's sidecar retained behind STT_URL |
> | Azure hosting ₦75–150k/month                                       | **ADR 0006** — Hetzner + Cloudflare + R2, **~₦30–40k/month** at launch                                                                               |
> | Nightly `pg_dump` backups                                          | **ADR 0010** — continuous WAL archiving (PITR)                                                                                                       |
>
> Net effect: hosting and STT are **much** cheaper than modelled, messaging is
> **more** expensive from October, and the ₦9,900 tier lands at **39–60% margin**
> rather than the "45–60%" originally estimated. The 1 September rate
> publication is a release gate — see §"Standing review triggers".
>
> **Re-verification, 24 Aug 2026.** Rates checked against current published
> figures; the planning rule stands: **model every cost at or above market**.
>
> - **FX:** CBN ₦1,346.49 (24 Aug) — the naira STRENGTHENED from ₦1,357 at
>   research time. Planning FX **held at ₦1,450/$**, now a ~7.7% buffer.
> - **Meta authentication (NG) was WRONG below:** the 2026 rate is
>   **$0.0145** per conversation (not ~$0.0067) for a Nigeria-registered
>   WABA, and **$0.0750 — eleven times more — when the WABA is registered
>   outside Nigeria**. Corrected in the table; OTP cost roughly doubles
>   against the original model and the margin band absorbs it. **Launch
>   requirement: the WABA must be registered in Nigeria.**
> - **Model rows now carry conservative ceilings:** Sonnet modelled at
>   $3/$15 per MTok (published figures vary by generation; we cost the
>   ceiling), Opus escalation added at $5/$25. Haiku $1/$5 confirmed.
> - **Integrate voice corrected the same day:** the plan ladder walked
>   backwards (Chat had 60 voice minutes, Integrate had none); Integrate now
>   carries the same 3,600 seconds. Complete's "120 minutes = Chat +
>   Integrate combined" framing is now arithmetically true.

## External cost stack (researched 16 Aug 2026, re-verified 24 Aug 2026, at planning FX ₦1,450/$)

| Service                    | Underlying price        | ≈ Cost             | Note                                                                   |
| -------------------------- | ----------------------- | ------------------ | ---------------------------------------------------------------------- |
| Twilio WhatsApp            | $0.005/msg each way     | ₦7.25/msg          | Integrate path only — see ADR 0002                                     |
| Meta utility template (NG) | ~$0.0067                | ₦9.72              | Only when required                                                     |
| Meta authentication (NG)   | $0.0145 (NG-registered) | ₦21.03             | OTP. **$0.0750 if the WABA is registered outside Nigeria — 11x trap**  |
| Meta marketing (NG)        | ~$0.0516                | ₦74.82             | **Excluded from V1 entirely**                                          |
| In-window service replies  | currently ₦0 Meta-side  | —                  | **Chargeable from 1 Oct 2026; re-run maths when rates publish ~1 Sep** |
| OpenAI transcription       | $0.0045/min             | ~₦6.53/min         | Benchmark only — STT is self-hosted (ADR 0005)                         |
| Claude Haiku 4.5           | $1/$5 per MTok          | ~₦2–4/call         | Trivial classification                                                 |
| Claude Sonnet              | $3/$15 per MTok ceiling | ~₦12/call          | **Runtime default** (ADR 0007); costed at ceiling per 24 Aug rule      |
| Claude Opus 5              | $5/$25 per MTok         | ~₦20/call          | Escalation role only — rare by design                                  |
| Claude Fable 5             | $10/$50 per MTok        | ~₦40/call          | Build-time & evals, escalation flag only                               |
| Paystack local card        | 1.5% + ₦100, cap ₦2,000 | merchant-borne     | Never absorbed into subscription                                       |
| Paystack DVA/transfer      | 1%, cap ₦300            | merchant-borne     | Encourage "pay by transfer"                                            |
| Hosting (ADR 0006)         | Hetzner+CF+R2           | ~₦30–40k/mo shared | ~₦1,500/business at 25 businesses                                      |

## Commercial rules

1. **Paystack processing fees are never absorbed.** The subscription pays
   for automation, AI, documents and reconciliation — not the movement of
   the customer's ₦100,000. Stated transparently on /pricing.
2. **No bulk/promotional WhatsApp marketing in any V1 plan.** Rekoda sends
   invoices, receipts, confirmations, reminders, answers — not campaigns.
3. **No exposed "AI credits."** Merchants see concrete units (messages,
   voice minutes, documents, orders); infrastructure units (tokens, STT
   minutes, template fees) are tracked internally per business.
4. **Soft limits.** A merchant mid-transaction is never cut off; hard stops
   apply only to document generation, only between transactions, with an
   upgrade path in the message.
5. **Grandfathering.** The launch cohort keeps launch pricing for at least
   12 months.

## Target unit economics

Subscription revenue − external variable cost → **55–70% gross margin**,
funding engineering, support, sales, compliance, profit. Launch estimates
(planning assumptions, not vendor quotes — Chat margin reflects the
Meta-direct decision of ADR 0002):

| Plan      | Price   | Expected COGS | Rough gross margin |
| --------- | ------- | ------------- | ------------------ |
| Chat      | ₦9,900  | ~₦2.5–4k      | ~60–75%            |
| Integrate | ₦19,900 | ~₦7–9k        | ~55–65%            |
| Complete  | ₦29,900 | ~₦11–15k      | ~50–63%            |

A normally used trial should cost **~₦500–900 per activated business**
(WhatsApp-OTP onboarding, ADR/plan F2) — acceptable CAC if conversion is
healthy.

## Cost telemetry is a build item (M0 schema, M4 surfaced)

Per business, the admin dashboard knows:

```
ADA FASHION                       month to date
Subscription revenue        ₦29,900
Meta/Twilio                  ₦x
Claude                       ₦x
STT compute allocation       ₦x
Storage + hosting alloc.     ₦x
────────────────────────────────
Estimated COGS               ₦x
Gross contribution           ₦x   (margin %)
```

Tracked as `usage_events`: `businessId · provider · usageType · quantity ·
providerCostKobo · currency · billingPeriod`. **Six weeks after launch,
telemetry replaces every assumption in this document.**

## Known gap: document understanding is a new, unpriced cost class

> **Flagged 20 Aug 2026.** The Rekoda Chat V1 directive (docs/rekoda-chat-v1.md
> §4–7) adds uploaded-document understanding — receipt photos, supplier
> invoices, proofs of payment, bank statements — which did NOT exist when this
> cost stack was researched on 16 Aug. Unlike generated documents (which cost
> ~~nothing), every upload is a vision-model call (~~₦10–15 per photo at
> planning FX) and a statement can run ₦300–800 even at batch pricing. A
> merchant uploading 200 receipts a month is ₦2–3k of COGS no plan currently
> charges for.
>
> **Rule: the document slice must not ship before this class has (a) a plan
> unit ("documents understood", distinct from documents generated), (b) a
> per-business daily ceiling (config `AI_DOC_EXTRACTIONS_PER_BUSINESS`,
> declared 20 Aug, default 25/day), and (c) a usage row per extraction so the
> first-50-merchants telemetry checkpoint can price it from data.** Soft-limit
> rules apply as everywhere: the merchant is told plainly, never cut off
> mid-transaction.

## Standing review triggers

- 1 September 2026 — Meta publishes post-October service-message rates →
  re-run all COGS.
- First 50 paying merchants → replace planning COGS with telemetry;
  re-examine allowances against real P50/P95 usage.
- First pilot cohort with real results → collect one to three NAMED merchant
  testimonials with naira figures for the landing page. Social proof is
  deliberately absent until it is real (fabricating it would break the trust
  positioning); the moment it exists, it outperforms any redesign.
- Any FX move beyond the ₦1,450/$ planning buffer.
