/**
 * The persistence boundary (R5): what a stored draft may keep, pinned as
 * a table rather than as call-site discipline.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeCommandForPersistence } from './command-persistence.js';

describe('sanitising a command for draft persistence', () => {
  it('nulls the transient RecordOrder note, keeping everything the order needs', () => {
    const command = {
      intent: 'RecordOrder',
      customer: { kind: 'token', token: 'CUSTOMER_A1' },
      items: [{ name: 'wig', quantity: 2 }],
      note: 'deliver to 14 Adeola Street, gate code 4432, before 5pm',
    };
    const stored = sanitizeCommandForPersistence(command) as Record<string, unknown>;

    expect(stored['note']).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('Adeola');
    // The bookkeeping half is untouched.
    expect(stored['items']).toEqual(command.items);
    expect(stored['customer']).toEqual(command.customer);
    // And the LIVE command was not mutated: the preview still reads it.
    expect(command.note).toContain('Adeola');
  });

  it('nulls the raw supplier name on RecordPurchase, keeping the amounts', () => {
    const command = {
      intent: 'RecordPurchase',
      supplierMention: 'Alhaji Musa Textiles',
      description: 'ankara stock',
      amount: 50_000,
      reportedPayment: null,
      productMention: 'ankara',
      quantity: 10,
    };
    const stored = sanitizeCommandForPersistence(command) as Record<string, unknown>;

    expect(stored['supplierMention']).toBeNull();
    expect(stored['amount']).toBe(50_000);
    expect(stored['quantity']).toBe(10);
  });

  it('passes commands with no transient fields through unchanged, by identity', () => {
    const sale = {
      intent: 'RecordSale',
      customer: { kind: 'token', token: 'CUSTOMER_B2' },
      items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
      statedTotal: 150_000,
      dueDescription: 'balance on Friday',
    };
    // Identity, not a copy: nothing to strip means nothing to rebuild.
    expect(sanitizeCommandForPersistence(sale)).toBe(sale);
  });

  it('leaves an already-null transient field alone', () => {
    const order = { intent: 'RecordOrder', items: [{ name: 'wig', quantity: 1 }], note: null };
    expect(sanitizeCommandForPersistence(order)).toBe(order);
  });

  it('is harmless on non-objects and unknown intents', () => {
    expect(sanitizeCommandForPersistence(null)).toBeNull();
    expect(sanitizeCommandForPersistence('EraseData')).toBe('EraseData');
    const unknown = { intent: 'SomethingNew', note: 'kept until the table says otherwise' };
    expect(sanitizeCommandForPersistence(unknown)).toBe(unknown);
  });
});
