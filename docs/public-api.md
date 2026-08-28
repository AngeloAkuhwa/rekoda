# The Rekoda API

The developer reference for `/api/v1`. Everything here is what the code does;
where the two ever disagree, the code is right and this page is a bug.

The API is a **separate commercial entitlement** (canonical spec §27). It is
not included with Chat, Integrate or Complete: a business holds `REKODA_API`
because it was granted, and holds capacity because it was bought.

## Getting a key

Keys are minted from the dashboard, by the **owner** of the business.

```
POST /v1/api-keys/applications      { "name": "Storefront sync" }
POST /v1/api-keys/applications/:id/keys   { "label": "server", "mode": "live" }
```

The mint response carries the token **once**. Rekoda stores a SHA-256 of it
and cannot show it again; a lost key is replaced by minting another and
revoking the old one.

```
POST /v1/api-keys/keys/:id/revoke
```

Five live keys per application per mode, which is headroom over the one
operation that needs more than one: a rotation, where the new key works
before the old one dies.

### Live and test

A key is `rk_live_…` or `rk_test_…`, and the prefix is the mode.

A **test key resolves to the same business and reads the same books**. It
cannot write: every write answers `403 forbidden` with a message saying so.
That is the whole sandbox — you prove your authentication, your paging, your
signature verification and your error handling against real shapes, and you
cannot post a sale into a real ledger while doing it.

Sandbox calls do **not** spend `API_REQUEST_UNITS`. They are still subject to
the per-key rate limit.

## Calling

```
GET /api/v1/identity
Authorization: Bearer rk_live_1c6ef0e5_…
```

`identity` is the route to call first: it answers with the business your key
speaks for, the application it belongs to, its mode and its rate limit. A key
pasted into the wrong environment fails here rather than in a write.

Every response carries `Rekoda-Api-Version: v1`, on success and on failure.

### Routes

| Route | What it does |
| --- | --- |
| `GET /api/v1/identity` | Who this key speaks for |
| `GET /api/v1/customers` | The merchant's customers, as pseudonyms |
| `GET /api/v1/products` | The catalogue |
| `GET /api/v1/invoices` | Invoices, newest first; `?status=` narrows |
| `GET /api/v1/invoices/:invoiceNumber` | One invoice |
| `POST /api/v1/sales` | Record a sale (live keys only) |
| `POST /api/v1/payments` | Record a payment against an invoice (live keys only) |

A **customer is a pseudonym**. Names, phones and addresses live encrypted in
Rekoda's identity vault, one facet per row, and no route here exposes them.
If you need to reach a customer, the merchant reaches them.

### Money

Every amount is **integer kobo**. `unitPriceK: 4_500_000` is ₦45,000. There
are no decimals anywhere in this API, in either direction.

Totals are computed from your lines. A sale you send with items totalling
₦100,300 records ₦100,300; there is no field in which to state a different
total, because a merchant's books must not carry whichever figure the caller
preferred.

### Paging

Lists answer `{ "items": [...], "nextCursor": "..." }`. Pass the cursor back
as `?cursor=`; `nextCursor: null` means the end. `?limit=` is 1 to 100,
default 25.

The cursor is opaque and keyset-based, so a table being written to while you
walk it will not show you a row twice or skip one. A cursor this API did not
issue is refused rather than silently treated as "start again".

### Idempotency

Both writes accept an `Idempotency-Key` header. A retry with the same key
answers the first result rather than recording a second sale:

```
POST /api/v1/sales
Idempotency-Key: order-4471
```

Use your own identifier for the thing you are recording. A key reused for a
*different* request body is refused, because that is a bug in the caller and
a silent second sale is worse than an error.

## Errors

Every failure is:

```json
{ "error": { "code": "invalid_request", "message": "items: Too small", "details": [] } }
```

Branch on `code`. Never match on `message`: it is prose for a human reading a
log and may be reworded at any time.

| Code | Status | What to do |
| --- | --- | --- |
| `unauthenticated` | 401 | The key is missing, malformed, revoked, expired, or its application is disabled. Rekoda does not say which. |
| `not_entitled` | 403 | The business does not hold `REKODA_API`. |
| `forbidden` | 403 | This key may not do this. A test key attempting a write is the common case. |
| `invalid_request` | 400 | The body or a query parameter is wrong. `message` says which field. |
| `not_found` | 404 | No such thing, or nothing this key may see. |
| `rate_limited` | 429 | The per-minute ceiling. Wait `retryAfterSeconds` and retry. |
| `quota_exhausted` | 429 | The month's capacity is spent. Waiting will not help; buy more. |
| `unsupported_version` | 404 | The version segment in the URL is not one Rekoda serves. |
| `internal` | 500 | Ours. Retry; if it persists, tell us. |

## Webhooks

Register an endpoint from the dashboard:

```
POST /v1/webhooks   { "url": "https://yours.example/hooks/rekoda",
                      "eventTypes": ["sale.recorded", "payment.recorded"] }
```

An **empty** `eventTypes` means every type. The response carries the signing
secret once.

Deliveries are `POST`ed as:

```json
{
  "id": "…",
  "type": "sale.recorded",
  "businessId": "…",
  "occurredAt": "2026-08-28T09:00:00.000Z",
  "attempt": 1,
  "data": { "invoiceNumber": "INV-2026-000007" }
}
```

with headers `Rekoda-Signature`, `Rekoda-Event-Type` and
`Rekoda-Delivery-Id`.

### Verifying a delivery

The signature is `t=<unix seconds>,v1=<hex hmac-sha256>` over
`` `${t}.${rawBody}` ``. **Two checks, and both matter**: the digest must
match, and the timestamp must be recent. A verifier that skips the second
accepts a replay of a real, correctly signed delivery forever.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, header, secret, windowSeconds = 300) {
  const parts = new Map(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number(parts.get('t'));
  const presented = parts.get('v1');
  if (!Number.isFinite(t) || !presented) return false;

  if (Math.abs(Math.floor(Date.now() / 1000) - t) > windowSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Sign the **raw body bytes**, not a re-serialisation: `JSON.parse` followed by
`JSON.stringify` moves key order, whitespace and unicode escaping, and the
HMAC then fails for every legitimate delivery.

### Retries

Answer `2xx` promptly. Anything else is a failure, and Rekoda retries at
1 minute, 5, 25, 2 hours, 10 hours and 24 hours before the delivery is marked
dead. Dead deliveries stay visible in the merchant's dashboard; they are
never silently dropped.

Redirects are **not** followed — a `3xx` is recorded as a failure.

Deliveries are at-least-once. Make your handler idempotent on `id`.

### Rotating a secret

```
POST /v1/webhooks/:id/rotate
```

The new secret takes effect immediately and the old one stops verifying.
There is no grace window with two live secrets: a rotation is what somebody
does when they believe the old secret leaked, and a window where the leaked
one still works is the opposite of what they asked for.

## Versioning

See `docs/public-api-versioning.md`. In short: the version is in the URL,
additive changes land in `v1`, breaking changes open `v2`, and a retired
version carries `Deprecation` and `Sunset` headers for at least a year before
it stops answering.

## Limits

| Limit | Value |
| --- | --- |
| Requests per key per minute | 120 |
| Live keys per application per mode | 5 |
| Page size | 100 |
| Items per sale | 50 |
| Webhook attempts | 6 |
| Webhook timeout | 10 seconds |

Monthly capacity (`API_REQUEST_UNITS`, `API_APPLICATIONS`,
`WEBHOOK_DELIVERIES`) is what the business bought with the API product, and
is visible on their billing page.
