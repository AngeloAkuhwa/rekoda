/**
 * What a receipt says, and in what order (docs/payments-v1.md §22).
 *
 * Same discipline as `invoice-layout.ts`: everything a reviewer would argue
 * about is decided here, in testable blocks, and the PDF renderer only turns
 * blocks into ink. The block kinds are shared with the invoice so one style
 * table in the renderer keeps the two documents from drifting apart.
 *
 * A receipt exists because money REALLY moved: it is only ever written by
 * `bookVerifiedPayment`, after the provider confirmed the charge server-side.
 * The layout says so out loud, because "confirmed, not claimed" is the entire
 * reason a customer can trust this piece of paper over a transfer screenshot.
 */
import { formatKobo } from './money.js';
import { nairaInWords } from './words.js';
import type { LayoutBlock } from './invoice-layout.js';

export interface ReceiptDocument {
  readonly documentNumber: string;
  readonly issuedAt: Date;
  readonly businessName: string;
  /** The obligation this money answered. */
  readonly invoiceNumber: string;
  /**
   * The RKD-PAY reference — what support and the provider both search by.
   * Empty for a payment the merchant reported: there is no provider record
   * to search, and an empty labelled line is worse than no line.
   */
  readonly reference: string;
  /** What arrived, in kobo. */
  readonly amountK: number;
  /** What was applied to the invoice — less than `amountK` on an overpayment. */
  readonly allocatedK: number;
  /**
   * Whether a PROVIDER confirmed this money, server to server (ADR 0014).
   *
   * The whole difference between the two receipts this product issues. A
   * VERIFIED one can say so and that claim is what separates it from a
   * screenshot; a RECORDED one is the merchant's own word about cash at the
   * counter, and saying otherwise on a document they forward to the customer
   * would be a lie printed on their letterhead.
   */
  readonly verified: boolean;
}

function issuedLine(at: Date): string {
  return at.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The document, top to bottom: who received the money, the receipt's own
 * number, when, for which invoice, under what reference — then the figure,
 * once, big, and restated in words so nobody can move a comma.
 */
export function layoutReceipt(doc: ReceiptDocument): LayoutBlock[] {
  const blocks: LayoutBlock[] = [
    { kind: 'title', text: doc.businessName },
    { kind: 'meta', text: 'Receipt', value: doc.documentNumber },
    { kind: 'meta', text: 'Date', value: issuedLine(doc.issuedAt) },
    { kind: 'meta', text: 'For invoice', value: doc.invoiceNumber },
  ];

  // Only when there is one. A "Payment reference" line printed blank invites
  // the reader to think something failed.
  if (doc.reference) {
    blocks.push({ kind: 'meta', text: 'Payment reference', value: doc.reference });
  }

  blocks.push(
    { kind: 'grand-total', text: 'Amount received', value: formatKobo(doc.amountK) },
    { kind: 'words', text: nairaInWords(doc.amountK) },
  );

  /**
   * Overpayment, stated rather than absorbed. The books applied only the
   * invoice's balance (settle.ts is conservative by design); a receipt that
   * silently showed the full figure as "applied" would claim the merchant may
   * keep money a human has not yet ruled on.
   */
  if (doc.allocatedK < doc.amountK) {
    blocks.push({
      kind: 'total',
      text: `Applied to ${doc.invoiceNumber}`,
      value: formatKobo(doc.allocatedK),
    });
    blocks.push({
      kind: 'memo',
      text: `The remaining ${formatKobo(doc.amountK - doc.allocatedK)} is being reviewed and will be refunded or credited.`,
    });
  }

  /**
   * The trust line, and it says only what is true of THIS receipt.
   *
   * On a verified payment it is what separates a Rekoda receipt from a
   * screenshot: the provider was asked, server to server, before this
   * document existed. On one the merchant reported it says that instead, so
   * the customer holding it knows exactly whose word it rests on.
   */
  blocks.push({
    kind: 'memo',
    text: doc.verified
      ? 'Payment confirmed with the payment provider before this receipt was issued.'
      : 'Recorded by the seller from their own records. Not confirmed with a payment provider.',
  });

  blocks.push({ kind: 'footnote', text: 'E&OE' });

  return blocks;
}
