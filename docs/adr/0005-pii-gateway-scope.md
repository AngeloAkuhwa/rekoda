# 0005 — Privacy gateway: deterministic-first tokenisation, self-hosted STT

**Status:** Accepted, amended by Amendment 1 (accepted 21 Nov 2026, OWN-100) for names in read-only questions, and its case 4 ratified as the record-intent exception to spec C.3 (OWN-106, 25 Nov 2026); the self-hosted STT portion is **superseded by [0032](0032-launch-media-architecture.md)** (2026-08-29) — the launch transcriber is OpenAI, and no self-hosted STT service exists. The tokenisation gateway this ADR designed is unchanged and current.
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

## Amendment 1 (ACCEPTED 21 Nov 2026, owner ruling OWN-100): names in questions, and what the history keeps

**Precedence (owner ruling OWN-102(5), 22 Nov 2026):** case 3 below is an explicit exception to the
canonical spec's Appendix C.3, for the read-only unknown-name question only and to the Anthropic
interpretation processor only. It does not extend to OpenAI, any other provider, the high-value
document verifier, general customer extraction, logs, telemetry, any identity store or any other
message. Appendix C.3 carries a pointer to this amendment.

**Precedence for records (owner ruling OWN-106, 25 Nov 2026, OD-73 Option A):** case 4 below is the second explicit exception to the canonical spec's Appendix C.3, which carries a pointer to it. For a record intent (a sale, invoice, payment, order or other record request), a customer name nobody has recorded, typed for the first time, may reach the approved Anthropic interpretation processor as typed when needed to interpret that request, and only until Rekoda can tokenise it: the command vaults the name (`resolveMention`), so later messages name the customer by token. The limits of case 3 apply: at most the primary call and one escalation per attempt, Anthropic only (no OpenAI call, not the high-value document verifier, no other provider), no log line or telemetry field carrying the name, no new identity store, no wider storage, no reuse for an unrelated purpose and no general disclosure. Known identities (a recorded name, phone or email) and structural personal data (phones, emails and supported financial identifiers, recorded or not) are tokenised before any model call, as before.

**Processors (owner ruling OWN-103(5), 22 Nov 2026):** For a read-only question (`Query`) naming a customer nobody has recorded, the approved Anthropic document classifier may process text read from a photographed document as needed to classify it, and the approved Anthropic interpretation processor may interpret the question, within ADR 0005 Amendment 1's limits; this authorises no OpenAI call (the high-value document verifier included), no other provider, no logging of the name, no wider storage of personal data and no reuse for an unrelated purpose.

**Status: ACCEPTED** by the owner on 21 Nov 2026 (OWN-100, `REKODA_OWNER_DECISIONS.md`), on PR #437
(G-135). Proposed 20 Nov 2026 after CodeRabbit raised the conflict on #437; the owner chose the narrowed
Option A. Option C (questions create customers) is rejected, and Option B (a permanent store of unknown
names) is not approved. Layer 3 above is kept as it was accepted on 2026-08-19 and is history for the
case this amendment covers: from this amendment on, an unknown name in a read-only question is governed
by case 3 below, not by "reaches the LLM once". Every other part of this ADR is unchanged. The
implementation and evidence are in `docs/plans/G-136-conversation-privacy-design.md`.

**Why.** BA-OD-3 (OWN-99) rules that a read never creates a customer. Layer 3 assumed that every name the
model reports is vaulted at once, so that later mentions resolve through layer 1. Since #437, a question
resolves a name by lookup only, and a phone or email nobody recorded stands as a provisional token. So
for a person nobody recorded, nothing is vaulted until a record needs them.

**Rule: five cases.**

