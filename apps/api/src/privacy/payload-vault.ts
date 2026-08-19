/**
 * Sealing an inbound provider payload before it is stored.
 *
 * `external_events` is the one table in the system with row-level security
 * deliberately switched off — an event arrives before anyone knows which
 * tenant it belongs to, and a policy keyed on `app.business_id` would reject
 * the very insert that determines it.
 *
 * That was fine while the column held routing metadata. It is not fine holding
 * a Meta webhook body, which contains the merchant's message text and the
 * sender's WhatsApp number in plaintext. The schema comment on the table has
 * always said payloads are stored "with PII-bearing fields redacted at write
 * time"; this is the code that makes that true.
 *
 * Sealed rather than redacted, because the worker still has to read the
 * message. One AES-256-GCM encrypt on the ack path costs microseconds — far
 * less than the tokenising round trip that would otherwise have to happen
 * before Meta's timeout.
 */
import { decryptFacet, encryptFacet } from '@rekoda/core/vault';

/** What actually lands in the jsonb column. */
export interface SealedPayload {
  readonly sealed: 1;
  readonly blob: string;
}

export function sealPayload(payload: unknown, vaultKey: string): SealedPayload {
  return { sealed: 1, blob: encryptFacet(JSON.stringify(payload ?? null), vaultKey) };
}

export function isSealed(stored: unknown): stored is SealedPayload {
  return (
    typeof stored === 'object' &&
    stored !== null &&
    (stored as SealedPayload).sealed === 1 &&
    typeof (stored as SealedPayload).blob === 'string'
  );
}

/**
 * Open a sealed payload.
 *
 * Anything not sealed is returned as-is: rows written before this existed are
 * still readable, and a status event carrying nothing sensitive does not have
 * to be. Refusing them would turn a privacy improvement into an outage on the
 * events already in the table.
 */
export function openPayload(stored: unknown, vaultKey: string): unknown {
  if (!isSealed(stored)) return stored;
  return JSON.parse(decryptFacet(stored.blob, vaultKey));
}
