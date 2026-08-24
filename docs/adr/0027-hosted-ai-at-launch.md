# 0027 — Hosted AI at launch, and the privacy pages tell the truth about it

**Status:** Accepted
**Date:** 2026-08-24
**Supersedes (in part):** 0008's "self-hosted only" transcriber stance and
0024 C9's "self-hosted OCR only" engine choice. The PIPELINES both ADRs
fixed are untouched; what changes is which engine a fresh deployment runs.

## Context

Three AI dependencies existed before this decision, in two postures:

- **The reasoning models were always hosted.** Haiku classifies, Sonnet
  interprets, Opus escalates — behind the privacy gateway, so no model ever
  sees a name, a number or an address, only tokens. Nothing here changes.
- **The two "senses" were specified as self-hosted sidecars**: ADR 0008's
  AfriSpeech-tuned Whisper for voice notes, ADR 0024 C9's OCR engine for
  receipt photos. Both exist as ports (`STT_URL`, `OCR_URL`) with honest
  refusals when unconfigured. Neither sidecar has been deployed.

The owner's launch decision (24 Aug 2026): **no self-hosted AI
infrastructure at launch**. One person operates this product; a GPU-or-CPU
sidecar fleet is an ops burden that solves a scale problem Rekoda does not
have, and both hosted routes cost pennies at launch volume.

## Decision

1. **The launch configuration is hosted end to end.**
   - Voice: `OpenAiSpeechToText` (default `whisper-1` — the transcription
     model that reports audio DURATION, which the `voice_seconds` meter
     takes as the provider's number, never an estimate).
   - Receipt photos: `VisionTextExtraction` — the vision-role Claude model
     as a transcription-only processor. The ADR 0024 pipeline is unchanged:
     photo → text extraction → PII gateway → reasoning model. Only the
     engine performing the extraction step moved.
2. **Selection is explicit configuration at boot, never a fallback at
   request time.** `STT_URL` / `OCR_URL` select the self-hosted sidecars
   exactly as before; otherwise the provider key selects the hosted engine;
   with neither, the product refuses honestly. A request that cannot reach
   its configured engine is refused, not rerouted.
3. **The privacy pages changed FIRST, in the words the old page promised.**
   /ai-privacy no longer claims "on infrastructure we run"; it names each
   processor, what they receive, that API inputs are not used for training
   under the terms Rekoda uses, and that the transcript is tokenised before
   any reasoning model sees it.
4. **The sidecar path is retained, not deleted.** The AfriSpeech accuracy
   case (30–45% WER for stock models on African-accented English) is real;
   when volume justifies the ops cost, setting `STT_URL` restores the
   stronger privacy sentence and the tuned model with no code change. The
   M3 benchmark comparator exists to make that call with data.

## Consequences

- `OPENAI_API_KEY` joins the launch environment alongside
  `ANTHROPIC_API_KEY`.
- The cost model (pricing-model.md) carries hosted STT at its ceiling
  (~₦9/min at planning FX) instead of "no per-minute fee"; margins hold.
- "Audio never leaves Rekoda" may not be said in marketing until a
  deployment actually runs the sidecar. The pages that said it have been
  rewritten; nothing else may resurrect the claim without flipping the
  config it describes.
