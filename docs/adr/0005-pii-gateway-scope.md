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

## Amendment 1 (PROPOSED, 20 Nov 2026; NOT ACCEPTED until the owner ratifies it): names in questions, and what the history keeps

**Status: PROPOSED.** Raised by CodeRabbit on PR #437 (G-135). The owner's direction is the narrowed
Option A (owner directives on #437, 20 Nov 2026). Option C (questions create customers) is rejected, and
Option B (a permanent store of unknown names) is not approved. This text takes effect only when the owner
approves it exactly. Until then layer 3 above stands as written, and the conflict is an OPEN OWNER
DECISION (`REKODA_LAUNCH_READINESS.md`, G-135). The rest of this ADR is unchanged. The implementation and
evidence are in `docs/plans/G-136-conversation-privacy-design.md`.

**Why.** BA-OD-3 (OWN-99) rules that a read never creates a customer. Layer 3 assumed that every name the
model reports is vaulted at once, so that later mentions resolve through layer 1. Since #437, a question
resolves a name by lookup only, and a phone or email nobody recorded stands as a provisional token. So
for a person nobody recorded, nothing is vaulted until a record needs them.

**Rule: four cases.**

1. **A recognised customer** (a name, phone or email already in the business's vault). Unchanged.
   Layer 1 or layer 2 replaces it with its token before any model call, in questions and in records
   alike.
2. **An unknown phone or email.** Layer 2 still replaces it before any model call, but with a provisional
   per-message token (`CUSTOMER_U…`) and no customer. A question names nobody by it. A record finds or
   creates the customer, as layer 2 always did, and carries the stored token.
3. **An unknown name in a read-only question** (`Query`).
   - Nothing is created (BA-OD-3).
   - The reply says the books hold no customer by that name.
   - **The exception:** the name reaches the interpretation model as typed each time a message contains
     it, until the merchant records the person. It is bounded as follows:
     - at most two calls per interpretation attempt (the primary and one escalation), both to
       Anthropic;
     - text read from a photographed document also passes the Anthropic document classifier first;
     - a job that rolls back and is retried makes its attempt again;
     - no other processor, no other intent, and no log line or `usage_events.meta` field.
4. **A name first met in a record** (sale, invoice, payment, order and the other record intents).
   Unchanged. It is vaulted as soon as the command is interpreted (`resolveMention`), before the merchant
   confirms.

**What the history keeps (G-136).** The exception covers what the model reads. It never covers what
Rekoda stores.

- **Conversation history.** `conversation_messages.body` holds only a structural placeholder for every
  model-routed message and every reply (`[text message]`, `[voice note]`, `[receipt photo]`,
  `[customer message]`, `[reply]`). The text lives only in the job's memory while it runs.
- **The webhook body** stays sealed under the vault key in `external_events.payload`. When the merchant
  sends DELETE MY DATA, it is erased for every finished message, along with the identities and any
  conversation text stored before G-136.

**A record's token** must be one this message was issued (G-137). Token syntax is not authority.

**Bounds that do not change:**

- the no-training API terms;
- the approved interpretation processor (Anthropic);
- the observability contract;
- the vault's encryption and audit.

No table, migration or store of unknown names is added.

**Public copy.** `/ai-privacy` currently says: "The first time you mention a new customer by name, the
model reads that one message to understand it. The name is then stored encrypted with its own token,
nothing keeps a readable copy, and every later message that names them is protected before it leaves."

Case 3 contradicts it for questions. This amendment is accepted only together with the owner-approved
replacement in `docs/plans/G-136-conversation-privacy-design.md` §6, applied in the same PR.
