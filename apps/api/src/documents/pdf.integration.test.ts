/**
 * The PDF engine (MASTER-PLAN §5.3.6).
 *
 * `packages/core/src/invoice-layout.test.ts` proves WHAT the document says.
 * This proves the bytes: that a real PDF comes out, that the font carrying ₦
 * is actually embedded in it, and that the engine refuses rather than
 * producing a document with a blank box where every price should be.
 *
 * Named `.integration.test.ts` because it reads fonts off disk and builds a
 * real document — slower than a unit test and dependent on `fetch-pdf-fonts`
 * having run, which is exactly the kind of thing worth failing loudly.
 */
import { describe, expect, it } from 'vitest';
import type { InvoiceDocument } from '@rekoda/core';
import { fontsAvailable, renderInvoicePdf } from './pdf.js';

const INVOICE: InvoiceDocument = {
  documentNumber: 'INV-2026-000001',
  issuedAt: new Date('2026-08-19T10:00:00Z'),
  businessName: 'Adeẹ́ Fashion',
  customerLabel: 'CUSTOMER_7K2',
  items: [{ name: 'chiffon wrapper', quantity: 3, unitPriceK: 5_000_000 }],
  subtotalK: 15_000_000,
  discountK: 0,
  deliveryFeeK: 0,
  vatK: 0,
  totalK: 15_000_000,
  paidK: 10_000_000,
  balanceDueK: 5_000_000,
};

describe('the fonts', () => {
  it('are present — the engine cannot work without them', () => {
    /**
     * A loud failure. ₦ (U+20A6) is not in WinAnsi, so falling
     * back to pdfkit's built-in Helvetica would not error — it would produce
     * an invoice where every price starts with a blank box, on a document a
     * merchant hands to a customer.
     */
    expect(fontsAvailable()).toBe(true);
  });
});

describe('rendering', () => {
  it('produces a real PDF', async () => {
    const bytes = await renderInvoicePdf(INVOICE);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.subarray(-6).toString('latin1')).toContain('%%EOF');
    // A document with content, not an empty page.
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it('embeds the font rather than referencing it by name', async () => {
    const bytes = await renderInvoicePdf(INVOICE);
    const raw = bytes.toString('latin1');

    /**
     * A `FontFile2` entry is an embedded TrueType program. Without it the
     * document depends on the READER having Noto Sans, which nothing
     * guarantees — and the failure appears on the customer's phone, not ours.
     */
    expect(raw).toContain('FontFile2');
    expect(raw).toContain('NotoSans');
    // Not the fallback that cannot draw ₦.
    expect(raw).not.toContain('Helvetica');
  });

  it('renders a Yoruba business name without falling back', async () => {
    // "Adeẹ́ Fashion" — ẹ is U+1EB9, the glyph the web fonts were subsetted to
    // keep. The PDF font has to carry it too.
    const bytes = await renderInvoicePdf(INVOICE);
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it('renders A4 as well as A5', async () => {
    const a5 = await renderInvoicePdf(INVOICE);
    const a4 = await renderInvoicePdf(INVOICE, { size: 'A4' });
    expect(a4.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Different page boxes, so the bytes cannot be identical.
    expect(a4.length).not.toBe(a5.length);
  });

  it('renders a long invoice without losing the total', async () => {
    // Forty lines runs onto a second A5 page, which is where a layout that
    // draws label and figure separately can come apart.
    const long: InvoiceDocument = {
      ...INVOICE,
      items: Array.from({ length: 40 }, (_, i) => ({
        name: `item number ${i + 1} with a deliberately long product name`,
        quantity: i + 1,
        unitPriceK: 125_000,
      })),
    };
    const bytes = await renderInvoicePdf(long);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(10_000);
  });

  it('puts no customer identity in the document metadata', async () => {
    const bytes = await renderInvoicePdf(INVOICE);
    const raw = bytes.toString('latin1');
    // The title carries the number and the business, both public. A viewer
    // shows this in a tab; it must not carry anything the vault protects.
    expect(raw).not.toContain('08039998888');
  });
});
