# 0007 — AI router: deterministic-first, Sonnet as the default brain

**Status:** Accepted
**Date:** 2026-08-19

## Context

The owner's instruction: strongest results the fees can afford; upgrade
further when revenue allows. Extraction quality _is_ the product experience
in a conversational bookkeeper. Current per-call economics (typical
extraction ≈ 1,500 input / 250 output tokens): Haiku ≈ ₦2–4, Sonnet ≈ ₦8,
top-tier (Fable/Opus-class) ≈ ₦40. A heavy Chat merchant routes ~~250
messages/month through AI. The Twilio saving from ADR 0002 (~~₦2,900/
merchant/month) funds a stronger default model.

## Decision

```
Message → Deterministic parser (₦0)   — commands, confirmations, menus,
        ↓                                known intents: majority of traffic
        → Haiku                        — trivial classification only
        ↓
        → SONNET (DEFAULT BRAIN)       — all transaction extraction,
        ↓                                ambiguity resolution, financial Q&A phrasing
        → Escalation tier (config)     — hardest cases; OFF at launch
```

- **Sonnet is the runtime default** for everything that matters — not
  Haiku-first-with-fallback. ~₦2,000/month AI cost for a heavy merchant
  fits inside ₦9,900 with room.
- **Prompt caching** on the large static system prompt (~10× cheaper cached
  input; our prompts are ~90% static).
- **Top-tier models are for build-time and evals** (writing code, generating
  test cases, refereeing router evaluations), not runtime — at structured
  extraction with strict schemas, Sonnet performs at ceiling; 5× cost buys
  latency, not accuracy. The escalation flag exists so that flipping the
  strongest model onto a misbehaving message class is an env var, not a
  refactor.
- Guardrails regardless of model: strict JSON-schema outputs zod-validated
  before touching the core; AI replies never contain figures that didn't
  come from the deterministic layer; per-tier daily AI quotas; per-business
  cost telemetry from day one.

## Consequences

Best-affordable quality now, a one-variable upgrade path later, and margin
protected by routing the free majority of traffic away from AI entirely.
Model prices move; the router isolates every pricing change to
configuration. Revisit when telemetry identifies a message class where the
escalation tier measurably outperforms Sonnet.
