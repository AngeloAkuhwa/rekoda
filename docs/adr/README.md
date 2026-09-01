# Architecture Decision Records

Every significant decision is recorded here before or with the code that
implements it. ADRs are immutable once **Accepted** — to change course, write
a new ADR that supersedes the old one.

| #                                                         | Title                                                                           | Status                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| [0001](0001-modular-monolith-typescript.md)               | Modular monolith on TypeScript (NestJS + Next.js + Postgres)                    | Accepted                          |
| [0002](0002-meta-direct-for-chat.md)                      | Meta Cloud API direct for Rekoda Chat; Twilio for Integrate WABAs               | Superseded by 0011                |
| [0003](0003-paystack-merchant-owned-account.md)           | Integrate connects the merchant's own Paystack account (vaulted key)            | Accepted (reinstated by 0019)     |
| [0004](0004-double-entry-ledger-integer-kobo.md)          | Double-entry ledger, integer kobo                                               | Accepted                          |
| [0005](0005-pii-gateway-scope.md)                         | Privacy gateway: deterministic-first tokenisation, self-hosted STT              | Accepted; STT portion superseded by 0032 |
| [0006](0006-hosting-hetzner-cloudflare.md)                | Hosting: Hetzner + Cloudflare + R2 (no Azure)                                   | Accepted                          |
| [0007](0007-ai-router-sonnet-default.md)                  | AI router: deterministic-first, Sonnet as default brain                         | Accepted (default model superseded by 0023, then 0031) |
| [0008](0008-stt-afrispeech-fine-tune.md)                  | STT baseline is an AfriSpeech-tuned Whisper, not stock Whisper                  | Superseded by 0032                |
| [0009](0009-dva-bank-transfer-reconciliation.md)          | Dedicated Virtual Accounts turn bank transfers into verified payments           | Superseded by 0012                |
| [0010](0010-pitr-backups.md)                              | Continuous WAL archiving (PITR), not nightly dumps                              | Accepted                          |
| [0011](0011-messaging-economics-revised.md)               | Messaging economics after Meta's 1 October 2026 change                          | Accepted                          |
| [0012](0012-integrate-without-cac.md)                     | Integrate without CAC: tiered capture and tiered verification                   | Accepted                          |
| [0013](0013-rekoda-as-the-single-integration.md)          | Rekoda as the single integration: platform-owned Paystack, merchant subaccounts | Proposed                          |
| [0014](0014-payment-verification-anti-fake-alert.md)      | Payment verification as a product: the fake-alert defence                       | Accepted                          |
| [0015](0015-full-books.md)                                | End-to-end books: trial balance, P&L, balance sheet, period close               | Accepted                          |
| [0016](0016-per-transaction-accounts-not-per-customer.md) | Per-transaction transfer accounts, not per-customer DVAs                        | Accepted                          |
| [0017](0017-meta-direct-for-integrate-too.md)             | Meta-direct for Integrate too; Twilio becomes optional                          | Accepted (scope narrowed by 0018) |
| [0018](0018-retire-waba-catalogue-capture.md)             | Retire the WABA catalogue as an order-capture path                              | Accepted                          |
| [0019](0019-paystack-account-model-final.md)              | The Paystack model: merchant-owned accounts, Rekoda stays out of the money      | Accepted                          |
| [0020](0020-identity-persistence-and-the-setup-grant.md)  | Identity persistence: the setup grant, and a second pin for the bootstrap read  | Accepted                          |
| [0021](0021-privacy-gateway-implementation.md)            | The privacy gateway: what leaves, what stays, and where the seams are           | Accepted                          |
| [0022](0022-job-queue-in-our-own-schema.md)               | The job queue lives in our schema, and claiming it is a role                    | Accepted                          |
| [0023](0023-haiku-reads-the-message.md)                   | Haiku reads the message                                                         | Accepted (interpreter model superseded by 0031) |
| [0024](0024-the-commercial-terms.md)                      | The commercial terms                                                            | Accepted (report-cap clause superseded in part, 2026-08-28) |
| [0025](0025-bank-account-split.md)                        | The merchant's own bank account, separate from settlements                      | Accepted (amends 0004)            |
| [0026](0026-fixed-assets.md)                              | A generator is an asset, not a month's expense                                  | Accepted (amends 0004)            |
| [0027](0027-hosted-ai-at-launch.md)                       | Hosted AI at launch, and the privacy pages tell the truth about it              | Accepted (amends 0008, 0024; amended by 0032) |
| [0031](0031-sonnet-reads-the-message.md)                  | Sonnet reads the message                                                        | Accepted (amends 0023)            |
| [0032](0032-launch-media-architecture.md)                 | The launch media architecture: OpenAI STT + Claude vision, no sidecars          | Accepted (amends 0005, 0008, 0024, 0027) |
| [0033](0033-multicurrency-is-a-dark-capability.md)        | Multicurrency and embedded FX are a dark capability; the launch is NGN-only     | Accepted                          |

Template: [0000-template.md](0000-template.md)
