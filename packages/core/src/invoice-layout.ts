/**
 * What an invoice says, and in what order (MASTER-PLAN §5.3.6).
 *
 * Pure. A layout is a list of blocks with text and emphasis; turning blocks
 * into ink is `apps/api/src/documents/pdf.ts` and about a hundred lines of
 * pdfkit. The split is what makes the document testable at all — asserting
 * "the VAT memo appears" against a compressed PDF with a subsetted font means
 * parsing a PDF, and a test that needs a PDF parser is a test nobody writes.
 *
 * Everything the plan calls non-negotiable is decided here: the ₦ figures, the
 * amount in words, the "Includes VAT" memo, the E&OE footnote, the AMOUNT DUE
 * box. Whether the renderer draws a box or a line is the renderer's business.
 */
import { formatKobo } from './money.js';
import { nairaInWords } from './words.js';

export type BlockKind =
  | 'title'
  | 'meta'
  | 'party'
  | 'item'
  | 'total'
  | 'grand-total'
  | 'amount-due'
  | 'words'
  | 'memo'
  | 'footnote';

export interface LayoutBlock {
  readonly kind: BlockKind;
  readonly text: string;
  /** Right-aligned figures: totals, and the amounts on an item line. */
  readonly value?: string;
}

export interface InvoiceDocument {
  readonly documentNumber: string;
  readonly issuedAt: Date;
  readonly businessName: string;
  /** Token or mention. NEVER a raw identity — rehydration is the send layer's. */
  readonly customerLabel: string | null;
  readonly items: ReadonlyArray<{ name: string; quantity: number; unitPriceK: number }>;
  readonly subtotalK: number;
  readonly discountK: number;
  readonly deliveryFeeK: number;
  readonly vatK: number;
  readonly vatRatePercent?: number;
  readonly totalK: number;
  readonly paidK: number;
  readonly balanceDueK: number;
}

/** `INV-2026-000001` issued on a date a Nigerian merchant reads without pausing. */
function issuedLine(at: Date): string {
  return at.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The document, top to bottom.
 *
 * Order is not aesthetic. A Nigerian invoice is read in this sequence — who
 * issued it, its number, who it is for, what was bought, what it comes to,
 * what is still owed — and a merchant handing it to a customer points down it
 * in that order.
 */
export function layoutInvoice(doc: InvoiceDocument): LayoutBlock[] {
  const blocks: LayoutBlock[] = [
    { kind: 'title', text: doc.businessName },
    { kind: 'meta', text: 'Invoice', value: doc.documentNumber },
    { kind: 'meta', text: 'Date', value: issuedLine(doc.issuedAt) },
  ];

  if (doc.customerLabel)
    blocks.push({ kind: 'party', text: 'Billed to', value: doc.customerLabel });

  for (const item of doc.items) {
    blocks.push({
      kind: 'item',
      text: `${item.quantity} × ${item.name} @ ${formatKobo(item.unitPriceK)}`,
      value: formatKobo(Math.round(item.quantity * item.unitPriceK)),
    });
  }

  blocks.push({ kind: 'total', text: 'Subtotal', value: formatKobo(doc.subtotalK) });
  if (doc.discountK > 0) {
    blocks.push({ kind: 'total', text: 'Discount', value: `−${formatKobo(doc.discountK)}` });
  }
  if (doc.deliveryFeeK > 0) {
    blocks.push({ kind: 'total', text: 'Delivery', value: formatKobo(doc.deliveryFeeK) });
  }

  blocks.push({ kind: 'grand-total', text: 'Total', value: formatKobo(doc.totalK) });

  if (doc.paidK > 0) blocks.push({ kind: 'total', text: 'Paid', value: formatKobo(doc.paidK) });

  /**
   * The AMOUNT DUE box, and ONLY when something is due.
   *
   * The predecessor printed it always, which meant a fully paid receipt
   * carried a prominent box reading ₦0 — read across a counter that looks like
   * a demand for nothing, and merchants had to explain it. A zero balance is
   * good news and should read like it.
   */
  if (doc.balanceDueK > 0) {
    blocks.push({ kind: 'amount-due', text: 'AMOUNT DUE', value: formatKobo(doc.balanceDueK) });
  } else if (doc.paidK > 0) {
    blocks.push({ kind: 'memo', text: 'Paid in full. Thank you.' });
  }

  /**
   * The amount in words is the TOTAL, not the balance.
   *
   * It restates what the document is for, and a document is for its total.
   * Writing the balance here would make a part-paid invoice say a different
   * figure in words than in digits — the exact ambiguity words exist to close.
   */
  blocks.push({ kind: 'words', text: nairaInWords(doc.totalK) });

  if (doc.vatK > 0) {
    const rate = doc.vatRatePercent;
    blocks.push({
      kind: 'memo',
      // A memo, not a line: the VAT is already inside the total, and adding it
      // as a line invites a customer to add it again.
      text:
        rate === undefined
          ? `Includes VAT of ${formatKobo(doc.vatK)}`
          : `Includes VAT @ ${rate}% — ${formatKobo(doc.vatK)}`,
    });
  }

  /**
   * E&OE — errors and omissions excepted. Standard on Nigerian commercial
   * documents, and the merchant's protection against a clerical slip becoming
   * a binding promise.
   */
  blocks.push({ kind: 'footnote', text: 'E&OE' });

  return blocks;
}

/** `Page 1 of 3`, or nothing at all when there is only one page. */
export function pageLabel(page: number, total: number): string | null {
  return total > 1 ? `Page ${page} of ${total}` : null;
}
