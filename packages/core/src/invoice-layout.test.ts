/**
 * What an invoice says (MASTER-PLAN §5.3.6).
 *
 * The layout is pure precisely so this file can exist. Asserting "the VAT memo
 * appears" against a compressed PDF with a subsetted font needs a PDF parser,
 * and a test that needs a PDF parser is a test nobody writes — so the document
 * would go unchecked.
 */
import { describe, expect, it } from 'vitest';
import { layoutInvoice, pageLabel, type InvoiceDocument } from './invoice-layout.js';
import { nairaInWords } from './words.js';

const INVOICE: InvoiceDocument = {
  documentNumber: 'INV-2026-000001',
  issuedAt: new Date('2026-08-19T10:00:00Z'),
  businessName: 'Ada Fashion',
  customerLabel: 'CUSTOMER_7K2',
  items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
  subtotalK: 15_000_000,
  discountK: 0,
  deliveryFeeK: 0,
  vatK: 0,
  totalK: 15_000_000,
  paidK: 10_000_000,
  balanceDueK: 5_000_000,
};

const textOf = (doc: InvoiceDocument) =>
  layoutInvoice(doc)
    .map((b) => `${b.text} ${b.value ?? ''}`)
    .join('\n');

const kindsOf = (doc: InvoiceDocument) => layoutInvoice(doc).map((b) => b.kind);

describe('the non-negotiables', () => {
  it('prints ₦ figures, not bare numbers', () => {
    expect(textOf(INVOICE)).toContain('₦150,000');
    expect(textOf(INVOICE)).toContain('₦50,000');
  });

  it('states the total in words', () => {
    expect(textOf(INVOICE)).toContain('One Hundred and Fifty Thousand Naira Only');
  });

  it('puts the TOTAL in words, never the balance', () => {
    /**
     * A document is for its total. Writing the balance here would make a
     * part-paid invoice say one figure in words and another in digits — the
     * exact ambiguity words exist to close.
     */
    const words = layoutInvoice(INVOICE).find((b) => b.kind === 'words')!;
    // Compared against the two figures rather than by substring: the balance's
    // words ("Fifty Thousand Naira Only") are a SUBSTRING of the total's, so a
    // `not.toContain` here fails on correct output — as it did when written.
    expect(words.text).toBe(nairaInWords(INVOICE.totalK));
    expect(words.text).not.toBe(nairaInWords(INVOICE.balanceDueK));
  });

  it('carries the E&OE footnote', () => {
    expect(textOf(INVOICE)).toContain('E&OE');
  });

  it('shows the document number and a date a person can read', () => {
    expect(textOf(INVOICE)).toContain('INV-2026-000001');
    expect(textOf(INVOICE)).toMatch(/19 August 2026/);
  });
});

describe('the AMOUNT DUE box', () => {
  it('appears when money is owed', () => {
    const due = layoutInvoice(INVOICE).find((b) => b.kind === 'amount-due');
    expect(due).toMatchObject({ text: 'AMOUNT DUE', value: '₦50,000' });
  });

  it('does NOT appear on a fully paid document', () => {
    /**
     * The predecessor printed it always, so a paid receipt carried a prominent
     * box reading ₦0. Across a counter that reads as a demand for nothing, and
     * merchants had to explain it. A zero balance is good news.
     */
    const paid = { ...INVOICE, paidK: 15_000_000, balanceDueK: 0 };
    expect(kindsOf(paid)).not.toContain('amount-due');
    expect(textOf(paid)).toContain('Paid in full');
  });

  it('does not claim "paid in full" on an unpaid invoice', () => {
    const unpaid = { ...INVOICE, paidK: 0, balanceDueK: 15_000_000 };
    expect(textOf(unpaid)).not.toContain('Paid in full');
    expect(kindsOf(unpaid)).toContain('amount-due');
  });
});

describe('VAT', () => {
  it('is a MEMO, not a line', () => {
    // The VAT is already inside the total. Adding it as a line invites a
    // customer to add it again.
    const withVat = { ...INVOICE, vatK: 1_000_000, vatRatePercent: 7.5 };
    const vat = layoutInvoice(withVat).find((b) => b.text.includes('VAT'))!;
    expect(vat.kind).toBe('memo');
    expect(vat.text).toBe('Includes VAT @ 7.5%: ₦10,000');
  });

  it('states the amount without a rate when the rate is unknown', () => {
    const withVat = { ...INVOICE, vatK: 1_000_000 };
    expect(textOf(withVat)).toContain('Includes VAT of ₦10,000');
  });

  it('is absent entirely when there is no VAT', () => {
    // Most Nigerian small businesses are below the threshold. "VAT: ₦0" on
    // their invoice is a question they will be asked and cannot answer.
    expect(textOf(INVOICE)).not.toContain('VAT');
  });
});

describe('discount and delivery', () => {
  it('shows each only when it happened', () => {
    expect(textOf(INVOICE)).not.toContain('Discount');
    expect(textOf(INVOICE)).not.toContain('Delivery');

    const both = { ...INVOICE, discountK: 500_000, deliveryFeeK: 200_000 };
    expect(textOf(both)).toContain('Discount −₦5,000');
    expect(textOf(both)).toContain('Delivery ₦2,000');
  });
});

describe('the customer', () => {
  it('is labelled by token, never by identity', () => {
    // Rehydration belongs to the send boundary. A layout that reached for a
    // name would put one in every stored PDF.
    expect(textOf(INVOICE)).toContain('CUSTOMER_7K2');
  });

  it('is omitted when there is no customer', () => {
    const walkIn = { ...INVOICE, customerLabel: null };
    expect(kindsOf(walkIn)).not.toContain('party');
    // A walk-in sale is an ordinary sale, not a document with a blank line.
    expect(textOf(walkIn)).not.toContain('Billed to');
  });
});

describe('the reading order', () => {
  it('runs who → number → what → total → due', () => {
    // A merchant handing this to a customer points down it in this order.
    const kinds = kindsOf(INVOICE);
    expect(kinds[0]).toBe('title');
    expect(kinds.indexOf('item')).toBeLessThan(kinds.indexOf('grand-total'));
    expect(kinds.indexOf('grand-total')).toBeLessThan(kinds.indexOf('amount-due'));
    expect(kinds[kinds.length - 1]).toBe('footnote');
  });
});

describe('page numbering', () => {
  it('says nothing on a single-page document', () => {
    // "Page 1 of 1" on a receipt makes it look like it came out of an
    // enterprise system rather than from a shop.
    expect(pageLabel(1, 1)).toBeNull();
  });

  it('numbers a multi-page one', () => {
    expect(pageLabel(2, 3)).toBe('Page 2 of 3');
  });
});
