# 0023 — Haiku reads the merchant's message; exact model ids, prices as configuration

**Status:** Accepted
**Date:** 2026-08-21
**Corrected:** 2026-08-21 — as first written, this ADR claimed the Chat
subscription "is now ₦3,500". That was wrong: it is ₦9,900 and always has been
(pricing-model.md §"Rekoda Chat"). The figure was invented, not read. The
decision below is unchanged and the arithmetic that supports it is now the
real one; the error is recorded rather than quietly rewritten, because an ADR
whose reasoning moves without saying so cannot be trusted by the next reader.
**Supersedes the default-model choice in:** [0007](0007-ai-router-sonnet-default.md)
(the deterministic-first router, the escalation flag and the guardrails in 0007
all stand unchanged)

## Context

Three things have moved since 0007 was written on 19 August 2026, and each of
them on its own would be worth a paragraph. Together they change the answer.

**The arithmetic 0007 did no longer holds.** It priced Sonnet at ≈₦8 a call
against the ₦9,900 Chat subscription and concluded that ~₦2,000/month of model
cost "fits with room". The price moved: Sonnet's standard rate is $3/$15 per
MTok, not the $2/$10 the table in `@rekoda/core` carried.

At the planning FX of ₦1,450/$ and 0007's own typical extraction (≈1,500 input
/ 250 output tokens), that is **₦11.96 a call** rather than ₦8. A heavy Chat
merchant routing ~250 messages a month through the model therefore costs
**≈₦2,990 against ₦9,900 — about 30% of subscription revenue**, before Meta,
storage or Paystack. That is not "with room".

**Two configured model ids were not real ids.** `AI_MODEL_DEFAULT` and
`AI_MODEL_VISION` both defaulted to `claude-sonnet-latest`, which is not a
model id in the current lineup. A `-latest` alias is also a liability of its
own even where one resolves: cost telemetry keys on the model FAMILY, so an
alias that silently hops tiers reports last month's rate against this month's
bill, and the margin view says nothing.

**`gpt-4.1` leaves the API on 14 October 2026**, taking the hardcoded OpenAI
price table in `apps/api/src/ai/model-prices.ts` with it.

## Decision

**Haiku is the interpreter default; Opus stays the escalation tier.**

0007's own argument for not reaching higher applies one tier lower. It said
that "at structured extraction with strict schemas, Sonnet performs at ceiling;
5× cost buys latency, not accuracy". The interpreter's job is one extraction
from one short message, under forced tool use, against a strict schema, with
every figure recomputed afterwards by code that does not trust the answer and a
₦10bn ceiling the model cannot emit past. That is the shape of work the small
model is built for, and it costs a third of Sonnet in both directions.

This is a default, not a belief. If the M3 extraction eval shows Haiku losing
accuracy on real Nigerian merchant phrasing — pidgin, mixed units, "50k" for
fifty thousand — `AI_MODEL_DEFAULT` moves it back with no code change. Vision
keeps the larger model: reading a photographed receipt is a harder job than
parsing a sentence somebody typed, and it is rare enough not to dominate cost.

**Exact model ids, never `-latest` aliases**, for the telemetry reason above.

**Prices for anything outside the Claude families are configuration**
(`AI_MODEL_PRICES`), not a table in this repository. A table here goes stale
silently, and replacing the retiring OpenAI one means writing prices nobody in
this repository can check against the vendor's own page. The existing rule
decides it: a wrong price is worse than a missing one, because a missing one
refuses to boot and a wrong one becomes a margin somebody acts on. The price
now comes from whoever holds the invoice.

**No OpenAI default ships at all.** `AI_PROVIDER=openai` without
`AI_MODEL_DEFAULT` is a boot failure rather than a guess.

**The price table records STANDARD rates, never promotional ones.** Sonnet 5
has introductory pricing to 31 August 2026; the table carries the $3/$15 it
reverts to. A table that switched itself on a date would flatter the margin for
ten days and then correct, and nobody would know which of the two numbers a
decision had been made on. Costing above the invoice is a surprise in the safe
direction.

## Consequences

- Model cost per interpreted message falls to roughly a third: **₦3.99 a call,
  ≈₦997 a month for that same heavy merchant, about 10% of ₦9,900**. Not a
  rounding error, and it should not be described as one, but the difference
  between 30% and 10% of revenue is the difference between the model being a
  line item and the model being a problem. Prompt caching on the static system
  prompt (already built) applies on top of that.
- `AI_BASE_URL` makes the OpenAI transport an OpenAI-COMPATIBLE one: Groq,
  Together, OpenRouter and DeepSeek weights on a US host are a deployment
  decision rather than a new adapter. **DeepSeek's own API stays out of
  scope** — PRC-hosted and training on inputs by default, which a merchant's
  sentence about their customer cannot be donated to under the NDPA. The URL
  is a compliance decision before it is a price one.
- An operator switching providers must supply a price. That is the intended
  friction: it is the moment somebody looks at what the calls will cost.
- The accuracy claim is untested until the M3 eval runs. Until then this is a
  reasoned default with a one-variable escape hatch, and it should be
  described that way rather than as a finding.
