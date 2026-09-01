# 0033 — Multicurrency and embedded FX are a dark capability; the launch is NGN-only

**Status:** Accepted
**Date:** 2026-09-01
**Amends:** the capability STATUS of §16 and Appendix A. The FX model those
sections define — four distinct FX concepts, immutable snapshots, selection
against the accounting timestamp, manual override, historical permanence,
A.5's commercial spread — is unchanged and remains the design being built to.

## Decision (owner directive, 1 September 2026)

An earlier decision was to defer multicurrency. That is reversed. The
capability is built **now**, and it is built **dark**.

1. **Rekoda's public launch remains NGN-only.** No merchant, customer, public
   API consumer, Chat flow, Integrate flow, storefront flow or dashboard flow
   may invoke FX until a separate graduation decision is approved.
2. **Engineering may build and test** the accounting, rate, quote, conversion,
   reconciliation and commission infrastructure.
3. **The first accounting shape under development is NGN functional books with
   a foreign transaction currency.** A merchant whose entire books are kept in
   another currency is out of scope: `ledger_tx_currency_valid` already
   requires a transaction's functional currency to equal the business's, and
   that invariant stays.
4. **Accounting FX, execution FX and Rekoda's commercial FX are separate facts
   with separate provenance.** §16 and Appendix A.5 already say this; nothing
   here relaxes it, and no field may carry two of them.
5. **Rekoda must not custody customer FX principal.** The eventual live shape
   is customer → licensed provider → merchant, with Rekoda's commission
   settled by the provider only where the agreement expressly supports it. A
   wallet the principal passes through is forbidden. This is policy here and a
   runtime refusal in FX-09, where there is a provider capability record to
   refuse against.
6. **A non-zero Rekoda FX markup is OPEN COMMERCIAL and OPEN COMPLIANCE.** It
   defaults to zero, and absence of configuration may never produce a non-zero
   markup.
7. **Rekoda's commission is Rekoda's revenue.** It follows the
   `platform_cost_events` precedent — Rekoda's own subledger, outside every
   merchant's books — and is never posted as a merchant's Sales Revenue.

## `FX_MODE`, and why it is a mode

```
off      the default. No provider call, no executable quote, no FX anything.
shadow   rates may be OBSERVED for engineering evaluation. No execution.
sandbox  a provider's SANDBOX API only, for integration tests.
live     the state the graduation gate opens. Refused in production today.
```

Darkness is not the absence of a menu item. A menu item is removed by a page
and restored by a page, and this has to be removable by neither. So it is a
mode, `off` by default, and **production refuses to start on `FX_MODE=live`**
while the capability is dark — not "ignores it", not "warns and continues".
A process that came up with live FX believing it was configured to is the
accident this exists to prevent.

A kill switch one typo can flip is a promise rather than a control. When the
graduation gate is complete, `live` will additionally require a named approval
token and a provider capability record. That refusal is replaced by the PR
that opens the gate, and never by an environment change.

The darkness is also a dependency direction rather than a convention:
`scripts/check-boundaries.mjs` forbids any ingress — a controller, the public
API, the storefront, the chat and WABA handlers, the web tier — from importing
the FX modules or calling the FX repository. Today nothing does. The rule
exists for FX-04 onward, when real provider code arrives and one endpoint
added in passing would expose a capability nobody approved.

## The graduation gate

FX-10 passing is not permission to expose anything. There must be **no code
path where completing the engineering exposes FX**. Graduation is a separate
owner decision requiring, at minimum: the provider production account
approved; the supported corridors known; the provider contract reviewed; the
commission model contractually permitted; Nigerian legal and regulatory review
complete; Rekoda's non-custodial role documented; a KYC and AML responsibility
matrix agreed; fee and rate disclosure wording approved; a complaints and
refund process defined; transaction and daily limits configured; live webhook
verification and live reconciliation exercised; the kill switch exercised; the
runbook complete; and the public Terms and Privacy updated.

## Providers

Provider-neutral ports, as everywhere else. The first sandbox adapter targets
Fincra; Flutterwave is the second candidate. Paystack remains the NGN payment
provider and Mono remains bank data and reconciliation; neither is forced into
the FX abstraction.

A provider having two documented capabilities does not establish that its
agreement permits combining them. Provider capabilities are **probed and
recorded**, never inferred from public documentation, because a sandbox
account may expose what a production commercial account does not.

## What this ADR does not do

It does not rewrite §16 or Appendix A, which are correct. It does not
authorise exposure, live execution, a non-zero markup, a currency selector in
onboarding, or a claim anywhere in product or marketing copy that Rekoda
supports multicurrency. The current product is NGN-only and says so.
