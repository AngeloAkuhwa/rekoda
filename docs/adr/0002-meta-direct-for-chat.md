# 0002 — Meta Cloud API direct for Rekoda Chat; Twilio for Integrate WABAs

**Status:** Superseded by [0011](0011-messaging-economics-revised.md)
**Date:** 2026-08-19

> **Superseded 2026-08-19.** The channel decision (Meta-direct for Chat,
> Twilio for Integrate WABAs) still stands and is unchanged. What this ADR
> got wrong is the _economics_: it assumed free-form service replies stay
> free, and built a ~₦2,900/merchant/month saving and a 75%+ margin on that
> assumption. Meta begins charging for service messages on 1 October 2026.
> Read [ADR 0011](0011-messaging-economics-revised.md) for the corrected
> figures and the allowance definition; treat every COGS number below as
> historical.

## Context

Rekoda Chat runs on Rekoda's **own** WhatsApp number. The commercial model
originally priced Twilio at $0.005 per message in both directions
(~₦7.25/message; ~₦2,900/month of COGS at a 400-message allowance) — the
single largest variable cost per Chat merchant. A Meta Cloud API direct
channel (webhook signature verification, native buttons/lists, media,
delivery statuses) is already built and tested in the predecessor codebase.

Free-form service replies inside WhatsApp's 24-hour window currently carry
no Meta per-message fee. Meta has announced service messages become
chargeable **1 October 2026** (rates publish ~1 September 2026).

## Decision

- **Rekoda Chat: Meta Cloud API direct.** No Twilio in the Chat path.
- **Rekoda Integrate: Twilio Tech Provider programme** for per-merchant
  WABA onboarding, where Twilio's tooling genuinely reduces operational
  surface. Meta-direct embedded signup remains an option to revisit.
- The channel layer stays **provider-agnostic** (one interface; Meta,
  Twilio and the local simulator as implementations) so this decision is
  configuration, not architecture.

## Consequences

Chat gross margin improves by roughly the entire Twilio line (~₦2,900 per
merchant at allowance), which funds the Sonnet-default AI decision (ADR
0007). We take on Meta platform relations directly (app review, display
name, quality rating) — mitigated by the existing submission runbook.
**Action standing:** re-run all COGS the day Meta publishes post-October
service-message rates; whatever they are, direct remains strictly cheaper
than Twilio-over-Meta, since Twilio passes Meta fees through and adds its
own margin.
