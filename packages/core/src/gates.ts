/**
 * The conversation gates (MASTER-PLAN §5.3.4, CG1–CG5).
 *
 * These are the rules that stand between "the model understood something" and
 * "a document exists". They are pure because every one of them is a claim
 * about a merchant's money, and a claim about money should be checkable
 * without a database, a network or a model.
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
      `Is ${gap} a discount? Reply *yes*, or tell me the right total.`
    );
  }

  const gap = formatKobo(Math.abs(money.totalK - money.computedTotalK));
  return (
    `These do not add up:\n${items}\n` +
    `That comes to ${computed}, but you said ${stated}, which is ${gap} more.\n\n` +
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
    lines.push(`Paid over by ${formatKobo(money.overpaymentK)}. I will note it as a credit.`);
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

/* ── money going OUT: expenses and stock purchases ───────────────────────── */

export interface ExpenseLike {
  readonly description: string;
  /** Naira, as the human said it. */
  readonly amount: number;
  readonly category?: string | null;
  readonly paymentMethod?: string | null;
}

export interface PurchaseLike {
  readonly description: string;
  readonly amount: number;
  readonly supplierMention?: string | null;
  readonly reportedPayment?: number | null;
  /** Stock that arrived with the purchase, when the merchant counted it. */
  readonly productMention?: string | null;
  readonly quantity?: number | null;
}

/**
 * The outbound-money gates carry kobo, not a MoneyBlock — an expense has one
 * figure, not a sale's arithmetic, so reusing the sale's shape would mean
 * inventing a subtotal nobody stated.
 */
export type SpendGate =
  | { gate: 'CG1'; question: string }
  | { gate: 'CG2'; preview: string; amountK: number; paidK: number };

const toKobo = (naira: number): number => Math.round(naira * 100);

/**
 * CG2 for an expense — always a preview, never a question. One figure, no
 * arithmetic to disagree with; the merchant's testimony IS the number.
 * Confirm-first still applies in full: money leaving the books unread is the
 * same mistake as a document issued unread.
 */
export function gateExpense(expense: ExpenseLike): SpendGate {
  const amountK = toKobo(expense.amount);
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(`Expense: ${expense.description}`);
  if (expense.category) lines.push(`Category: ${expense.category}`);
  lines.push(`*Amount: ${formatKobo(amountK)}*`);
  lines.push(`Paid by ${expense.paymentMethod === 'transfer' ? 'transfer' : 'cash'}`);
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return { gate: 'CG2', preview: lines.join('\n'), amountK, paidK: amountK };
}

/**
 * A stock purchase, possibly partly on credit. The one arithmetic claim it can
 * make — "I paid more than it cost" — gets a CG1 question with the figures in
 * it, exactly like a sale that does not add up.
 */
