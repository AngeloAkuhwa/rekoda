/**
 * Two models read one document; this decides whether they read the same
 * thing (AI hardening item 9). The properties worth pinning: money never
 * gets tolerance, formatting never causes a false alarm, and the threshold
 * arithmetic converts naira commands to the kobo the config speaks.
 */
import { describe, expect, it } from 'vitest';
import { commandValueK, divergentFields } from './extraction-compare.js';

const SALE = {
  intent: 'RecordSale',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  items: [{ name: 'generator', quantity: 1, unitPrice: 650_000 }],
  statedTotal: 650_000,
  reportedPayment: 300_000,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};

describe('divergentFields', () => {
  it('agrees with itself, and with formatting-only differences', () => {
    expect(divergentFields(SALE, SALE)).toEqual([]);
    const reformatted = {
      ...SALE,
      items: [{ ...SALE.items[0], name: '  Generator ' }],
      dueDescription: null,
    };
    expect(divergentFields(SALE, reformatted)).toEqual([]);
  });

  it('applies NO tolerance to money, in either direction', () => {
    expect(divergentFields(SALE, { ...SALE, statedTotal: 650_100 })).toEqual(['statedTotal']);
    expect(divergentFields(SALE, { ...SALE, statedTotal: 649_900 })).toEqual(['statedTotal']);
  });

  it('names every disagreeing path, not just the first', () => {
    const other = {
      ...SALE,
      statedTotal: 560_000,
      items: [{ name: 'generator', quantity: 2, unitPrice: 650_000 }],
    };
    const fields = divergentFields(SALE, other);
    expect(fields).toContain('statedTotal');
    expect(fields).toContain('items.0.quantity');
  });

  it('treats a missing field on one side as a disagreement', () => {
    expect(divergentFields(SALE, { ...SALE, reportedPayment: null })).toEqual(['reportedPayment']);
  });

  it('charges a different line count to the items array itself', () => {
    const twoLines = {
      ...SALE,
      items: [...SALE.items, { name: 'cable', quantity: 2, unitPrice: 5_000 }],
    };
    expect(divergentFields(SALE, twoLines)).toEqual(['items']);
  });

  it('flags a type mismatch rather than coercing it into agreement', () => {
    expect(divergentFields({ total: 500 }, { total: '500' })).toEqual(['total']);
  });
});

describe('commandValueK', () => {
  it('converts the largest money field from naira to kobo', () => {
    // ₦650,000 = 65,000,000 kobo.
    expect(commandValueK(SALE)).toBe(65_000_000);
  });

  it('weighs a line by its extended total, not its unit price', () => {
    const bulk = {
      intent: 'RecordSale',
      items: [{ name: 'sachet', quantity: 10_000, unitPrice: 100 }],
      statedTotal: null,
    };
    // 10,000 × ₦100 = ₦1,000,000 = 100,000,000 kobo.
    expect(commandValueK(bulk)).toBe(100_000_000);
  });

  it('never mistakes a bare quantity for money', () => {
    const counted = { intent: 'AdjustInventory', items: [{ name: 'sachet', quantity: 600_000 }] };
    expect(commandValueK(counted)).toBe(0);
  });

  it('reads an expense`s amount', () => {
    expect(commandValueK({ intent: 'RecordExpense', amount: 750_000 })).toBe(75_000_000);
  });
});
