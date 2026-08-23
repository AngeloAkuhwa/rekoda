import { describe, expect, it } from 'vitest';
import { decryptFacet, encryptFacet, VaultError } from './vault.js';

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

  it('a v1 blob stays readable, aad or not', () => {
    const blob = encryptFacet('ada@mail.test', key);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(decryptFacet(blob, key)).toBe('ada@mail.test');
    expect(decryptFacet(blob, key, 'ignored:aad')).toBe('ada@mail.test');
  });
});