export function gatePurchase(purchase: PurchaseLike): SpendGate {
  const amountK = toKobo(purchase.amount);
  const paidK = purchase.reportedPayment == null ? amountK : toKobo(purchase.reportedPayment);

  if (paidK > amountK) {
    return {
      gate: 'CG1',
      question:
        `You said the stock cost ${formatKobo(amountK)} but that you paid ` +
        `${formatKobo(paidK)}, which is ${formatKobo(paidK - amountK)} more.\n\n` +
        'Did I get a figure wrong? Tell me the right one.',
    };
  }

  const owedK = amountK - paidK;
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(`Stock: ${purchase.description}`);
  if (purchase.supplierMention) lines.push(`From: ${purchase.supplierMention}`);
  /* The delivery, named on its own line when the merchant counted it. A
   * purchase that moves stock and does not say so in the preview is a stock
   * change nobody confirmed. */
  const arriving = purchaseArrival(purchase);
  if (arriving) lines.push(`Adding to stock: ${arriving.quantity} ${arriving.productMention}`);
  lines.push(`*Amount: ${formatKobo(amountK)}*`);
  if (owedK > 0) {
    lines.push(`Paid: ${paidK > 0 ? formatKobo(paidK) : 'nothing yet'}`);
    lines.push(`Owing to supplier: ${formatKobo(owedK)}`);
  } else {
    lines.push('Paid in full');
  }
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return { gate: 'CG2', preview: lines.join('\n'), amountK, paidK };
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

/* ── money coming IN against an invoice already issued ───────────────────── */

export interface PaymentLike {
  /** Naira, as the human said it. Null when they said "half" or "the rest". */
  readonly amount?: number | null;
  /** Resolved HERE against the real balance, never by the model. */
  readonly relativeAmount?: 'half' | 'remainder' | null;
  readonly paymentMethod?: string | null;
}

export type PaymentGate =
  | { gate: 'CG1'; question: string }
  | { gate: 'CG2'; preview: string; amountK: number; balanceAfterK: number };

/**
 * A merchant reporting money received against an invoice they already issued.
 *
 * The balance is passed in from SQL rather than read here, so the resolution
 * of "half" and "the rest" is arithmetic over a real figure and stays a pure
 * function. The contract is explicit that this is core's job and not the
 * model's: a model that guesses what "the rest" means is a model deciding how
 * much a customer owes.
 *
 * Two things become CG1 questions rather than previews, both for the same
 * reason — the books must never absorb a number nobody confirmed:
 *   - no amount at all, absolute or relative;
 *   - more than the invoice still owes, which is a real event (change due, a
 *     credit for next time) that a merchant decides, not a rounding.
 */
export function gatePayment(
  payment: PaymentLike,
  invoiceNumber: string,
  balanceDueK: number,
): PaymentGate {
  const amountK =
    typeof payment.amount === 'number'
      ? toKobo(payment.amount)
      : payment.relativeAmount === 'remainder'
        ? balanceDueK
        : payment.relativeAmount === 'half'
          ? Math.round(balanceDueK / 2)
          : null;

  if (amountK === null || amountK <= 0) {
    return {
      gate: 'CG1',
      question: `How much did they pay on ${invoiceNumber}? It still has ${formatKobo(balanceDueK)} owing.`,
    };
  }

  if (amountK > balanceDueK) {
    return {
      gate: 'CG1',
      question:
        `${invoiceNumber} only has ${formatKobo(balanceDueK)} owing, and you said ` +
        `${formatKobo(amountK)}. Tell me the amount to record, or say *${formatKobo(balanceDueK)}* ` +
        'to settle it.',
    };
  }

  const balanceAfterK = balanceDueK - amountK;
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(`Payment on ${invoiceNumber}`);
  lines.push(`*Amount: ${formatKobo(amountK)}*`);
  lines.push(`Received by ${payment.paymentMethod === 'cash' ? 'cash' : 'transfer'}`);
  lines.push(
    balanceAfterK === 0
      ? 'This settles the invoice.'
      : `Still owing after this: ${formatKobo(balanceAfterK)}`,
  );
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return { gate: 'CG2', preview: lines.join('\n'), amountK, balanceAfterK };
}

/* ── stock ────────────────────────────────────────────────────────────────── */

export interface StockChangeLike {
  /** What the merchant called it. Matched to a product by the caller. */
  readonly productMention: string;
  /** Signed: positive is stock arriving, negative is stock leaving. */
  readonly quantityDelta: number;
}

export type StockGate =
  | { gate: 'CG1'; question: string }
  | { gate: 'CG2'; preview: string; quantityDelta: number; onHandAfter: number };

/**
 * A merchant correcting their own stock count.
 *
 * `onHand` is passed in from SQL rather than read here, for the same reason
 * `gatePayment` takes a balance: resolving "I have 5 left" into a movement is
 * arithmetic over a real figure, and a model that guessed at it would be a
 * model deciding what a merchant owns.
 *
 * Two things become CG1 questions instead of previews:
 *
 *   - A delta of zero, which is a sentence nobody meant to send.
 *   - A removal larger than the count on hand. Negative stock is not a number
 *     a shop can have, and it usually means the arrival was never recorded
 *     rather than that the count is wrong. Asking is cheap; a book that says
 *     minus four bags of rice is not correctable by the person reading it.
 */
export function gateStockChange(change: StockChangeLike, onHand: number): StockGate {
  const delta = Math.trunc(change.quantityDelta);

  if (delta === 0) {
    return {
      gate: 'CG1',
      question:
        `How many ${change.productMention} should I add or remove? ` +
        `You have ${onHand} on record now.`,
    };
  }

  if (onHand + delta < 0) {
    return {
      gate: 'CG1',
      question:
        `You have ${onHand} ${change.productMention} on record and asked me to take ` +
        `${Math.abs(delta)} away, which would leave less than none.\n\n` +
        'Tell me the right number, or add the stock that came in first.',
    };
  }

  const onHandAfter = onHand + delta;
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(
    delta > 0
      ? `Adding ${delta} ${change.productMention}`
      : `Removing ${Math.abs(delta)} ${change.productMention}`,
  );
  lines.push(`Was: ${onHand}`);
  lines.push(`*Now: ${onHandAfter}*`);
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return { gate: 'CG2', preview: lines.join('\n'), quantityDelta: delta, onHandAfter };
}

/**
 * The stock a purchase brings in, or null when it brings none.
 *
 * Both halves or neither: a quantity with no product is not a delivery
 * anybody can count, and a product with no quantity is not a number. A
 * purchase of a service, or one the merchant described only in prose, moves
 * no stock, and that is the ordinary case rather than a failure.
 */
export function purchaseArrival(
  purchase: PurchaseLike,
): { productMention: string; quantity: number } | null {
  const name = purchase.productMention?.trim();
  const quantity = Math.trunc(purchase.quantity ?? 0);
  if (!name || quantity <= 0) return null;
  return { productMention: name, quantity };
}
