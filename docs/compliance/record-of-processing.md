# Record of processing activities (RoPA) — draft

> **DRAFT — REQUIRES DPCO/LEGAL REVIEW.** The inventory below is
> engineering fact: these categories exist in the schema and flow through
> the cited code. The lawful-basis column is left as counsel's work — a
> lawful basis asserted by a code comment is not a lawful basis.

Controller (draft): the registered entity named on `/privacy` (owner
supplies the CAC facts via environment; see remediation R8). Rekoda's
merchants are themselves controllers of their customers' data in many of
these rows; the exact controller/processor split per row is a **DPCO
determination**.

## Processing inventory

| # | Activity | Data categories | Data subjects | Storage & protection | Retention (published) | Lawful basis |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Merchant account & sign-in | Phone number, OTP challenges, sessions, magic links | Merchants | Postgres, RLS-forced; OTPs peppered+hashed | While the account lives | **DPCO** |
| 2 | Bookkeeping conversations | WhatsApp message text, drafts, AI interpretations (supported identifiers tokenised before any model) | Merchants, their customers when mentioned | Postgres, tenant-pinned; payload vault for message bodies | Chat history 90 days after account close (`RETENTION.conversationDays`) | **DPCO** |
| 3 | Customer records | Names, phone numbers, addresses of merchants' customers | Merchants' customers | AES-256-GCM vault ciphertext + keyed blind index; per-business crypto isolation | Until merchant erasure (`EraseData`) or account deletion | **DPCO** |
| 4 | Financial records | Invoices, receipts, ledger entries, orders, payments | Merchants, their customers | Postgres, RLS-forced, append-only journal | 6 years after year of assessment (`RETENTION.financialYears`) — survives erasure requests, identities stripped | **DPCO** (statutory retention) |
| 5 | Voice-note transcription | Voice audio (transient), transcript text | Merchants | Audio never persisted; transcript enters row 2's lifecycle | Audio: none (transient). Transcript: as row 2 | **DPCO** |
| 6 | Document extraction | Receipt/invoice images, extracted fields | Merchants, counterparties on documents | Image processed via Anthropic only; the high-value OpenAI verifier receives tokenised extracted text, never the image; evidence media purged 90 days after claim resolution (`RETENTION.evidenceRawDays`) | Per retention schedule rows | **DPCO** |
| 7 | Payments & settlement | Payment intents, attempts, charges, settlement components, provider credentials (encrypted) | Merchants, payers | Postgres; provider credentials under `CONNECTION_KEY` | Financial-record retention | **DPCO** |
| 8 | Bank reconciliation | Bank statement lines, transaction descriptions via Mono | Merchants | Postgres, tenant-pinned | Financial-record retention | **DPCO** |
| 9 | Generated documents | Invoice/receipt/statement PDFs and workbooks | Merchants, their customers | R2 primary (a B2 mirror is planned, not yet enabled); no public URLs | Financial-record retention | **DPCO** |
| 10 | Usage & cost telemetry | Token counts, media seconds, model names, correlation ids — no message content | Merchants (indirectly) | Postgres (`usage_events`) | Operational | **DPCO** |
| 11 | Audit trail | Actor, action, entity, counts — never identities in payloads | Merchants | Postgres, append-only | Operational; erasure receipts kept | **DPCO** |
| 12 | Erasure & retention operations | Deletion receipts (`retention_deletions`), privacy correspondence | Merchants | Postgres + owner-held correspondence | Kept as proof the obligation was met | **DPCO** |

## Security measures (summary, engineering-verified)

Tenant isolation by FORCE ROW LEVEL SECURITY with least-privilege roles,
verified at boot (A5); AES-256-GCM identity vault with purpose-bound AAD;
keyed-HMAC blind indexes; tokenisation of supported identifiers before
model prompts; confirmation gates before financial writes; HMAC-verified
webhooks; key fingerprints checked at boot (A6); a CI-run restore drill
(the encrypted offsite backup procedure is defined in
`docs/runbooks/backup-restore.md` and is enabled at production deploy,
not yet evidenced); append-only audit and journal structures.

## What this draft does not claim

No certification, no NDPC filing status (the audit filing fact renders
honestly as "not yet filed" until it exists), no adequacy or transfer
validation — see `data-transfer-assessment.md` for the open questions.