1. **A recognised customer** (a name, phone or email already in the business's vault). Unchanged.
   Layer 1 or layer 2 replaces it with its token before any model call, in questions and in records
   alike.
2. **An unknown phone or email.** Layer 2 still replaces it before any model call, but with a provisional
   per-message token (`CUSTOMER_U…`) and no customer. A question names nobody by it. It becomes a
   customer only as the `customer` of a sale, payment or order (found or created, as layer 2 always did,
   and the record carries the stored token), or as the second facet beside that customer that PR #77's
   owner rule asks about in the preview. Anywhere else in a record's words it is kept as `[phone]` or
   `[email]`, and creates nobody (owner review of #437 at `3a60b0f`).
3. **An unknown name in a read-only question** (`Query`).
   - Nothing is created (BA-OD-3).
   - The reply says the books hold no customer by that name.
   - **The exception:** the name reaches the interpretation model as typed each time a message contains
     it, until the merchant records the person. It is bounded as follows:
     - at most two calls per interpretation attempt (the primary and one escalation), both to
       Anthropic;
     - text read from a photographed document also passes the Anthropic document classifier first;
     - a job that rolls back and is retried makes its attempt again;
     - no other processor, no other intent, and no log line or `usage_events.meta` field;
     - it adds no disclosure to any other provider and no new store of identities, and the
       retention, erasure and access controls that apply to every message apply to these.
4. **A name first met in a record** (sale, invoice, payment, order and the other record intents).
   Unchanged. It reaches the approved Anthropic interpreter as typed, once, and is vaulted as soon as the
   command is interpreted (`resolveMention`), before the merchant confirms, so later messages name the
   customer by token. Ratified as an exception to spec C.3 by OWN-106 (OD-73 Option A), under case 3's
   limits; a phone or email beside the name is tokenised first, as in case 2.
5. **A correction (CG5) that names nobody** ("No, 4 not 3"). The model reads it from its own words and
   never sees an earlier turn. The customer is carried from the trusted pending draft it corrects, by
   Rekoda and never by the model: that draft must be the merchant's own, the only one waiting, live,
   previewed, of the same kind, with no refusal or question since. A token the model writes is still
   refused (G-137 below). Anything less clear is asked about (owner ruling OWN-100).

**What the history keeps (G-136).** The exception covers what the model reads. It never covers what
Rekoda stores.

- **Conversation history.** `conversation_messages.body` holds only a structural placeholder for every
  model-routed message, every chat reply and every message to a customer (`[text message]`,
  `[voice note]`, `[receipt photo]`, `[customer message]`, `[reply]`). Template sends and document
  deliveries keep their existing bodies, a template name or a document caption (its number and amount),
  which name no person. The raw conversation body lives only in the job's memory while it runs and is never
  stored here. That is a statement about conversation bodies only: structured business records a confirmed
  message produces keep what the merchant authored, such as an expense or item description ("fuel for
  Emeka's car"), and customers are kept as vaulted identities and tokens. Those are financial data, outside
  G-136, and Rekoda does not promise that no text of any kind is retained.
- **The webhook body** stays sealed under the vault key in `external_events.payload`. When the merchant
  sends DELETE MY DATA, it is erased for every message Rekoda has finished processing, whatever outcome
  its handler noted, along with the identities and any conversation text stored before G-136. Messages
  not yet processed, delivery-status events and events with no business keep their sealed bodies. Each
  event seals only its own message; a row stored before #437 may still hold a body Meta batched with
  another business's message, which that business's erasure does not reach.

**A record's token** must be one this message was issued (G-137). Token syntax is not authority: a
record whose `customer` is any other token is refused, and any other customer token in a record's words
reads `[customer]`.

**Bounds that do not change:**

- the no-training API terms;
- the approved interpretation processor (Anthropic);
- the observability contract;
- the vault's encryption and audit;
- two-ask erasure of vault identities.

No table, migration or store of unknown names is added.

**Public copy.** `/ai-privacy` said: "The first time you mention a new customer by name, the model reads
that one message to understand it. The name is then stored encrypted with its own token, nothing keeps a
readable copy, and every later message that names them is protected before it leaves." Case 3
contradicted it for questions, so the owner approved the replacement (OWN-100) and it is applied in
PR #437 together with this amendment (`apps/web/src/app/ai-privacy/page.tsx`; the claims are mapped to
code and tests in `docs/plans/G-136-conversation-privacy-design.md` §6.1).
