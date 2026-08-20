/**
 * What a receipt says (docs/payments-v1.md §22).
 *
 * Pure layout, same as the invoice: these assertions are the reason the PDF
 * needs no parser to be trusted.
 */
import { describe, expect, it } from 'vitest';
import { layoutReceipt, type ReceiptDocument } from './receipt-layout.js';
import { nairaInWords } from './words.js';

const RECEIPT: ReceiptDocument = {
  documentNumber: 'RCT-2026-000007',
  issuedAt: new Date('2026-08-20T10:00:00Z'),
  businessName: 'Ada Fashion',
  invoiceNumber: 'INV-2026-000041',
  reference: 'RKD-PAY-20260820-A7K2Q9',
  amountK: 15_000_000,
  allocatedK: 15_000_000,
};

const textOf = (doc: ReceiptDocument) =>
  layoutReceipt(doc)
    .map((b) => `${b.text} ${b.value ?? ''}`)
    .join('\n');

describe('the non-negotiables', () => {
  it('names the receipt, the invoice it answers, and the payment reference', () => {
    const text = textOf(RECEIPT);
    expect(text).toContain('RCT-2026-000007');
    expect(text).toContain('INV-2026-000041');
    expect(text).toContain('RKD-PAY-20260820-A7K2Q9');
  });

  it('shows the confirmed amount as a ₦ figure and restates it in words', () => {
    const text = textOf(RECEIPT);
    expect(text).toContain('₦150,000');
    const words = layoutReceipt(RECEIPT).find((b) => b.kind === 'words')!;
    expect(words.text).toBe(nairaInWords(RECEIPT.amountK));
  });

  it('says the payment was CONFIRMED with the provider — the whole point of the paper', () => {
    expect(textOf(RECEIPT)).toContain('confirmed with the payment provider');
  });

  it('carries the E&OE footnote', () => {
    expect(textOf(RECEIPT)).toContain('E&OE');
  });

  it('reads like a person wrote it: no em or en dashes anywhere', () => {
    expect(textOf(RECEIPT)).not.toMatch(/[–—]/);
  });
});

describe('overpayment', () => {
  const OVERPAID: ReceiptDocument = { ...RECEIPT, amountK: 18_000_000, allocatedK: 15_000_000 };

  it('states what was applied and what is under review, never absorbing the excess', () => {
    const text = textOf(OVERPAID);
    expect(text).toContain('Applied to INV-2026-000041 ₦150,000');
    expect(text).toContain('remaining ₦30,000 is being reviewed');
  });

  it('an exact payment carries no overpayment lines at all', () => {
    const text = textOf(RECEIPT);
    expect(text).not.toContain('Applied to');
    expect(text).not.toContain('being reviewed');
  });
});
