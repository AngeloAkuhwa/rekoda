import { describe, expect, it } from 'vitest';
import {
  findUniqueAmountMatch,
  paymentLabel,
  reconcile,
  type Expectation,
  type Observation,
} from './reconciliation.js';
import { formatDocumentNumber, lagosYear } from './numbering.js';

const exp = (amountDueK: number, ref = 'INV-1'): Expectation => ({
  kind: 'invoice',
  ref,
  amountDueK,
  currency: 'NGN',
});
const obs = (amountK: number, verified = true): Observation => ({
  ref: 'PSK-1',
  amountK,
  currency: 'NGN',
  verified,
});

describe('reconcile — expected vs observed', () => {
  it('exact amount matches', () => {
    expect(reconcile(exp(12_000_000), obs(12_000_000))).toEqual({
      status: 'MATCHED',
      amountK: 12_000_000,
    });
  });

  it('short payment is PARTIAL with the exact outstanding — never silently closed (spec §23)', () => {
    expect(reconcile(exp(15_000_000), obs(13_000_000))).toEqual({
      status: 'PARTIAL',
      amountK: 13_000_000,
      outstandingK: 2_000_000,
    });
  });

  it('overpayment and currency mismatch are EXCEPTIONS for a human', () => {
    expect(reconcile(exp(10_000_000), obs(11_000_000))).toMatchObject({
      status: 'EXCEPTION',
      reason: 'overpayment',
      detailK: 1_000_000,
    });
    expect(reconcile(exp(10_000_000), { ...obs(10_000_000), currency: 'USD' })).toMatchObject({
      status: 'EXCEPTION',
      reason: 'currency_mismatch',
    });
  });
});

describe('findUniqueAmountMatch — conservative by design', () => {
  const open = [exp(8_500_000, 'INV-A'), exp(12_000_000, 'INV-B'), exp(8_500_000, 'INV-C')];

  it('matches when exactly one open expectation fits', () => {
    expect(findUniqueAmountMatch(open, obs(12_000_000))?.ref).toBe('INV-B');
  });

  it('refuses to guess between two customers who both owe ₦85,000 (spec §24)', () => {
    expect(findUniqueAmountMatch(open, obs(8_500_000))).toBeNull();
  });

  it('no candidates → unmatched', () => {
    expect(findUniqueAmountMatch(open, obs(1))).toBeNull();
  });
});

describe('Payment Recorded vs Payment Verified — the honesty rule', () => {
  it('only provider-verified money may be called Verified', () => {
    expect(paymentLabel(obs(1, true))).toBe('Payment Verified');
    expect(paymentLabel(obs(1, false))).toBe('Payment Recorded');
  });
});

describe('document numbering', () => {
  it('formats sequential numbers per type and year', () => {
    expect(formatDocumentNumber('invoice', 2026, 41)).toBe('INV-2026-000041');
    expect(formatDocumentNumber('receipt', 2026, 1)).toBe('RCT-2026-000001');
    expect(formatDocumentNumber('credit_note', 2027, 123456)).toBe('CRN-2027-123456');
  });

  it('rejects invalid sequences and years', () => {
    expect(() => formatDocumentNumber('invoice', 2026, 0)).toThrow();
    expect(() => formatDocumentNumber('invoice', 1999, 1)).toThrow();
  });

  it("the Lagos year rolls at 23:00 UTC on New Year's Eve, not midnight", () => {
    expect(lagosYear(new Date('2026-12-31T22:59:00Z'))).toBe(2026);
    expect(lagosYear(new Date('2026-12-31T23:00:00Z'))).toBe(2027);
  });
});
