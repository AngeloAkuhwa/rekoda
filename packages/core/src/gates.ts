/**
 * The conversation gates (MASTER-PLAN §5.3.4, CG1–CG5).
 *
 * These are the rules that stand between "the model understood something" and
 * "a document exists". They are pure, and they are pure on purpose: every one
 * of them is a claim about a merchant's money, and a claim about money should
 * be checkable without a database, a network or a model.
 *
 * Inputs are structural rather than imported from `@rekoda/contracts` — a
 * `RecordSale` satisfies `SaleLike` without this package depending on the wire
 * schema. Domain rules should not need to know what shape a webhook uses.
 */
import { computeMoney, formatKobo, type MoneyBlock, type MoneyDraft } from './money.js';

export interface SaleItemLike {
  readonly name: string;
  readonly quantity: number;
  /** Naira, as the human said it. */
  readonly unitPrice: number;
}

export interface SaleLike {
  readonly items: readonly SaleItemLike[];
  readonly statedTotal?: number | null;
  readonly reportedPayment?: number | null;
  readonly discount?: number | null;
  readonly deliveryFee?: number | null;
  readonly customer?:
    { kind: 'token'; token: string } | { kind: 'mention'; mention: string } | { kind: 'none' };
}

/** Translate a parsed sale into the money engine's input. */
export function saleToDraft(sale: SaleLike): MoneyDraft {
  return {
    items: sale.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPriceNaira: item.unitPrice,
    })),
    ...(sale.discount == null ? {} : { discountNaira: sale.discount }),
    ...(sale.deliveryFee == null ? {} : { deliveryFeeNaira: sale.deliveryFee }),
    ...(sale.statedTotal == null ? {} : { statedTotalNaira: sale.statedTotal }),
    ...(sale.reportedPayment == null ? {} : { amountPaidNaira: sale.reportedPayment }),
  };
}

export type Gate =
  /** CG1 — the arithmetic disagrees with the human. One question, never a guess. */
  | { gate: 'CG1'; question: string; money: MoneyBlock }
  /** CG2 — nothing is issued unread. This is the text they must see first. */
  | { gate: 'CG2'; preview: string; money: MoneyBlock };

/** How a customer is named in a preview. Tokens are rehydrated at the send boundary. */
function nameOf(sale: SaleLike): string | null {
  const customer = sale.customer;
  if (!customer || customer.kind === 'none') return null;
  return customer.kind === 'token' ? customer.token : customer.mention;
}

function itemLine(item: SaleItemLike): string {
  const line = `${item.quantity} × ${item.name}`;
  if (item.unitPrice > 0) {
    const each = formatKobo(Math.round(item.unitPrice * 100));
    const total = formatKobo(Math.round(item.quantity * item.unitPrice * 100));
    return `${line} @ ${each} = ${total}`;
  }
  return line;
}

/**
 * CG1 — an arithmetic mismatch asks ONE specific, numbered question.
 *
 * The wrong behaviours here are both tempting. Silently trusting the stated
 * total buries the discrepancy in a document the merchant signs. Silently
 * trusting the arithmetic overrides a merchant who knows something we do not —
 * a haggled price, a returned item, a favour for a regular.
 *
 * So it asks, and it asks with the actual figures in the question, because
 * "the totals do not match" sends a merchant back to re-read their own message
 * while "you said ₦120,000 but the items come to ₦150,000" does not.
 */
function mismatchQuestion(sale: SaleLike, money: MoneyBlock): string {
  const items = sale.items.map(itemLine).join('\n');
  const computed = formatKobo(money.computedTotalK);
  const stated = formatKobo(money.totalK);

  if (money.impliedDiscountK > 0) {
    const gap = formatKobo(money.impliedDiscountK);
    return (
      `These do not add up:\n${items}\n` +
      `That comes to ${computed}, but you said ${stated}.\n\n` +
      `Is ${gap} a discount? Reply *yes* — or tell me the right total.`
    );
  }

  const gap = formatKobo(Math.abs(money.totalK - money.computedTotalK));
  return (
    `These do not add up:\n${items}\n` +
    `That comes to ${computed}, but you said ${stated} — ${gap} more.\n\n` +
    `Did I get a price wrong? Tell me the right one.`
  );
}

/**
 * CG2 — the preview a merchant must see before anything is issued.
 *
 * Every figure that will appear on the document appears here, in the order a
 * Nigerian receipt reads: who, what, total, paid, balance. A preview that
 * omits a line is worse than no preview, because it teaches the merchant that
 * skimming is safe.
 */
function previewOf(sale: SaleLike, money: MoneyBlock): string {
  const lines: string[] = ['Please check this before I save it:', ''];

  const who = nameOf(sale);
  if (who) lines.push(who);
  lines.push(...sale.items.map(itemLine));

  if (money.discountK > 0) lines.push(`Discount: −${formatKobo(money.discountK)}`);
  if (money.deliveryFeeK > 0) lines.push(`Delivery: ${formatKobo(money.deliveryFeeK)}`);

  lines.push(`*Total: ${formatKobo(money.totalK)}*`);

  if (money.amountPaidK > 0) {
    lines.push(`Paid: ${formatKobo(money.amountPaidK)}`);
    lines.push(`Balance: ${formatKobo(money.balanceDueK)}`);
  } else {
    lines.push('Paid: nothing yet');
  }

  /**
   * An overpayment is surfaced, never rounded away. It is a real event with a
   * real business meaning — change owed, or a credit against the next order —
   * and the merchant is the one who decides which.
   */
  if (money.overpaymentK > 0) {
    lines.push(`Paid over by ${formatKobo(money.overpaymentK)} — I will note it as a credit.`);
  }

  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return lines.join('\n');
}

/**
 * Which gate this sale is behind.
 *
 * CG1 before CG2, always: a preview of numbers we already know are wrong is a
 * request to approve a mistake.
 */
export function gateSale(sale: SaleLike): Gate {
  const money = computeMoney(saleToDraft(sale));
  if (money.mismatch) {
    return { gate: 'CG1', question: mismatchQuestion(sale, money), money };
  }
  return { gate: 'CG2', preview: previewOf(sale, money), money };
}

/**
 * CG5 — is this message correcting the draft, or starting a new one?
 *
 * The distinction matters because the two have opposite effects: a correction
 * REPLACES a pending draft, and a new command leaves the old one alone. Get it
 * backwards and a merchant fixing a quantity loses the sale they were fixing.
 *
 * Deliberately conservative. A message that only reads as a correction because
 * it begins with "no" is one; a message that names goods and an amount is a
 * new sale even if it opens with "no". When neither is clear the safe answer
 * is `false`, because treating a new sale as a correction destroys a record
 * that was never previewed.
 */
const CORRECTION_OPENERS =
  /^\s*(?:no+|nope|nah|actually|sorry|wait|correction|not|it(?:'| i)?s not|e no be)\b/i;

const CORRECTION_PHRASES =
  /\b(?:not|instead of|rather than|change (?:it |the )?to|make it|should be)\b/i;

export function looksLikeCorrection(text: string, hasPendingDraft: boolean): boolean {
  if (!hasPendingDraft) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return CORRECTION_OPENERS.test(trimmed) || CORRECTION_PHRASES.test(trimmed);
}
