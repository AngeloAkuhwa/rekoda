# 0024 — The commercial terms, decided

**Status:** Accepted
**Date:** 2026-08-21
**Decided by:** Angelo Akuhwa

## Context

M4, self-service billing, has been buildable for some time. It was blocked on
terms nobody had written down: what a mid-cycle upgrade costs, whether money
comes back, how long a failed card gets, and what a merchant may still see
after they stop paying.

Those are commercial and legal questions rather than engineering ones, and
they were deliberately left unanswered rather than guessed at. This ADR
records the answers so they live in the repository instead of in a chat log.
A price that exists only in prose is how `0023` came to cite a subscription
figure that was never real.

Two related decisions about privacy are recorded here too, because they set
the shape of features that have not been built yet and would otherwise be
decided by whoever writes the first line of them.

## Decisions

### Billing

**Upgrades prorate; downgrades wait.** A merchant moving up mid-cycle pays the
prorated difference immediately and keeps their existing renewal date. Chat to
Complete on day 12 of a 30-day cycle is ₦20,000 × 19/30 = ₦12,666.67, and
Complete unlocks at once.

A downgrade takes effect at the next renewal. No negative credits, no
balance to carry: the merchant keeps what they paid for until it runs out.
This is the arrangement a merchant can predict without doing arithmetic.

**Add-on packs are one-off and do not roll over.** Messages, voice minutes,
document generations and Integrate capacity are consumables bought for the
current month. An extra accountant or delegate seat is different in kind and
stays a recurring monthly charge, because it is a standing capability rather
than a quantity consumed.

Rollover is deliberately not offered at launch. It can be revisited once
there is real merchant behaviour to look at; until then it is a source of
metering bugs in the one subsystem that must never be wrong.

**A failed payment gets seven days.** Reminders on day 1 and day 5, then paid
functionality stops and the account becomes read-only. Nothing is deleted.

### What a merchant keeps

**An expired paid account becomes read-only, not closed.** They can open the
dashboard, read their books and export CSV, PDF and Excel. This already holds
in code: `expired` gates chat writes and consumes no allowance, and the
reporting endpoints never check the plan.

Access is preserved under a **published retention schedule** rather than
promised indefinitely. Two things pull against each other here and the
schedule is where they meet: Nigerian tax administration expects business
books to be retained for a period after the relevant year of assessment,
while the NDP Act's storage-limitation principle says personal data should
not be kept longer than its purpose requires. "Forever" satisfies the first
and violates the second.

**A trial that ends becomes read-only too, then is deleted on a schedule.**
Roughly 90 days to inspect, export or subscribe, with warnings before
deletion. Neither locking somebody out of their own records on day 31 nor
storing abandoned trial data forever is defensible.

### Refunds

Not "all payments are non-refundable". That is hostile to exactly the
merchants this product exists for, and Nigeria's consumer-protection
framework emphasises fair dealing and remedies where a paid-for service is
not delivered.

| Situation                                          | Outcome                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Voluntary cancellation                             | Stops the next renewal. The paid period remains usable. No automatic prorated cash refund. |
| Duplicate or incorrect charge                      | Full refund of the incorrect charge.                                                       |
| Material Rekoda service failure we cannot remedy   | Full or prorated refund as appropriate.                                                    |
| Add-on pack, completely unused, within 7 days      | Refundable.                                                                                |
| Add-on pack, partly consumed                       | Not refundable.                                                                            |
| Suspension for a genuine merchant policy violation | No refund entitlement from the suspension itself, subject to applicable law.               |
| Suspension caused by a Rekoda mistake              | Access restored, refund or compensation as appropriate.                                    |

The `/refund` page states this in the merchant's own terms, and the final
wording is for a Nigerian lawyer to review before it is treated as binding.

### Privacy boundaries for features not yet built

**Receipt photographs never reach an external model.** The pipeline is:

```
receipt photo -> self-hosted OCR -> PII tokenisation -> sanitized text -> model
```

The privacy gateway tokenises text and cannot tokenise an image, so sending a
photograph to a model provider would put a customer's name, phone and address
in front of a third party intact. Running OCR first inside infrastructure we
control produces exactly the input type the gateway already knows how to
protect, and it does so without needing a self-hosted vision model.

**There is no raw-image fallback.** Not when OCR is slow, not when it is
down, not when a merchant's photograph is hard to read. A privacy boundary
that acquires an exception the first time it is inconvenient was never a
boundary. If visual layout ever matters, the route is OCR bounding boxes,
redact the regions holding PII, then send the redacted image.

**Speech-to-text runs on infrastructure we control before voice is public.**
This confirms rather than creates a decision: ADR 0008 already chose a
self-hosted AfriSpeech-tuned model on the existing server, and
`docs/pricing-model.md` costs the plans on the assumption of no per-minute
transcription fee. What is missing is the deployment. `/ai-privacy` already
tells merchants that speech becomes text on our own infrastructure, and
`STT_URL` is unset, so today that sentence describes an intention. Either it
becomes true or the sentence goes; it must not ship as written while untrue.

**Voice is benchmarked before launch,** against 30 to 50 or more real
Nigerian voice notes spanning male and female voices, Lagos and non-Lagos
accents, noisy shop and outdoor recordings, code-switching, Nigerian product
and business names, and spoken amounts. The metric that matters is not word
accuracy but whether the financial instruction was extracted correctly: a
transcript with a wrong word is fine if the sale, the amount received and the
receivable all come out right.

### Scope

**Report generation is not capped.** The PDF and Excel exports cost compute
and cost no provider a naira. `docs/pricing-model.md` previously advertised 10
reports on Chat and 50 on Complete, which nothing ever metered; the numbers
are removed rather than implemented. Metering the one behaviour we most want
merchants to develop would be charging them to look at their own accounts.

**`documents_understood` and `orders` allowances stay, unadvertised.** Both
exist with nothing consuming them. They are kept pending the M5
re-specification and stay out of public pricing until a shipped feature
actually consumes them.

**M5 Integrate is deferred from launch.** It was partly superseded by ADR
0018 and needs re-specifying against real merchant usage. When it resumes,
the priority is ingesting and reconciling EXTERNAL orders rather than
building a native catalogue and storefront: the product is a bookkeeper, and
turning it into commerce software before the bookkeeping is validated would
blur what it is.

**Paystack production activation stays gated.** `REKODA_PAYSTACK_PLATFORM_CONFIRMED`
is set only after live account verification is complete, credentials are
secured, webhook verification is confirmed, the refund policy is published,
and one controlled live transaction has succeeded. Spec §47 stands.

## Consequences

M4 is unblocked and specified. The `/refund` page is writable as soon as the
registered entity name, business address and support address are supplied.

Receipt OCR and self-hosted speech-to-text both need infrastructure that does
not exist yet, so both are built behind a port the way `SpeechToText` already
is: the pipeline and its tests can land before the service does, and neither
feature turns on until a URL is configured.

The retention schedule is now a thing that must be written and published, not
merely an intention. Until it exists, no page should state a retention period.
