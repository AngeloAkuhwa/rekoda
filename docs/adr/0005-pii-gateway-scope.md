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

## Amendment 1 (PROPOSED, 20 Nov 2026; NOT ACCEPTED until the owner ratifies it): names in questions

**Status: PROPOSED.** Raised by CodeRabbit on PR #437 (G-135). The owner's preferred direction is scoped
Option A (owner review of #437, 20 Nov 2026), but this text takes effect only when the owner records a
ruling. Until then, layer 3 above stands as written, and the conflict below is an OPEN OWNER DECISION
(`REKODA_LAUNCH_READINESS.md`, G-135). The rest of this ADR is unchanged.

**Why.** BA-OD-3 (OWN-99) rules that a read never creates a customer. Layer 3 assumed that every name
the model reports is vaulted at once, so later mentions resolve through layer 1. Since #437, a question
resolves a name by lookup only (`PrivacyGateway.findMention`). A name nobody recorded is therefore not
vaulted, and each later question repeating it reaches the model again.

**Proposed rule: three cases.**

1. **A recognised customer** (a name, phone or email already in the business's vault). Unchanged. Layer 1
   or layer 2 replaces it with its token before any model call, in a question and in a write alike.
2. **An unknown name in a read-only question** (`Query`).
   - The question never creates a customer or a vault identity for the name (BA-OD-3).
   - The name reaches the interpretation model as typed in every question that contains it, repeats
     included. A question makes at most two such calls, the primary and one escalation, both to
     Anthropic. The document verifier (OpenAI) never runs for a `Query`. This is the only exception to
     "reaches the LLM once", and it is no wider:
     - it covers no other intent, no other processor, and no stored copy;
     - it does not cover a phone or email, which stay under layer 2 (G-135 part 2 makes their
       resolution provisional).
   - The name is never treated as a customer. The reply says the books hold no customer by that name
     (`customerNotKnown`). It never says that person owes nothing, and it never answers with the
     business's totals.
   - The words the model returned are removed from the stored copy of the message (`[name]`). The
     draft and continuation carry no name. G-136 records that other words of the typed name can remain.
3. **A name first met in a financial write** (sale, invoice, payment, order and the other write intents).
   Unchanged. The name is vaulted when the preview is built, before the merchant confirms. Customer
   creation stays in the authorised write workflow.

**Bounds that do not change:** the no-training API terms, the approved interpretation processor
(Anthropic), the observability contract (no prompt, completion or name in logs or
`usage_events.meta`), retention, and two-ask erasure. No table, migration or store of unknown names is
added.

**Public copy.** `/ai-privacy` currently says: "The first time you mention a new customer by name, the
model reads that one message to understand it. The name is then stored encrypted with its own token,
nothing keeps a readable copy, and every later message that names them is protected before it leaves."
Read plainly, this covers a name the merchant only asks about, so case 2 contradicts it. This amendment
can be accepted only together with an owner-approved change to that paragraph. The proposed wording is in
the G-135 row and PR #437; it is not applied.
