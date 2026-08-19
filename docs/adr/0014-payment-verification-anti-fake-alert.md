# 0014 — Payment verification as a product: the fake-alert defence

**Status:** Accepted
**Date:** 2026-08-19
**Reorders:** [0012](0012-integrate-without-cac.md) ladder B priority · builds on
[0013](0013-rekoda-as-the-single-integration.md)

## Context

The owner named a problem the plan had only solved by accident: **fake alerts**.

A customer at the counter shows the vendor a bank-transfer alert — an SMS, a
screenshot, a forwarded "debit successful" message. The vendor releases the
goods. The money never arrives, because the alert was fabricated, edited, or
belonged to a reversed or entirely unrelated transfer. For a market vendor or
Instagram seller this is not an inconvenience; it is the single most common way
they lose real money, and it is why many refuse transfers altogether.

Rekoda's architecture already answers it. The `RECORDED` vs `VERIFIED`
distinction (MASTER-PLAN §1.3) is *exactly* the fake-alert defence: a merchant
saying money came is `RECORDED`; a provider confirming money moved is
`VERIFIED`. What the plan lacked was making that a **product the merchant uses at
the moment of risk**, rather than a label on a dashboard read later.

## Decision

**Payment verification becomes a first-class, named feature — and the negative
answer is the product.** Anyone can build a green tick. The value is a
trustworthy *"no, that money has not arrived."*

### 1. Verification is push-first, not ask-first

The moment a verified payment event lands, Rekoda tells the merchant
unprompted:

> ✅ **₦50,000 received — verified**
> From Ada Okafor · 12:41 · matched to INV-2026-000318

The vendor never has to ask, and the absence of that message is itself the
signal. A "did it land?" query stays available for when they want to check.

### 2. Latency is a hard product requirement, and it reorders ladder B

**The customer is standing there.** A verification that arrives in five minutes
is not a verification; the goods are already gone. This makes latency a
correctness property, not a nicety, and it changes ladder B's priority:

| Rung | Verification latency | Fit for counter defence |
|---|---|---|
| **B2 / 0013 — per-transaction transfer accounts + checkout** (ADR 0016) | **seconds** | ✅ **The only rung that works at the counter** |
| B0 — open banking (Mono) | minutes (real-time refresh is rate-limited to one per 5 min) | ❌ for the counter · ✅ for bookkeeping |
| B1 — unregistered-tier virtual accounts | seconds | ✅ |

ADR 0012 made open banking the primary and DVAs an upgrade. **For the
fake-alert use case that ordering is wrong.** Open banking is excellent
bookkeeping infrastructure — it sees money arriving at accounts Rekoda did not
issue — but it cannot defend a counter. So:

* **Dedicated NUBANs (via ADR 0013's platform model) become the priority path**
  for merchants who take transfers from customers face to face.
* **Open banking remains the completeness layer**, catching everything the
  NUBANs do not.

Neither replaces the other; the fake-alert requirement simply decides which one
is built first.

### 3. Never accept an image or a forwarded alert as evidence — ever

Merchants **will** forward the screenshot. It must never move a payment toward
`VERIFIED`, and this is a hard rule for a specific reason: a forged alert is
exactly the kind of input an LLM can be talked into believing. The privacy
gateway and AI router see such an image as *unstructured text at most*; it can
open a lookup, never a confirmation.

The honest reply is a template, not an AI sentence:

> I can see the message, but I have not seen the money yet. I will tell you the
> second it lands. **Please don't release goods on a screenshot.**

**Silence is never verification.** The UI must distinguish three states, never
two: `VERIFIED` · `RECORDED (not yet verified)` · `NOT SEEN`. "Not seen" must
never be styled like a failure — most of the time it just means the transfer is
still in flight.

### 4. Fake receipts: make Rekoda documents checkable

The mirror problem is forged *receipts* — a document that looks like it came
from a real business. Rekoda's compliance layer already produces the
ingredients: sequential numbering, immutable snapshots and a SHA-256 document
hash (ported from VoiceReceipt, live-tested).

Expose them as a **public verification page**, `/verify/{documentNumber}`,
showing only:

```
INV-2026-000318 · issued by Ada Fashion · 19 Aug 2026 · ₦150,000 · valid
```

Design constraints, all mandatory:

* **No PII.** No customer name, phone, address or line items — issuer, number,
  date, total, validity, nothing more.
* **Not enumerable.** Document numbers are sequential by design (a compliance
  requirement), so the lookup key must be `number + a short unguessable check
  token` printed on the document. Rate-limit and never confirm existence for a
  bare sequential guess.
* **Merchant-controlled.** A merchant can disable public verification for their
  business; some will not want issuance volume inferable.

## Consequences

This turns a compliance property into the most concrete, most explainable
benefit Rekoda has. "Rekoda tells you if the money really landed" needs no
accounting vocabulary, and it is the strongest possible answer to *"why should
I pay ₦9,900 a month?"* — one prevented fake alert on a ₦50,000 sale pays for
five months.

It also raises the stakes on correctness. A product sold on verification that
shows a false ✅ once has destroyed the only thing it was selling. Hence:
provider-confirmed events only, never an image, never an inference, never AI.

**Marketing constraint:** say *"Rekoda confirms when money has actually
arrived in your account"* — never *"Rekoda stops fraud."* Rekoda cannot see a
transfer to an account it does not observe, and must not imply otherwise. The
`NOT SEEN` state must be explained on the pricing and feature pages, not
discovered by a merchant mid-sale.
