/**
 * The method normaliser, pinned against spec §6.2's one subtle rule: OTHER
 * and UNKNOWN are different claims about the world, and mapping one onto the
 * other manufactures knowledge or destroys it.
 */
import { describe, expect, it } from 'vitest';
import { normalisePaymentMethod, PAYMENT_METHODS } from './provenance.js';

describe('normalising the method column', () => {
  it.each([
    ['cash', 'CASH'],
    ['transfer', 'BANK_TRANSFER'],
    ['bank_transfer', 'BANK_TRANSFER'],
    ['pos', 'POS'],
    ['card', 'CARD'],
    ['ussd', 'USSD'],
    ['wallet', 'WALLET'],
  ] as const)('maps %s to %s', (raw, canonical) => {
    expect(normalisePaymentMethod(raw)).toBe(canonical);
  });

  /* A POS payment no longer has to pretend to be a transfer, and it also
   * does not become one by accident of casing or whitespace. */
  it('is indifferent to case and whitespace', () => {
    expect(normalisePaymentMethod(' POS ')).toBe('POS');
    expect(normalisePaymentMethod('Cash')).toBe('CASH');
  });

  /**
   * The rule that matters. `unknown` means we do not know; `OTHER` means we
   * can name it but have not enumerated it. An adapter that answered
   * `unknown` was making the first claim, and rewriting it as the second
   * would manufacture knowledge the estate does not have.
   */
  it('keeps unknown as UNKNOWN, never OTHER', () => {
    expect(normalisePaymentMethod('unknown')).toBe('UNKNOWN');
    expect(normalisePaymentMethod('')).toBe('UNKNOWN');
    expect(normalisePaymentMethod(null)).toBe('UNKNOWN');
    expect(normalisePaymentMethod(undefined)).toBe('UNKNOWN');
  });

  it('names the genuinely unenumerated as OTHER', () => {
    expect(normalisePaymentMethod('crypto')).toBe('OTHER');
    expect(normalisePaymentMethod('barter')).toBe('OTHER');
  });

  it('only ever answers from the canonical eight', () => {
    for (const raw of ['cash', 'transfer', 'pos', 'unknown', 'crypto', '', 'CARD']) {
      expect(PAYMENT_METHODS).toContain(normalisePaymentMethod(raw));
    }
  });
});
