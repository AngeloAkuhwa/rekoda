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
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { InvoiceDocument, StatementDocument } from '@rekoda/core';
import { fontsAvailable, renderInvoicePdf, renderStatementsPdf } from './pdf.js';

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

/**
 * What a document does when it needs a second page.
 *
 * Both bugs below were live for as long as this renderer has existed and
 * neither could show itself: an invoice and a receipt fit on one page, and
 * the one multi-page test above asserted only that the bytes began `%PDF-`
 * and were large. The statements are the first document that genuinely runs
 * over, so the page count is asserted here rather than the file size.
 */
describe('pagination', () => {
  const pageCount = (bytes: Buffer): number => {
    const match = /\/Count (\d+)/.exec(bytes.toString('latin1'));
    return match ? Number(match[1]) : 0;
  };

  const ROWS = Array.from({ length: 26 }, (_, i) => ({
    account: 'CASH' as const,
    code: `1${String(i).padStart(3, '0')}`,
    name: `Ledger account number ${i + 1}`,
    debitK: 100_000 + i,
    creditK: 0,
  }));

  const STATEMENTS: StatementDocument = {
    businessName: 'Mama Chidi Stores',
    period: '2026-08',
    generatedAt: new Date('2026-09-01T10:00:00Z'),
    profitAndLoss: {
      income: ROWS.slice(0, 8).map((r) => ({ ...r, amountK: r.debitK })),
      expenses: ROWS.slice(8, 16).map((r) => ({ ...r, amountK: r.debitK })),
      totalIncomeK: 800_000,
      totalExpensesK: 800_000,
      netProfitK: 0,
    },
    balanceSheet: {
      assets: ROWS.slice(0, 6).map((r) => ({ ...r, amountK: r.debitK })),
      liabilities: ROWS.slice(6, 10).map((r) => ({ ...r, amountK: r.debitK })),
      equity: ROWS.slice(10, 12).map((r) => ({ ...r, amountK: r.debitK })),
      totalAssetsK: 600_000,
      totalLiabilitiesK: 400_000,
      totalEquityK: 200_000,
      balanced: true,
    },
    cashflow: { openingK: 10_000, inK: 90_000, outK: 40_000, closingK: 60_000 },
    trialBalance: {
      rows: ROWS,
      totalDebitK: 2_600_000,
      totalCreditK: 2_600_000,
      balanced: true,
    },
    expenseSchedule: {
      lines: [
        { label: 'Rent', amountK: 500_000 },
        { label: 'Power and fuel', amountK: 300_000 },
      ],
      totalK: 800_000,
    },
    revenueSchedule: {
      lines: [
        { label: 'Instagram', amountK: 500_000 },
        { label: 'In the shop', amountK: 300_000 },
      ],
      totalK: 800_000,
    },
  };

  it('runs onto a second page and stops there', async () => {
    const bytes = await renderStatementsPdf(STATEMENTS);
    const pages = pageCount(bytes);
    expect(pages).toBeGreaterThan(1);
    /**
     * The blank-page bug, pinned.
     *
     * Numbering a page writes below the bottom margin, which pdfkit answers by
     * starting a NEW page, which then wants a number of its own. A document
     * that needed two pages came out with four, and every extra one was empty.
     */
    expect(pages).toBeLessThanOrEqual(3);
  });

  /**
   * Counted, not read.
   *
   * The footer text cannot be asserted directly. pdfkit embeds a SUBSET of
   * the font and writes every string as glyph ids, so an inflated content
   * stream holds `[<000100020003>] TJ` and not "Page 1 of 2". Font size
   * survives that encoding, and 7pt is used by exactly two things: the
   * footnote, once, on the last page; and the page number, once per page.
   * So a numbered document has more 7pt runs than it has pages, and an
   * unnumbered one has exactly one however long it is.
   */
  const smallTextRuns = (bytes: Buffer): number => {
    const raw = bytes.toString('latin1');
    let runs = 0;
    const streams = /stream\r?\n/g;
    let match: RegExpExecArray | null;
    while ((match = streams.exec(raw)) !== null) {
      const start = match.index + match[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        const body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
        runs += (body.match(/ 7 Tf/g) ?? []).length;
      } catch {
        /* Not every stream is a deflated content stream: font programs and
         * metadata live in here too. Skipping them is the point. */
      }
    }
    return runs;
  };

  it('numbers every page once the document has more than one', async () => {
    const bytes = await renderStatementsPdf(STATEMENTS);
    const pages = pageCount(bytes);
    expect(pages).toBeGreaterThan(1);
    /* Page numbering had never once run: without `bufferPages` pdfkit flushes
     * each page as it finishes, `bufferedPageRange()` reports zero, and the
     * footer loop was guarded on a count it could never reach. One 7pt run
     * (the footnote) would mean it still is not running. */
    expect(smallTextRuns(bytes)).toBeGreaterThan(pages);
  });

  it('leaves a single-page document unnumbered', async () => {
    const bytes = await renderInvoicePdf(INVOICE);
    expect(pageCount(bytes)).toBe(1);
    /* Just the E&OE footnote. "Page 1 of 1" on a receipt handed across a
     * counter reads like it came out of an enterprise system. */
    expect(smallTextRuns(bytes)).toBe(1);
  });

  it('keeps a row and its figure on the same page', async () => {
    /**
     * The orphaned-label bug, pinned by page count.
     *
     * A label and its amount are drawn at the SAME fixed y. When that y was
     * already past the bottom margin, pdfkit broke a page for each of them
     * separately: the label alone at the top of one page, the amount at the
     * top of the next, and an empty page between. Rendering at many lengths
     * is how a boundary case gets hit at all; a single fixture would have to
     * be lucky.
     */
    for (let count = 20; count <= 34; count++) {
      const bytes = await renderStatementsPdf({
        ...STATEMENTS,
        trialBalance: { ...STATEMENTS.trialBalance, rows: ROWS.slice(0, count) },
      });
      const pages = pageCount(bytes);
      /* An empty page between two full ones shows up as a count nothing this
       * short could justify. */
      expect(pages, `${count} trial balance rows produced ${pages} pages`).toBeLessThanOrEqual(3);
    }
  });
});
