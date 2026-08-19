# Architecture Decision Records

Every significant decision is recorded here before or with the code that
implements it. ADRs are immutable once **Accepted** — to change course, write
a new ADR that supersedes the old one.

| # | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-typescript.md) | Modular monolith on TypeScript (NestJS + Next.js + Postgres) | Accepted |
| [0002](0002-meta-direct-for-chat.md) | Meta Cloud API direct for Rekoda Chat; Twilio for Integrate WABAs | Superseded by 0011 |
| [0003](0003-paystack-merchant-owned-account.md) | Integrate connects the merchant's own Paystack account (vaulted key) | Proposed |
| [0004](0004-double-entry-ledger-integer-kobo.md) | Double-entry ledger, integer kobo | Accepted |
| [0005](0005-pii-gateway-scope.md) | Privacy gateway: deterministic-first tokenisation, self-hosted STT | Accepted |
| [0006](0006-hosting-hetzner-cloudflare.md) | Hosting: Hetzner + Cloudflare + R2 (no Azure) | Accepted |
| [0007](0007-ai-router-sonnet-default.md) | AI router: deterministic-first, Sonnet as default brain | Accepted |
| [0008](0008-stt-afrispeech-fine-tune.md) | STT baseline is an AfriSpeech-tuned Whisper, not stock Whisper | Accepted |
| [0009](0009-dva-bank-transfer-reconciliation.md) | Dedicated Virtual Accounts turn bank transfers into verified payments | Superseded by 0012 |
| [0010](0010-pitr-backups.md) | Continuous WAL archiving (PITR), not nightly dumps | Accepted |
| [0011](0011-messaging-economics-revised.md) | Messaging economics after Meta's 1 October 2026 change | Accepted |
| [0012](0012-integrate-without-cac.md) | Integrate without CAC: tiered capture and tiered verification | Accepted |
| [0013](0013-rekoda-as-the-single-integration.md) | Rekoda as the single integration: platform-owned Paystack, merchant subaccounts | Proposed |
| [0014](0014-payment-verification-anti-fake-alert.md) | Payment verification as a product: the fake-alert defence | Accepted |
| [0015](0015-full-books.md) | End-to-end books: trial balance, P&L, balance sheet, period close | Accepted |
| [0016](0016-per-transaction-accounts-not-per-customer.md) | Per-transaction transfer accounts, not per-customer DVAs | Accepted |
| [0017](0017-meta-direct-for-integrate-too.md) | Meta-direct for Integrate too; Twilio becomes optional | Accepted (scope narrowed by 0018) |
| [0018](0018-retire-waba-catalogue-capture.md) | Retire the WABA catalogue as an order-capture path | Accepted |
| [0019](0019-paystack-account-model-final.md) | The Paystack model: merchant-owned accounts, Rekoda stays out of the money | Accepted |

Template: [0000-template.md](0000-template.md)
