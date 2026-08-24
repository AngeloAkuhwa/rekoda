/**
 * The seal on provider payloads, and the binding that makes it a seal.
 *
 * `external_events` is the one table outside row-level security, so the
 * attack these tests pin is the database-write one: copy a valid sealed blob
 * onto another event's row. With the event identity as associated data, the
 * copy fails authentication instead of reading as the other event's body.
 */
import { describe, expect, it } from 'vitest';
import { VaultError } from '@rekoda/core/vault';
import { isSealed, openPayload, sealPayload } from './payload-vault.js';

const KEY = 'b'.repeat(64);

describe('sealing a provider payload', () => {
  const body = { entry: [{ changes: [{ value: { messages: [{ text: 'sold 3 wigs' }] } }] }] };

  it('opens under the event it was sealed for, and only there', () => {
    const sealed = sealPayload(body, KEY, 'meta', 'wamid.A');
    expect(isSealed(sealed)).toBe(true);
    expect(openPayload(sealed, KEY, 'meta', 'wamid.A')).toEqual(body);

    /* The blob copied onto ANOTHER event's row: same key, wrong identity.
     * This is the move a seal without binding used to allow. */
    expect(() => openPayload(sealed, KEY, 'meta', 'wamid.B')).toThrow(VaultError);
    expect(() => openPayload(sealed, KEY, 'paystack', 'wamid.A')).toThrow(VaultError);
  });

  it('passes an unsealed row through untouched', () => {
    /* A status event that carried nothing sensitive was never sealed, and a
     * privacy improvement must not turn those rows into an outage. */
    const plain = { event: 'charge.success' };
    expect(openPayload(plain, KEY, 'paystack', 'evt-1')).toBe(plain);
  });

  it('seals null as readable null rather than exploding on an empty body', () => {
    const sealed = sealPayload(undefined, KEY, 'paystack', 'evt-2');
    expect(openPayload(sealed, KEY, 'paystack', 'evt-2')).toBeNull();
  });
});
