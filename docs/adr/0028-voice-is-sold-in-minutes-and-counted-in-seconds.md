# ADR 0028 — Voice is sold in minutes and counted in seconds

**Status**: accepted
**Date**: 26 August 2026
**Supersedes**: nothing. Amends the unit definition ADR 0024 records commercially.

## Context

The canonical specification (§4.2) names the metered unit `VOICE_MINUTES`.
The pricing page sells "60 voice minutes a month". The meter column,
`usage_counters.used`, is an integer.

Those three facts do not compose. A voice note is not a whole number of
minutes. Metering in whole minutes means rounding, and rounding up is the
only safe direction for a counter that must never let a merchant overspend.
A merchant on the Chat plan sending twenty-second voice notes would get
sixty of them against a sixty-minute allowance, when the minutes they bought
are worth a hundred and eighty. Rounding down is worse: it gives away
transcription that Rekoda pays for by the minute.

## Decision

The unit is sold in minutes and counted in seconds.

- `PLAN_ALLOWANCES` holds the figure the pricing page quotes: 60 for Chat,
  120 for Complete, 10 on trial.
- `UNIT_SCALE` holds the ratio, 60 for `VOICE_MINUTES` and 1 for every other
  unit.
- `allowanceFor` multiplies, so every consume site is handed a ceiling in the
  same units the column counts in.
- `usage_counters.used` holds seconds. A 137-second voice note spends 137.

The unit keeps the canonical name. `VOICE_SECONDS` would have been an easier
column to read and a worse product: the merchant buys minutes, the refusal
reply and the dashboard are written for a merchant, and the specification
names the unit the merchant's word.

## Consequences

The dashboard and the billing API report voice in seconds, labelled "seconds
of voice notes", because that is the resolution the meter has. A merchant who
wants the round number reads it on the pricing page.

Anything reading `PLAN_ALLOWANCES` directly gets minutes; anything calling
`allowanceFor` gets seconds. That asymmetry is the cost of keeping one table
readable against the pricing page, and it is pinned in both directions by
test rather than left to a comment.

Adding an eighteenth unit forces a `UNIT_SCALE` entry, because the record is
exhaustive rather than defaulted. A unit that arrives without a decision
about how it is counted will not compile.

## Alternatives rejected

**Rename the unit `VOICE_SECONDS`.** Contradicts spec §4.2, which is frozen,
and puts a column name in front of a merchant.

**Store a decimal.** The counter's whole reason for existing is the atomic
check-and-increment; a numeric column works, but every other unit is a count
and one decimal column would invite rounding questions at every read.

**Round each note up to the next minute.** Charges a merchant three times
what they bought for short notes. This is the alternative the decision
exists to refuse.
