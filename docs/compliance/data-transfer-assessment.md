# Cross-border data transfer assessment — draft

> **DRAFT — REQUIRES DPCO/LEGAL REVIEW.** This document maps where data
> factually leaves Nigeria. It deliberately reaches NO conclusion about
> whether any transfer mechanism satisfies Nigerian data-protection law:
> no mechanism has been legally validated, and this draft must not be
> cited as if one had been.

## The factual transfer map

| Destination | Provider | What crosses the border | Trigger |
| --- | --- | --- | --- |
| United States (hosted API) | Anthropic | Tokenised message text; raw document/receipt images when image AI is enabled | Every AI interpretation; document extraction |
| United States (hosted API) | OpenAI | Raw voice-note audio (transient); for high-value dual extraction, tokenised extracted document text (never the image) | Voice transcription; dual-extraction verifier |
| Meta global infrastructure | Meta | All WhatsApp traffic (the channel itself) | Every message |
| Germany (EU) | Hetzner | The entire estate at rest (server, database, snapshots) | Hosting (ADR 0006) |
| Cloudflare global network | Cloudflare | Site traffic via proxy; generated documents in R2 | Serving the site; document storage |
| United States | Backblaze | PLANNED, not yet enabled: mirror copies of generated documents (B2). No implementation exists in the repository yet; listed so the transfer is assessed before it starts | Backup lifecycle (planned) |
| Nigeria (domestic) | Paystack, OPay, Kuda, Mono | Payment and bank data | Payments, reconciliation — **not cross-border**, listed for completeness |

## Open legal questions (for the DPCO, not engineering)

1. Which instrument governs each transfer above under the NDPA and the
   NDPC's implementation framework: adequacy, contractual clauses,
   consent, or another basis. **No answer is assumed here.**
2. Whether the providers' standard terms (Anthropic commercial terms,
   OpenAI API terms, Meta's WhatsApp Business terms, Cloudflare/Hetzner/
   Backblaze DPAs) constitute adequate safeguards, and whether signed
   DPAs exist for each. Engineering has not verified contract status.
3. Whether the public disclosures (`/privacy`, `/ai-privacy`) satisfy the
   transparency requirements for these transfers. The pages already name
   Anthropic and OpenAI and describe hosted processing plainly (R1-R4);
   sufficiency is counsel's call.
4. Whether merchant consent flows are needed for the AI media features
   beyond the current opt-in flags, given the data subjects include the
   merchants' own customers.

## Engineering mitigations already in place (facts, not a legal position)

- Supported identifiers (structural phone numbers, email addresses,
  financial account numbers, and customer names already known to the
  vault) are tokenised before message text reaches any model; the vault
  plaintext never travels. This is not a guarantee that every possible
  piece of personal data in free text is detected.
- Voice audio is transient end to end: never persisted, never logged,
  discarded after transcription.
- Both AI features are off by default and fail closed: enabling a flag
  without its provider key refuses to boot.
- Media spend and volume are hard-ceilinged per business and platform-wide
  per day, bounding the volume of data that CAN flow in a runaway day.
- Backups crossing providers are encrypted with `BACKUP_PASSPHRASE`
  before leaving the box.
