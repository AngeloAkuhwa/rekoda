# The AI layer — one port, five roles, the best model for each

**Owner directive, 19 August 2026**: combine models freely, across providers,
in whatever arrangement produces the most performant results for voice
recordings and document handling. This document is that arrangement, and the
rules that keep it safe and swappable.

## 0. Why a mix is structural, not optional

The Claude API accepts text, images and PDFs. It accepts **no audio** — so a
voice note cannot be a single-provider pipeline no matter how good any one
model is. Rekoda already holds both an Anthropic and an OpenAI key and already
has a provider-neutral transport (ADR 0007); this strategy extends that from
"one interchangeable brain" to **one role-addressed ensemble**.

## 1. The roles and their defaults

Every AI call in Rekoda belongs to exactly one ROLE. Each role has its own
configurable model; nothing anywhere says "call Sonnet", it says "call the
interpreter". Defaults, chosen from current capability and price
(Anthropic first-party rates, June 2026 cache):

| Role | Default model | Price in/out per MTok | Job |
|---|---|---|---|
| `transcriber` | OpenAI `gpt-4o-transcribe` | audio-token priced | Voice note → text. OpenAI because Claude takes no audio; strongest current WER on accented English. `whisper-1` is the cost fallback. |
| `classifier` | Claude Haiku 4.5 | $1 / $5 | Document-type detection ("is this a receipt, an invoice, a statement?"), routing, and formatting §16 answers from deterministic query results. High volume, low nuance. |
| `interpreter` | Claude Sonnet 5 | $3 / $15 (intro $2/$10 ends 2026-08-31) | Text or transcript → StructuredBusinessCommand. The existing interpreter role. |
| `vision` | Claude Sonnet 5 | $3 / $15 | Receipts, handwritten bills, POS slips, photos (image blocks); supplier invoices and bank statements (native PDF document blocks, 32 MB / 600 pages) **with citations enabled**, so every extracted figure is pinned to the page that says it. |
| `escalation` | Claude Opus 5 | $5 / $25 | Fired ONLY by a confidence gate on high-value work: an unreadable scan worth re-trying, an ambiguous statement match, a large correction. Never a default path. |

Env overrides: `AI_MODEL_TRANSCRIBER`, `AI_MODEL_CLASSIFIER`,
`AI_MODEL_INTERPRETER`, `AI_MODEL_VISION`, `AI_MODEL_ESCALATION`. Unset roles
fall back to the provider family's default, so a deployment that sets nothing
behaves exactly as today.

## 2. The escalation ladder

```text
input → cheapest capable model → confidence check
                                     │ confident → deterministic validation → done
                                     │ unsure + low value → ask the merchant (Unclear)
                                     │ unsure + high value → escalation model, once
                                     └ still unsure → a human question, never a guess
```

Two rules make the ladder safe:
- **Escalation is bounded**: one retry, one tier up, under the existing
  per-business and global spend ceilings. A merchant's blurry photo cannot
  become an Opus loop.
- **"Unsure" is a normal outcome.** The Unclear intent and the confirmation
  gates already treat a model's doubt as product behaviour, not failure.

## 3. The force multipliers

- **Batch API, 50% off** — bank-statement parsing (rekoda-chat-v1 §7) is not
  latency-sensitive: statements go through `messages/batches` at half price.
- **Prompt caching** — already in place for the interpreter; every new role
  keeps its system prompt as a frozen constant for the same reason.
- **Strict tool schemas** — extraction roles set `strict: true` so tool input
  validates exactly against the zod-derived schema; a malformed extraction is
  a retry, never a parse adventure.
- **Citations for evidence** — statement and invoice extraction enables
  per-document citations, so reconciliation exceptions can show the merchant
  *where* a figure came from.

## 4. The rules that do not bend (unchanged, restated)

1. **Models never compute money.** Every total, balance and allocation is
   recomputed deterministically in `@rekoda/core`; model output is testimony.
2. **PII is tokenised before any external call** — voice transcripts and
   document extractions included (rekoda-chat-v1 §25). The transcriber
   necessarily hears the raw audio; its OUTPUT passes through the privacy
   gateway before any reasoning model sees it.
3. **Provider secrets never reach a model**, and provider requests are built
   deterministically from domain records (payments-v1 §13).
4. **Every model has a registered price** (`registerModelPrice`), so a role
   re-pointed by env cannot silently change COGS. Sonnet 5's intro pricing
   ends 31 Aug 2026 — the registry carries the post-intro rate.
5. **Spend ceilings apply per role**, sharing the existing per-business and
   global daily budgets.

## 5. Benchmark before belief

Defaults above are the best current choice on paper; the sales pitch is not
the measurement. Before the voice and document slices ship:

- **Voice bench**: a recorded set of Nigerian-accented English voice notes
  (with Pidgin and code-switching), scored on word error rate AND on
  field-level accuracy of the resulting StructuredBusinessCommand — the
  metric that pays is "did the books come out right", not WER alone.
- **Document bench**: a set of real receipt photos, handwritten bills and
  supplier invoices, scored per extracted field (merchant, date, amount,
  line items) against hand-labelled truth.
- Winners take the role defaults; the losers stay one env var away.

## 6. What this changes in code, and when

- **Now** (with this document): per-role model config in `apps/api/config.ts`
  with env overrides and family defaults; the interpreter reads its role.
- **Voice slice**: `transcriber` consumed by the voice pipeline
  (length check from `VOICE_NOTE_MAX_DURATION_SECONDS` → transcribe →
  gateway → interpreter).
- **Document slice**: `classifier` + `vision` consumed by upload handling;
  statements go through the Batch API.
- **Never**: a model name hard-coded at a call site.
