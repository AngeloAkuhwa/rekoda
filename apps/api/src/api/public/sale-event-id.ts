/**
 * Which financial event a public API sale is (G-77).
 *
 * Two identities travel with an API write and must not be confused:
 *
 *   - the APPLICATION that asked: who. It stays in the actor
 *     (`api:<keyPrefix>`; a key prefix is unique and names its application,
 *     and key rows are never deleted), on the audit row and the verification;
 *   - the EVENT: which sale this is. It is the sale's `sourceId`, and a paid
 *     sale's MERCHANT_ATTESTED verification claims `api:<sourceId>`
 *     (`issueSale`), which is unique per business.
 *
 * The route used the application id as the event, so every paid sale after
 * the first from one application collided with that claim and failed.
 *
 * With an Idempotency-Key the event is DERIVED from it, so one keyed request
 * is one event however often it is retried. (The bus's retry fingerprint does
 * not include this id: the route fingerprints the request as sent, with the
 * application as its source, the same on either side of G-77.) The key is
 * hashed, never stored: namespaced to the
 * application and the event kind, bounded, opaque. Without a key the caller
 * has accepted that a retry may run again (the bus's contract), so each
 * request is its own event and gets a fresh id.
 */
import { createHash, randomUUID } from 'node:crypto';

export function apiSaleEventId(applicationId: string, idempotencyKey: string | null): string {
  if (!idempotencyKey) return `sale-${randomUUID()}`;
  const digest = createHash('sha256')
    .update(`api-sale\u0000${applicationId}\u0000${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `sale-k-${digest}`;
}
