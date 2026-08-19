import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { layoutInvoice, pageLabel, type InvoiceDocument, type LayoutBlock } from '@rekoda/core';

/**
 * The PDF engine (MASTER-PLAN §5.3.6).
 *
 * Deliberately thin. `layoutInvoice` in `@rekoda/core` decides everything a
 * reviewer would argue about — what appears, in what order, with what wording
 * — and this file turns those blocks into ink. Asserting "the VAT memo is on
 * the invoice" against a compressed PDF with a subsetted font would need a PDF
 * parser; against a layout it needs one line.
 *
 * A5 by default. Nigerian merchants print on what the shop has, and a compact
 * document is also what a customer photographs on WhatsApp — which is how most
 * of these will actually be read.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `dist/documents/pdf.js` and `src/documents/pdf.ts` are both two levels below
 * the package, so one relative path serves the build and the source.
 */
const FONT_DIR = join(HERE, '..', '..', 'assets', 'fonts');
const REGULAR = join(FONT_DIR, 'NotoSans-Regular.ttf');
const SEMIBOLD = join(FONT_DIR, 'NotoSans-SemiBold.ttf');

/**
 * The fonts are not optional and their absence must not be discovered by a
 * merchant.
 *
 * ₦ (U+20A6) is not in WinAnsi, which is what pdfkit's built-in Helvetica
 * uses. Falling back to it would not fail — it would produce an invoice where
 * every price begins with a blank box, which looks like a Rekoda bug on a
 * document a merchant hands to a customer. Noto Sans also carries Yoruba ẹ and
 * ọ, so a business named "Adeẹ́ Fashion" prints as itself.
 */
export class FontsMissing extends Error {
  constructor() {
    super(`PDF fonts not found in ${FONT_DIR}. Run: node scripts/fetch-pdf-fonts.mjs`);
  }
}

export function fontsAvailable(): boolean {
  return existsSync(REGULAR) && existsSync(SEMIBOLD);
}

const MARGIN = 36;
const A5_WIDTH = 419.53;

interface Style {
  font: 'regular' | 'semibold';
  size: number;
  gapBefore: number;
  rule?: boolean;
}

/** One place to argue about hierarchy, rather than a magic number per branch. */
const STYLES: Record<LayoutBlock['kind'], Style> = {
  title: { font: 'semibold', size: 16, gapBefore: 0 },
  meta: { font: 'regular', size: 9, gapBefore: 2 },
  party: { font: 'regular', size: 9, gapBefore: 8 },
  item: { font: 'regular', size: 9.5, gapBefore: 4 },
  total: { font: 'regular', size: 9.5, gapBefore: 3 },
  'grand-total': { font: 'semibold', size: 12, gapBefore: 8, rule: true },
  'amount-due': { font: 'semibold', size: 12, gapBefore: 10 },
  words: { font: 'regular', size: 8.5, gapBefore: 10 },
  memo: { font: 'regular', size: 8, gapBefore: 6 },
  footnote: { font: 'regular', size: 7, gapBefore: 14 },
};

export interface RenderOptions {
  /** Defaults to A5. */
  size?: 'A5' | 'A4';
}

/**
 * Render an invoice to PDF bytes.
 *
 * Returns a Buffer rather than writing anywhere — where a document is stored
 * is the storage layer's decision, and a renderer that also knew about R2
 * would be two things.
 */
export async function renderInvoicePdf(
  doc: InvoiceDocument,
  options: RenderOptions = {},
): Promise<Buffer> {
  if (!fontsAvailable()) throw new FontsMissing();

  const blocks = layoutInvoice(doc);
  const pdf = new PDFDocument({
    size: options.size ?? 'A5',
    margin: MARGIN,
    // Metadata a merchant's customer can see in a viewer. No PII: the customer
    // label may be a token, and the business name is public by definition.
    info: {
      Title: `${doc.documentNumber} — ${doc.businessName}`,
      Creator: 'Rekoda',
    },
  });

  pdf.registerFont('regular', REGULAR);
  pdf.registerFont('semibold', SEMIBOLD);

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  const isA4 = options.size === 'A4';
  const contentWidth = (isA4 ? 595.28 : A5_WIDTH) - MARGIN * 2;

  for (const block of blocks) {
    const style = STYLES[block.kind];
    pdf.font(style.font).fontSize(style.size);
    pdf.moveDown(style.gapBefore / style.size);

    /**
     * The AMOUNT DUE box, on A4 only — the plan is explicit, and the reason is
     * room: A5 is already dense and a boxed figure there crowds the words line
     * beneath it.
     *
     * The FIGURE appears on both sizes. The plan's "do not duplicate the
     * balance" is honoured either way, because `amount-due` is the only block
     * carrying the balance at all — there is nothing to duplicate.
     */
    if (block.kind === 'amount-due' && isA4) {
      pdf
        .rect(MARGIN, pdf.y - 4, contentWidth, style.size + 14)
        .lineWidth(1)
        .stroke();
      pdf.moveDown(0.35);
      const boxY = pdf.y;
      pdf.text(block.text, MARGIN + 8, boxY, { width: contentWidth * 0.6 });
      pdf.text(block.value ?? '', MARGIN + contentWidth * 0.6, boxY, {
        width: contentWidth * 0.4 - 8,
        align: 'right',
      });
      pdf.moveDown(0.7);
      continue;
    }

    if (style.rule) {
      const y = pdf.y - 4;
      pdf
        .moveTo(MARGIN, y)
        .lineTo(MARGIN + contentWidth, y)
        .lineWidth(0.5)
        .stroke();
      pdf.moveDown(0.3);
    }

    if (block.value === undefined) {
      pdf.text(block.text, MARGIN, pdf.y, { width: contentWidth });
      continue;
    }

    /**
     * Label left, figure right, on ONE line.
     *
     * `continued` would let a long product name push the figure onto the next
     * line, which on a money document reads as a figure belonging to the wrong
     * row. Drawing both at a fixed y is what keeps them together.
     */
    const y = pdf.y;
    pdf.text(block.text, MARGIN, y, { width: contentWidth * 0.62 });
    const afterLabel = pdf.y;
    pdf.text(block.value, MARGIN + contentWidth * 0.62, y, {
      width: contentWidth * 0.38,
      align: 'right',
    });
    // Whichever wrapped further decides where the next block starts.
    pdf.y = Math.max(afterLabel, pdf.y);
  }

  /**
   * Page numbers, and only when there is more than one page.
   *
   * "Page 1 of 1" on a single-page receipt is noise that makes a document look
   * like it came out of an enterprise system rather than from a shop.
   */
  const range = pdf.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      const label = pageLabel(i + 1, range.count);
      if (!label) continue;
      pdf.font('regular').fontSize(7);
      pdf.text(label, MARGIN, pdf.page.height - MARGIN + 4, {
        width: contentWidth,
        align: 'center',
      });
    }
  }

  pdf.end();
  return finished;
}
