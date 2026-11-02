import { describe, expect, it } from 'vitest';
import {
  billingEmailAddressKeyFor,
  contactKeyFor,
  decryptFacet,
  encryptFacet,
  VaultError,
} from './vault.js';

describe('associated data binds a blob to its place', () => {
  const key = 'a'.repeat(64);

  it('a v2 blob refuses to open anywhere but its own row', () => {
    const blob = encryptFacet('0123456789', key, 'biz-1:settlement_account');
    expect(blob.startsWith('v2.')).toBe(true);
    expect(decryptFacet(blob, key, 'biz-1:settlement_account')).toBe('0123456789');
    // Moved to another tenant's row: the tag no longer authenticates.
    expect(() => decryptFacet(blob, key, 'biz-2:settlement_account')).toThrow(VaultError);
    // Read with no aad at all: same refusal, because "reads anywhere"
    // is the property v2 exists to remove.
    expect(() => decryptFacet(blob, key)).toThrow(VaultError);
  });

  it('a v1 blob opens only on an unbound read', () => {
    const blob = encryptFacet('ada@mail.test', key);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(decryptFacet(blob, key)).toBe('ada@mail.test');
  });

  it('a bound read refuses a v1 blob, so a binding cannot be downgraded away', () => {
    /* The hole this closes: swap a bound cipher for an unbound one in the
     * database and a reader that "binds" would have silently stopped
     * checking. Every writer has produced v2 since binding shipped, so an
     * unbound blob arriving at a bound read is an alarm, not history. */
    const blob = encryptFacet('0123456789', key);
    expect(() => decryptFacet(blob, key, 'biz-1:settlement_account')).toThrow(VaultError);
  });
});

describe('billingEmailAddressKeyFor (SUB-02a, OWN-58)', () => {
  const key = 'ab'.repeat(32);
  const other = 'cd'.repeat(32);

  it('gives one key per address as the mailbox compares it', () => {
    const k = billingEmailAddressKeyFor('ada@shop.example.ng', key);
    expect(billingEmailAddressKeyFor('  ADA@Shop.Example.NG ', key)).toBe(k);
    expect(billingEmailAddressKeyFor('chidi@shop.example.ng', key)).not.toBe(k);
  });

  it('is 43 base64url characters and never contains the address', () => {
    const k = billingEmailAddressKeyFor('ada@shop.example.ng', key);
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.toLowerCase()).not.toContain('ada');
  });

  it('depends on the secret, so a table of keys cannot be rebuilt from a list of addresses', () => {
    expect(billingEmailAddressKeyFor('ada@shop.example.ng', other)).not.toBe(
      billingEmailAddressKeyFor('ada@shop.example.ng', key),
    );
  });

  it('lives in its own keyspace, apart from the stranger contact key', () => {
    expect(billingEmailAddressKeyFor('ada@shop.example.ng', key)).not.toBe(
      contactKeyFor('ada@shop.example.ng', key),
    );
  });

  it('refuses an empty address and a bad secret', () => {
    expect(() => billingEmailAddressKeyFor('   ', key)).toThrow(VaultError);
    expect(() => billingEmailAddressKeyFor('ada@shop.example.ng', 'short')).toThrow();
  });
});
