# 0032 — The launch media architecture: OpenAI STT + Claude vision, no sidecars

**Status:** Accepted
**Date:** 2026-08-29
**Supersedes:** the self-hosted engine options of
[0005](0005-pii-gateway-scope.md) (self-hosted STT), [0008](0008-stt-afrispeech-fine-tune.md)
(the AfriSpeech sidecar), 0024 C9 (the self-hosted OCR engine) and the
"sidecar stays one env var away" clause of [0027](0027-hosted-ai-at-launch.md).
The PIPELINES those ADRs fixed — media → text extraction → PII gateway →
reasoning model, and every confirmation/tenancy/accounting invariant — are
untouched.

## Decision (owner directive, 29 August 2026)

For the launch version of Rekoda:

1. **OpenAI is the hosted provider for speech-to-text.** Voice notes are
   sent to OpenAI's transcription API, solely to come back as text, when
   `VOICE_TRANSCRIPTION_ENABLED` is set.
2. **Anthropic Claude is the hosted reasoning provider**, and **Claude
   vision reads supported document photographs** as a transcription-only
   processor, when `IMAGE_AI_ENABLED` is set.
3. **There are no self-hosted STT or OCR sidecars.** `STT_URL`, `OCR_URL`,
   `STT_FALLBACK`, the HTTP sidecar clients and their tests are REMOVED
   from the codebase, not parked. Git history preserves the old
   implementation; reintroducing self-hosting requires a new ADR and a
   deliberate implementation, never a leftover branch.
4. **No fallback between engines, ever.** Each media job has exactly one
   configured engine; a request that cannot reach it is refused with an
   honest sentence, never rerouted.
5. **Media features fail closed at boot.** A feature switched on without
   its provider key refuses to start: `VOICE_TRANSCRIPTION_ENABLED`
   without `OPENAI_API_KEY`, or `IMAGE_AI_ENABLED` without
   `ANTHROPIC_API_KEY`, is a startup failure in front of the operator,
   not a runtime failure in front of a merchant. Disabled features need
   no credentials.
6. **Raw media stays transient.** Voice audio and document photographs
   are fetched, handed to the one configured processor, and dropped;
   Rekoda does not persist them. Any future feature that stores media
   requires separate, explicit approval.
7. **Public documentation tells this exact story.** /ai-privacy, /privacy,
   SECURITY.md and the README disclose that raw voice notes and images
   are securely transmitted to the configured hosted provider for the
   specific processing operation, that the output re-enters the
   tokenisation flow before reasoning, and that supported-identifier
   tokenisation is what the text path guarantees — never "all PII",
   never "audio never leaves Rekoda".

## Why

0027 made hosted AI the launch configuration but kept the sidecars "one
env var away". That residue had real costs: `.env.example` shipped a
`localhost:8081` URL that a copied deployment would try to call; provider
selection depended on which secrets happened to be present; SECURITY.md
and parts of /ai-privacy still described the self-hosted posture as
current; and every future reader had to hold two architectures in their
head to change one. A half-supported deployment mode is not optionality,
it is ambiguity — and ambiguity in the path that carries a merchant's
voice is a privacy-claim defect waiting to be republished.

## What holds this decision in place

- `loadConfig` refuses enabled-without-key at startup (config.test pins
  both refusals).
- The DI factories build exactly one engine per media job or the honest
  refusal class; there is no second branch to fall back to.
- The repo-wide sidecar sweep (this ADR's PR) removed the clients, the
  config, the tests and the stale documentation together, so the code
  and every current document tell the same story.
- Historical ADRs are marked superseded and preserved; they describe
  decisions that were real when made.
