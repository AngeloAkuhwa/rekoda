# 0005 — Privacy gateway: deterministic-first tokenisation, self-hosted STT

**Status:** Accepted; the self-hosted STT portion is **superseded by [0032](0032-launch-media-architecture.md)** (2026-08-29) — the launch transcriber is OpenAI, and no self-hosted STT service exists. The tokenisation gateway this ADR designed is unchanged and current.
**Date:** 2026-08-19

## Context

The spec requires customer PII to be tokenised (`CUSTOMER_X81`) before
external AI sees it, with real identities in an encrypted vault and
rehydration only at the authorised output layer. Hard truth: detecting that
"Ada" in a raw sentence is a person **is itself a language task** — a fully
AI-free PII detector for free-form Nigerian business speech does not exist.
Overpromising here would put an untrue claim on a trust page.

## Decision

Four-layer gateway, strongest-first:

1. **Known customers — deterministic.** Fuzzy-match message text against the
   business's own customer list inside Rekoda; replace with tokens before
   any external call. Covers the majority of traffic after a merchant's
   first week.
2. **Structural PII — deterministic.** Phones, emails, account numbers,
   addresses by rule, always stripped/tokenised.
3. **Novel names — minimise, then vault.** A never-seen name reaches the
   LLM once, under Anthropic's no-training API terms; the extraction is
   immediately vaulted and tokenised, so every later mention resolves via
   layer 1.
4. **Voice — self-hosted STT.** faster-whisper in a Rekoda-run container:
   merchant audio never leaves our infrastructure. A config flag can route
   to a provider API as fallback if the M3 accent benchmark demands it —
   with the public privacy copy updated honestly while active.

Token types are distinct, non-assignable TypeScript types:
`CustomerToken` ≠ `MagicLinkToken` ≠ `SessionId` ≠ `ApiKeyRef` (spec §7).

## Consequences

The public claim is exactly what the system does: _identities tokenised,
audio never leaves our infrastructure, AI providers receive minimised
pseudonymised context under no-training terms_ — never "AI never sees any
name ever." Layer 1 improves automatically as a business's customer list
grows. The vault is the single highest-sensitivity store in the system:
encrypted at rest, access-audited, and excluded from ordinary backups'
retention rules only via the documented erasure procedure.
