# Public API versioning

The rules the Rekoda public API keeps for the people building against it.
Canonical spec §27 requires public contracts to be "versioned independently
of the schema"; this document says what that means in practice, and where in
the repository each promise is actually enforced.

## Where a version lives

- **In the URL.** `/api/v1/...`. The version segment is the version. There is
  no header negotiation and no content-type stunt, because both are things a
  proxy can strip and a curl example can forget.
- **In `packages/contracts/src/public/`.** `version.ts` lists the versions
  served and the retirements in flight; `v1/index.ts` is the whole of what v1
  exposes. A schema not exported from that barrel is not part of the contract.
- **Never in `packages/db`.** A boundary rule in `scripts/check-boundaries.mjs`
  refuses any import of `@rekoda/db` or `drizzle-orm` from
  `packages/contracts`, so a table type cannot become a wire type by accident.

## What is a breaking change

A version is a promise about shape. These are **not** breaking, and land in
the version they are made in:

- adding a new route;
- adding an **optional** field to a response;
- adding an optional field to a request;
- adding a new value to a set a client is not expected to switch on
  exhaustively (a new `details` entry, a new route-specific status string
  documented as open).

These **are** breaking, and require a new version:

- removing or renaming any field;
- making an optional request field required;
- changing a field's type, or what it means;
- removing a value from `PUBLIC_ERROR_CODES`, or changing which condition
  produces which code;
- changing a default.

`packages/contracts/src/public/v1/shape.test.ts` holds a written-out
description of every v1 schema and fails when any of it moves. That failure
is the decision point: either the change is additive and the expectation is
updated deliberately, or v1 stays as it is and v2 opens.

## Retiring a version

1. Add a row to `PUBLIC_API_RETIREMENTS` in `version.ts` with `deprecatedAt`
   and `sunsetAt`.
2. Every response on that version then carries `Deprecation` and `Sunset`
   headers, set by the `onSend` hook in `apps/api/src/main.ts`. An integrator
   learns it from traffic they are already sending, not from a post they
   never read.
3. `sunsetAt` is never less than **one year** after `deprecatedAt`. A
   merchant's integration breaking without warning is a merchant's business
   breaking without warning.
4. On the sunset date the version's routes are removed. `/api/<gone>/...`
   then answers `404 unsupported_version`, which names the versions that are
   still served.

## Errors

Every public failure is `{ "error": { "code", "message", ... } }`. `code` is
the closed set in `PUBLIC_ERROR_CODES` and is the only part a client should
branch on; `message` is prose for a human reading a log and may be reworded
at any time. `rate_limited` also carries `retryAfterSeconds`, mirrored on the
standard `Retry-After` header.

The mapping lives in `apps/api/src/api/public/public-api.filter.ts`, and the
per-IP limiter in `main.ts` answers in the same envelope, so a client never
meets two different bodies for the same refusal.

## Response headers

| Header | Meaning |
| --- | --- |
| `Rekoda-Api-Version` | The version that answered. Present on success and on every failure. |
| `Retry-After` | Seconds to wait, on `429`. |
| `Deprecation` | Set when the version has a retirement date. |
| `Sunset` | When the version stops answering. |
