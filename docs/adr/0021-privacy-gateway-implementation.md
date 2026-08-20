# 0021 — The privacy gateway: what leaves, what stays, and where the seams are

**Status:** Accepted
**Date:** 19 August 2026
**Implements:** [0005](0005-pii-gateway-scope.md) · spec §5–8 · MASTER-PLAN §5.3.2

## Context

ADR 0005 set the scope: customer identity is replaced by tokens before
anything reaches a model. This records the decisions made building it, because
several were not obvious and one of them is a deliberate gap.

## Decision 1 — the match key mixes in the business id

Recognising a returning customer needs a deterministic value to look up. A
plain `sha256(phone)` is useless for this: a Nigerian mobile number has roughly
10^10 possibilities, so a leaked table is reversible by exhaustive search in
seconds. It is a keyed HMAC under a secret held outside the database.

Less obviously, the business id goes into the HMAC input. Without it the same
phone yields the same match key everywhere, and a dump reveals **which
merchants share a customer** — a correlation nobody consented to, and free to
prevent. The input is length-prefixed so `('ab','c')` and `('a','bc')` cannot
collide into one key for two different people.

## Decision 2 — a fresh IV per encryption, and no exceptions

Every facet is AES-256-GCM under a random 12-byte IV. There is no counter and
no cache, because the only safe IV is one nobody has planned: reusing one under
the same key in GCM leaks the XOR of two plaintexts and can expose the
authentication subkey.

It also matters that ciphertext is non-deterministic. If encrypting the same
name twice produced the same bytes, anyone holding the table could tell which
customers share a name or a number without decrypting anything at all.

Decryption failure is deliberately opaque: "wrong key" and "tampered
ciphertext" return the identical message, because which one it was is
information an attacker wants and an operator does not need.

## Decision 3 — the structural pass is conservative about bare digits

Two failure modes, and they are not symmetric:

- A phone number that survives into a prompt is a **privacy failure**.
- An amount wrongly tokenised is a **broken invoice** — the model loses the one
  thing it was sent to read.

So phones and emails are matched on distinctive shapes and always tokenised.
Ten-digit runs are **not**, unless an account keyword sits beside them: a NUBAN
account number and a plausible naira figure are both exactly ten digits, and
matching bare runs would turn ₦1,234,567,890 into a token.

**This is a real gap:** an account number typed with no surrounding context
survives the structural pass. It is accepted because the layers after it
(known-customer matching, then minimisation) exist, and because the alternative
breaks every large invoice. It is written down here so that it is a decision
rather than an oversight, and so the next person can close it deliberately.

## Decision 4 — the dangerous functions do not share a spelling with the safe ones

`rehydrate` and `decryptFacet` are the two functions that can undo the gateway.
Neither is re-exported from the `@rekoda/core` barrel that every component
already imports; both need an explicit `@rekoda/core/vault` or
`@rekoda/core/privacy` path.

The point is reviewability. If the safest import and the most dangerous one
looked identical, "why does this file import that?" would never get asked.

## Decision 5 — one row per facet

Identities are stored one row per facet — name, phone, email, address — rather
than as a single encrypted blob. "Forget my address but keep the invoices" is a
request `/data-deletion` promises to honour, and it is only cheap if a facet
can be deleted on its own.

## Consequences

- `packages/db` stores ciphertext it cannot read, and holds no key. The crypto
  is pure functions in `@rekoda/core`, tested against tampering and key
  substitution; the API layer is the only place they meet.
- Recognition survives the five ways a Nigerian number gets typed, proven
  against a real database rather than asserted.
- A leaked `customer_identities` table yields no names, no numbers, and no
  cross-business linkage — tested by reading the raw table as the owner and
  asserting the plaintext is absent.
- `redactForLog` exists as a last line of defence for stack traces and error
  messages, which never pass through the gateway at all.
