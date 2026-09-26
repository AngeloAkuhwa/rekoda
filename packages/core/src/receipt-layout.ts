/**
 * What a receipt says, and in what order (docs/payments-v1.md §22).
 *
 * Same discipline as `invoice-layout.ts`: everything a reviewer would argue
 * about is decided here, in testable blocks, and the PDF renderer only turns
 * blocks into ink. The block kinds are shared with the invoice so one style
 * table in the renderer keeps the two documents from drifting apart.
 *
 * A receipt acknowledges a payment the business accepted (spec §15). Most are
 * written by `bookVerifiedPayment`, after the provider confirmed the charge
 * server-side; the rest are payments the MERCHANT reported (a recorded
 * payment, or money taken with a sale), written with `verified: false`. The
 * layout says which, out loud, because "confirmed, not claimed" is the entire
 * reason a customer can trust a verified receipt over a transfer screenshot.
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
  /**
   * Where a merchant-recorded overpayment's excess went, once G-49 books it:
   * `customer_credit` when the invoice's customer now holds it as credit,
   * `unattributed` when it is booked as owed but to nobody Rekoda can name.
   * Absent on every other receipt, including overpaid ones written before
   * G-49, which keep their neutral wording.
   */
  readonly excessDisposition?: 'customer_credit' | 'unattributed';
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
   *
   * The review-and-refund promise is made only where something keeps it: a
   * provider-verified overpayment goes to reconciliation. A payment the
   * MERCHANT reported, such as money taken with a sale, has no such
   * machinery behind it yet (G-49), so its receipt states the fact and
   * promises nothing.
   */
  if (doc.allocatedK < doc.amountK) {
    const remainingK = doc.amountK - doc.allocatedK;
    blocks.push({
      kind: 'total',
      text: `Applied to ${doc.invoiceNumber}`,
      value: formatKobo(doc.allocatedK),
    });
    if (doc.verified) {
      blocks.push({
        kind: 'memo',
        text: `The remaining ${formatKobo(remainingK)} is being reviewed and will be refunded or credited.`,
      });
    } else if (doc.excessDisposition === 'customer_credit') {
      /* Booked already (G-49): stated as a fact, not a promise. */
      blocks.push({ kind: 'total', text: 'Customer credit', value: formatKobo(remainingK) });
    } else if (doc.excessDisposition === 'unattributed') {
      blocks.push({ kind: 'total', text: 'Unapplied amount', value: formatKobo(remainingK) });
      blocks.push({ kind: 'memo', text: 'This amount is not linked to a customer yet.' });
    } else {
      blocks.push({
        kind: 'memo',
        text: `The remaining ${formatKobo(remainingK)} was not applied to this invoice.`,
      });
    }
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
