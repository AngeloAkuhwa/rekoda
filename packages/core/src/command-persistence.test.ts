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

  it("nulls a Query's periodText, which can carry a name the model copied (Build 6)", () => {
    const command = {
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'custom',
      periodText: 'the month I sold to Ada',
      format: null,
    };
    const stored = sanitizeCommandForPersistence(command) as Record<string, unknown>;

    expect(stored['periodText']).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('Ada');
    expect(stored['topic']).toBe('sales_summary');
    expect(stored['period']).toBe('custom');
    expect(command.periodText).toContain('Ada');
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

describe("a purchase's supplier reference (G-81)", () => {
  const purchase = (supplierReference: unknown) => ({
    intent: 'RecordPurchase',
    supplierMention: null,
    description: '10 cartons of Milo',
    amount: 100_000,
    reportedPayment: 100_000,
    paymentMethod: 'cash',
    productMention: 'Milo',
    quantity: 10,
    supplierReference,
  });

  it('is stored only in its normalised document-number shape', () => {
    const stored = sanitizeCommandForPersistence(purchase('EMK-0041')) as Record<string, unknown>;
    expect(stored['supplierReference']).toBe('OTHER:0041');
  });

  it('is dropped when it is not a document number, so a name is never stored', () => {
    for (const raw of ["Emeka's receipt", 'Emeka Stores', 'the paper']) {
      const stored = sanitizeCommandForPersistence(purchase(raw)) as Record<string, unknown>;
      expect(stored['supplierReference']).toBeNull();
    }
  });

  it('leaves a purchase without one exactly as it was', () => {
    const command = { ...purchase(null) };
    delete (command as Record<string, unknown>)['supplierReference'];
    expect(sanitizeCommandForPersistence(command)).toBe(command);
  });
});

describe("Codex review of #262: a supplier's name with a digit is not a reference", () => {
  it.each(['3 Brothers Ventures', '2 Sisters Stores', 'Emeka 2'])('%j is dropped', (raw) => {
    const stored = sanitizeCommandForPersistence({
      intent: 'RecordPurchase',
      supplierMention: null,
      description: 'stock',
      amount: 100,
      reportedPayment: null,
      productMention: null,
      quantity: null,
      supplierReference: raw,
    }) as Record<string, unknown>;
    expect(stored['supplierReference']).toBeNull();
  });
});
