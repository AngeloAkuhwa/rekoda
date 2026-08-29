# The AI layer — one port, five roles, the best model for each

**Owner directive, 19 August 2026**: combine models freely, across providers,
in whatever arrangement produces the most performant results for voice
recordings and document handling. This document is that arrangement, and the
rules that keep it safe and swappable.

## 0. Why a mix is structural, not optional

The Claude API accepts text, images and PDFs. It accepts **no audio** — so a
voice note can never be a single-vendor pipeline no matter how good any one
model is. Rekoda's answer to audio is self-hosted (ADR 0005/0008, see §7),
which makes the ensemble three-legged by construction: a self-hosted
transcriber, the Claude family for reasoning and vision, and OpenAI as the
switchable second reasoning provider (ADR 0007) and STT benchmark comparator.
This strategy extends the existing provider-neutral transport from "one
interchangeable brain" to **one role-addressed ensemble**.

## 1. The roles and their defaults

Every AI call in Rekoda belongs to exactly one ROLE. Each role has its own
configurable model; nothing anywhere says "call Sonnet", it says "call the
interpreter". Defaults, chosen from current capability and price
(Anthropic first-party rates, June 2026 cache):

| Role          | Default model                                                                           | Price in/out per MTok                   | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcriber` | hosted `whisper-1` (ADR 0027); `afrispeech-whisper-medium-all` sidecar behind `STT_URL` | per-minute, ceiling $0.006/min          | Voice note → text. ADR 0027 made hosted transcription the launch configuration — whisper-1 because it reports the DURATION the voice_seconds meter bills from — with the AfriSpeech sidecar retained one env var away for the accuracy + "audio never leaves Rekoda" hardening move (generic models run 30–45% WER on African-accented English; the M3 benchmark comparator exists to make that call with data). Selection is boot config, never a silent fallback. |
| `classifier`  | Claude Haiku 4.5                                                                        | $1 / $5                                 | Document-type detection ("is this a receipt, an invoice, a statement?"), routing, and formatting §16 answers from deterministic query results. High volume, low nuance.                                                                                                                                                                                                                                                                                             |
| `interpreter` | Claude Sonnet 5                                                                         | $2 / $10 (permanent list rate)          | Text or transcript → StructuredBusinessCommand. The existing interpreter role.                                                                                                                                                                                                                                                                                                                                                                                      |
| `vision`      | Claude Sonnet 5                                                                         | $2 / $10                                | Receipts, handwritten bills, POS slips, photos (image blocks); supplier invoices and bank statements (native PDF document blocks, 32 MB / 600 pages) **with citations enabled**, so every extracted figure is pinned to the page that says it.                                                                                                                                                                                                                      |
| `escalation`  | Claude Opus 5                                                                           | $5 / $25                                | One bounded retry when the interpreter's answer cannot safely proceed: it failed the strict schema, never called the tool, or said Unclear. Implemented triggers exactly those three; a `max_tokens` truncation deliberately does NOT escalate (same ceiling, pricier model — that is a configuration fault, not ambiguity). At most one escalation per message, never recursive, consuming the same shared quota, costed under its own role with the reason on the row. If Opus is also uncertain, the merchant gets a focused question, never a guess. |

Env overrides: `AI_MODEL_TRANSCRIBER`, `AI_MODEL_CLASSIFIER`,
`AI_MODEL_DEFAULT` (the interpreter — this is the implemented variable name;
an earlier draft of this page said `AI_MODEL_INTERPRETER`, which nothing
reads), `AI_MODEL_VISION`, `AI_MODEL_ESCALATION`. Unset roles fall back to
the defaults above, so a deployment that sets nothing gets this table.
Hosted transcription is priced per minute via `AI_TRANSCRIPTION_PRICES`
(micro-USD per minute, keyed by exact model id) — required at boot whenever
hosted STT is the active configuration, so no transcription can report as
free.

**The classifier is a gate, never a mandatory hop.** For a single receipt
photo, one `vision` call that classifies AND extracts is cheaper than
classify-then-extract (two calls). The classifier runs only where a cheap
answer AVOIDS an expensive call: rejecting junk images, routing statements to
the batch path, formatting §16 query answers. A pipeline that sends every
document through Haiku first has misread this table.

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
  _where_ a figure came from.

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

- **Voice bench**: ADR 0008's M3 benchmark is the authority — three
  self-hosted candidates head-to-head plus the hosted comparator, gated on
  ENTITY-LEVEL accuracy (amount, quantity, name-string closeness for the
  fuzzy match), because the metric that pays is "did the books come out
  right", not WER.
- **Document bench**: a set of real receipt photos, handwritten bills and
  supplier invoices, scored per extracted field (merchant, date, amount,
  line items) against hand-labelled truth.
- Winners take the role defaults; the losers stay one env var away.

## 6. Validation: deterministic first, a second model only where it adds signal

**Decision (owner question, 20 Aug 2026): no blanket LLM validator on outputs.**
Rekoda already has four validators stronger and cheaper than any model:

1. the strict zod schema at the AI border (malformed or hostile output is
   rejected, never parsed around);
2. the deterministic money engine, which recomputes every figure and surfaces
   disagreement as CG1 instead of trusting either party;
3. the confirmation gate: the MERCHANT reads the preview before anything
   posts — a free human validator on every material transaction;
4. server-side provider verification for payments, which trusts neither
   webhook nor model nor screenshot.

A second LLM checking the first shares the first's failure modes (both can
misread "150" as 150k), adds latency to a chat product, and at Chat-plan
volume would cost real margin: even a Haiku pass on every interpreted message
is roughly ₦600–1,200 per merchant per month against a ₦9,900 plan — several
points of gross margin spent re-checking what code already checks.

**Where a second model DOES earn its cost — cross-model extraction agreement
on high-stakes documents.** Extraction from images and PDFs is the one task
where two different models fail differently, so agreement carries signal:

- bank-statement imports (§7 of rekoda-chat-v1): rows extracted by `vision`
  are re-extracted by `classifier` (Haiku) in the same half-price batch;
  disagreeing rows land in `requires_review`, never auto-post. Cost per
  statement: single-digit naira.
- supplier invoices above a configurable threshold
  (`AI_DUAL_EXTRACT_THRESHOLD_K`, default ₦500,000): same dual-extract,
  same rule — agreement proceeds to the normal confirmation gate,
  disagreement asks the merchant.

The shape to hold: **a validator model is an exception-finder on high-stakes
documents, never a toll booth on every message.**

## 7. STT: the launch call, twice corrected on the record

This section has now swung both ways, and both swings are kept on the record
because each was right about something.

An early revision proposed hosted transcription for launch-ops simplicity.
ADR 0008 reversed it: the self-host case is anchored on privacy ("audio
never leaves Rekoda" as the trust page's strongest sentence) and accuracy
(generic models measure 30–45% WER on African-accented English, above 70% on
entity-rich utterances, which is every Rekoda voice note).

**ADR 0027 (24 Aug 2026) is the owner's launch decision, and it stands:**
hosted `whisper-1` at launch, because a one-person operation should not
carry sidecar ops for a scale it does not have — with three conditions that
keep ADR 0008's substance alive rather than discarding it:

1. the trust page changed FIRST, in the words it promised, and names the
   processor — the strong sentence is retired until a deployment earns it;
2. the AfriSpeech sidecar stays one env var away (`STT_URL`), selection at
   boot, never a silent runtime fallback;
3. the M3 benchmark comparator remains the instrument that decides WHEN the
   sidecar's accuracy case justifies its ops cost, on ADR 0008's gate
   metric — entity-level accuracy (amount, quantity, name-string
   closeness), not WER.

## 8. What this changes in code, and when

- **Now** (with this document): per-role model config in `apps/api/config.ts`
  with env overrides and family defaults; the interpreter reads its role.
- **Voice slice**: `transcriber` consumed by the voice pipeline
  (length check from `VOICE_NOTE_MAX_DURATION_SECONDS` → transcribe →
  gateway → interpreter).
- **Document slice**: `classifier` + `vision` consumed by upload handling;
  statements go through the Batch API.
- **Never**: a model name hard-coded at a call site.
