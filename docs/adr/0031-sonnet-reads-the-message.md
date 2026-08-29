# 0031 — Sonnet reads the merchant's message: accuracy first

**Status:** Accepted
**Date:** 2026-08-29
**Supersedes (in part):** [0023](0023-haiku-reads-the-message.md)'s choice of
default interpreter model, and its price table's $3/$15 Sonnet entry. 0023's
other two decisions — exact model ids only, prices for foreign families as
configuration — stand unchanged and are load-bearing in this ADR too.

## Context

ADR 0023 put Haiku on the interpreter on cost grounds, with sound reasoning
about the job's shape: one extraction from one short message, forced tool use
against a strict schema, arithmetic recomputed afterwards by code that does
not trust the answer. That reasoning has not been refuted. Two facts around
it changed.

First, the launch priority was made explicit (owner directive, 29 August
2026): Rekoda optimises for **avoiding harmful financial mistakes**, not for
answering every request cheaply. The schema border catches malformed output;
it cannot catch a well-formed misreading. "Sold 3 wigs 45k" extracted as
quantity 45 at ₦3,000 passes every gate and reaches the merchant as a
confident preview. The confirmation step is real protection, but a preview
that is usually right trains the merchant to stop reading it — the accuracy
of the FIRST parse is itself a safety property.

Second, the price gap that justified the small model closed. When 0023 was
written, Sonnet's standard rate was $3/$15 per MTok against Haiku's $1/$5,
with $2/$10 recorded as introductory pricing lapsing 31 August 2026. That
rate did not lapse: $2/$10 is Sonnet 5's permanent list price. At the
interpreter's real shape (~1,800 input, ~220 output tokens) a call moves
from about ₦4 to about ₦8 — a difference the ₦9,900 subscription absorbs at
any plausible volume, where the original 3× framing would not have been.

## Decision

1. **Claude Sonnet 5 (`claude-sonnet-5`) is the interpreter default** for the
   Anthropic provider (`AI_MODEL_DEFAULT` unset). Deployments that want the
   old behaviour set `AI_MODEL_DEFAULT=claude-haiku-4-5` explicitly.
2. **Haiku keeps the classifier role** (`AI_MODEL_CLASSIFIER`), where a cheap
   answer avoids a costlier call and a mistake costs a retry rather than a
   wrong draft. The role split in `docs/ai-model-strategy.md` §1 is the
   design; this ADR aligns the shipped default with it.
3. **The cost table records $2/$10 as Sonnet 5's permanent rate**, with 1.25×
   for five-minute cache writes and 0.10× for cache reads. Historical
   `usage_events` rows keep the cost recorded when they were written; the
   table prices future calls and never rewrites history.
4. **Boot refuses any configured token role without a registered price** —
   interpreter, classifier, vision and escalation alike, whenever the active
   provider's key is present. A role whose model has no price is a role whose
   every call reports as free, which is the failure the margin view exists to
   prevent.

## Consequences

- The interpreter's per-call cost roughly doubles against 0023's economics
  and remains a rounding error against the subscription. The margin view
  carries the real figure either way.
- 0023 is NOT rewritten. Its status block gains a supersession note and its
  text remains as accepted, price caution included — that caution was correct
  on the day it was written, and the register's rule is that history is
  marked superseded, never edited.
- OpenAI-compatible deployments are unchanged: no default ships, and
  `AI_MODEL_DEFAULT` plus a registered price remain boot requirements.
