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
import {
  computeMoney,
  formatKobo,
  nairaToKobo,
  type MoneyBlock,
  type MoneyDraft,
} from './money.js';
import { commandPurchaseReference, describePurchaseReference } from './purchase-identity.js';

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
function previewOf(sale: SaleLike, money: MoneyBlock, customerLinked: boolean): string {
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
    /* A promise the write can keep (G-49): customer credit needs a customer
     * RECORD the sale resolves to, which only the caller can look up (a token
     * alone may name nobody on file). Otherwise the excess is booked as a
     * liability that is not linked to anyone yet, and the preview says so. */
    lines.push(
      customerLinked
        ? `Paid over by ${formatKobo(money.overpaymentK)}. I will note it as a credit.`
        : `Paid over by ${formatKobo(money.overpaymentK)}. I will record it as unapplied; it is not linked to a customer yet.`,
    );
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
export function gateSale(sale: SaleLike, options: { customerLinked?: boolean } = {}): Gate {
  const money = computeMoney(saleToDraft(sale));
  if (money.mismatch) {
    return { gate: 'CG1', question: mismatchQuestion(sale, money), money };
  }
  return {
    gate: 'CG2',
    preview: previewOf(sale, money, options.customerLinked === true),
    money,
  };
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
  /**
   * How the PAID part left the business, as the merchant said it (G-61).
   * Only cash and transfer name an account Rekoda posts to; anything else,
   * including nothing, is not known, and a paid amount then needs asking.
   */
  readonly paymentMethod?: string | null | undefined;
  /** The supplier's own document number, when one was stated (G-81). */
  readonly supplierReference?: string | null | undefined;
}

/**
 * The outbound-money gates carry kobo, not a MoneyBlock — an expense has one
 * figure, not a sale's arithmetic, so reusing the sale's shape would mean
 * inventing a subtotal nobody stated.
 */
export type SpendGate =
  | {
      gate: 'CG1';
      question: string;
      /**
       * Set when the merchant answers the question by sending the purchase
       * AGAIN (G-61): the funding-source clarification, and the ₦0 amount.
       * The draft that raised it must never stay confirmable beside the
       * replacement. Unset for a question answered some other way.
       */
      reason?: 'funding_source' | 'zero_amount';
    }
  | {
      gate: 'CG2';
      preview: string;
      amountK: number;
      paidK: number;
      /** The account the paid part leaves. Null only when nothing was paid. */
      method: 'cash' | 'transfer' | null;
    };

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
  const method = expense.paymentMethod === 'transfer' ? 'transfer' : 'cash';
  lines.push(`Paid by ${method}`);
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return { gate: 'CG2', preview: lines.join('\n'), amountK, paidK: amountK, method };
}

/**
 * A stock purchase, possibly partly on credit. The one arithmetic claim it can
 * make — "I paid more than it cost" — gets a CG1 question with the figures in
 * it, exactly like a sale that does not add up.
 */
export function gatePurchase(
  purchase: PurchaseLike,
  /**
   * Whether the funding-source question may offer the short answer
   * ("Reply *bank* or *cash*"). Only while Rekoda can still take that answer
   * (G-68): a question re-asked after its answer window offers only the
   * send-it-again wording, so it never promises what cannot work.
   */
  options: { shortAnswer?: boolean } = {},
): SpendGate {
  const shortAnswer = options.shortAnswer ?? true;
  const amountK = toKobo(purchase.amount);
  /* Nothing costs nothing: a ₦0 purchase cannot be posted (a ledger line
   * must carry a debit or a credit, migration 0070), so it is asked about,
   * never previewed. */
  if (amountK === 0) {
    return {
      gate: 'CG1',
      reason: 'zero_amount',
      question:
        'I read the stock as costing ₦0, which I cannot record. What did it cost?' +
        '\n\nRecord it again with the amount, for example: ' +
        '"bought 10 cartons from Emeka for 180k, paid transfer".',
    };
  }
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

  /*
   * Where the paid part came from (G-61). Cash on Hand and Bank are different
   * lines on the balance sheet, so a payment whose account nobody named is a
   * question, never a default. With nothing paid there is no account to name,
   * and none is asked for or shown.
   */
  const method =
    purchase.paymentMethod === 'cash' || purchase.paymentMethod === 'transfer'
      ? purchase.paymentMethod
      : null;
  if (paidK > 0 && method === null) {
    /*
     * POS or card names the CHANNEL, not the account the money left, and the
     * books need the account (owner ruling OWN-17): money out of the
     * bank is Bank, physical cash is Cash. Asking "cash or transfer?" again
     * of somebody who just said POS would loop, so they are asked where the
     * money came from, and shown how to say it.
     */
    if (purchase.paymentMethod === 'pos') {
      return {
        gate: 'CG1',
        reason: 'funding_source',
        question:
          'I know you paid by POS. I just need the source of the money for your books: ' +
          'did it come from your bank account or from physical cash?' +
          (shortAnswer
            ? '\n\nReply *bank* or *cash*, or record it again with where the money came '
            : '\n\nRecord it again with where the money came ') +
          'from, for example: ' +
          '"bought 10 cartons from Emeka for 180k, paid by POS from my bank account".',
      };
    }
    return {
      gate: 'CG1',
      reason: 'funding_source',
      question:
        (purchase.reportedPayment == null
          ? `For the ${formatKobo(amountK)} stock, did you pay it all by cash or by transfer? ` +
            'If you have not paid it all yet, say how much you paid.'
          : `You paid ${formatKobo(paidK)} for this stock. Was that cash or transfer?`) +
        (shortAnswer
          ? '\n\nReply *cash* or *transfer*, or record it again with how you paid, for example: '
          : '\n\nRecord it again with how you paid, for example: ') +
        '"bought 10 cartons from Emeka for 180k, paid transfer".',
    };
  }

  const owedK = amountK - paidK;
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(`Stock: ${purchase.description}`);
  if (purchase.supplierMention) lines.push(`From: ${purchase.supplierMention}`);
  /* Shown so the merchant sees the reference Rekoda read and will put on the
   * bill. It never tells two purchases of one total apart (OWN-32, G-92(5)):
   * the same total inside the window is asked SAME or SEPARATE. Exactly as it will be stored and put on the bill, by its kind and
   * number ("Invoice 2231"), never as written: a reference dropped as an
   * amount is never shown, and no letters the merchant or a photo wrote
   * reach the preview text (final-head review of ffb5404; was G-92(2)). */
  const reference = describePurchaseReference(commandPurchaseReference(purchase));
  if (reference) lines.push(`Reference: ${reference.replace(/^Reference /u, '')}`);
  /* The delivery, named on its own line when the merchant counted it. A
   * purchase that moves stock and does not say so in the preview is a stock
   * change nobody confirmed. */
  const arriving = purchaseArrival(purchase);
  if (arriving) lines.push(`Adding to stock: ${arriving.quantity} ${arriving.productMention}`);
  lines.push(`*Amount: ${formatKobo(amountK)}*`);
  if (owedK > 0) {
    lines.push(`Paid: ${paidK > 0 ? `${formatKobo(paidK)} by ${method}` : 'nothing yet'}`);
    lines.push(`Owing to supplier: ${formatKobo(owedK)}`);
  } else {
    lines.push(`Paid in full by ${method}`);
  }
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  /* Nothing paid: no account is funded, whatever the model reported. */
  return {
    gate: 'CG2',
    preview: lines.join('\n'),
    amountK,
    paidK,
    method: paidK > 0 ? method : null,
  };
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
/* After a "not": the words that only state a new record's state ("not paid yet", "not fully paid
 * yet", "not delivered"), unless a figure follows ("not paid 50k" negates an amount). Shared by the
 * phrase and both opener patterns, so an opening "Not paid yet, bought fuel 5k" is a new record as
 * the same words later in the message are (CodeRabbit on #437 at b2703e7). */
const NOT_A_STATE =
  '(?!\\s+(?:(?:yet|fully|completely)\\s+)*(?:yet|paid|delivered|collected|picked\\s+up)\\b(?!\\s+(?:paid|delivered|collected|picked)\\b)(?!\\s*(?:₦|NGN|N)?\\s*\\d))';

const CORRECTION_OPENERS = new RegExp(
  `^\\s*(?:no+|nope|nah|actually|sorry|wait|correction|not${NOT_A_STATE}|it(?:'| i)?s not${NOT_A_STATE}|e no be)\\b`,
  'i',
);

/* A "not" that only says a new record's state ("sold 2 bags for 20k, not paid yet", "not fully
 * paid yet") is not a correction cue: such a message is an ordinary new record, never asked about
 * (owner ruling OWN-102(2): obvious new transactions are not asked about). A "not" that negates an
 * amount ("Bola has not paid 50k, he only paid 5k") still is one (Codex and CodeRabbit on #437 at
 * ccdcc8e). */
const CORRECTION_PHRASES = new RegExp(
  `\\b(?:not${NOT_A_STATE}|instead of|rather than|change (?:it |the )?to|make it|should be)\\b`,
  'i',
);

/* The openers that say on their own that the merchant is correcting ("no", "sorry", "it's not").
 * "Wait" and "actually" only hesitate: "Wait, I also sold 2 bags" is as likely a new record. */
const EXPLICIT_OPENERS = new RegExp(
  `^\\s*(?:no+|nope|nah|sorry|correction|not${NOT_A_STATE}|it(?:'| i)?s not${NOT_A_STATE}|e no be)\\b`,
  'i',
);
/* Words that add a record rather than change one: after any opener ("Sorry, I also sold 2 bags"),
 * the message is as likely a new record, so the opener alone is no evidence (CodeRabbit on #437 at
 * cacc734). */
const ADDS_A_RECORD = /\b(?:also|another|more|extra|too|again|additional|plus)\b/i;

/**
 * Whether a message that reads like a correction says so explicitly (OD-60 A+, owner ruling
 * OWN-102(2), 22 Nov 2026): an explicit opener ("no, it was Bola not Ada"), a correction phrase
 * ("4 wigs instead of 3", "make it 5") or a clear correction. A message whose only cue is a
 * hesitation ("Wait, I also sold 2 bags for 20k") is ambiguous: it is asked whether it changes the
 * waiting record or is another one, and changes nothing.
 */
export function explicitlyCorrects(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  /* A correction phrase alone says nothing explicit: "Sold 2 bags for 20k, total should be 20k" is
   * as likely a new sale as a change, and "Wait, I also bought fuel for 6k, total should be 6k" adds
   * (CodeRabbit on #437 at aff3f63 and b2703e7). Only a whole-message correction
   * (`clearlyCorrects`: "make it 5", "4 wigs instead of 3") or an explicit opener counts. */
  return (
    (EXPLICIT_OPENERS.test(trimmed) && !ADDS_A_RECORD.test(trimmed)) || clearlyCorrects(trimmed)
  );
}

export function looksLikeCorrection(text: string, hasPendingDraft: boolean): boolean {
  if (!hasPendingDraft) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  /* A whole-message correction `clearlyCorrects` accepts ("change the price to 60k") is one here
   * too, so it reaches the same CG5 gates (Codex and CodeRabbit on #437 at fa62d87). */
  return (
    CORRECTION_OPENERS.test(trimmed) || CORRECTION_PHRASES.test(trimmed) || clearlyCorrects(trimmed)
  );
}

/**
 * Whether a message CLEARLY corrects the draft before it (CG5, owner ruling OWN-100), the bar a
 * correction must meet to keep that draft's customer. Stricter than `looksLikeCorrection`, whose
 * bare "not" anywhere also matches a new request ("Sold 2 bags for 20k, not paid yet").
 *
 * The WHOLE message must be a short correction and nothing else (independent review of #437 at
 * b5079a8): an optional opener ("no", "sorry", "wait"), then one of
 *  - "should be", "make it" or "change it to" a figure ("the price should be 60k", "make it 5 wigs");
 *  - one figure instead of / rather than another ("5 wigs instead of 3");
 *  - one figure not another ("4 not 3", "it was 60k not 50k", "she paid 60k not 50k").
 * A figure may carry ₦, N or NGN, commas, a decimal point and "k", and at most one word after it
 * that is not a time or a date ("5pm", "2 days", "tomorrow", "25 Dec" are never figures here).
 * Anything else, whatever wording it contains ("Sold 5 bags, 10k each, total should be 50k"), is
 * not clearly a correction and is asked about: listing new-sale wordings can never be complete, so
 * the shape of a correction is allowed and everything else is refused.
 */
/* A decimal needs a currency sign, a k/m suffix or a measuring unit after it ("2.5 kg"; CodeRabbit
 * on #437 at 400ca58). A bare "4.30" is a time. The units are the measuring ones of `UNIT_WORDS`. */
const MEASURE_UNIT = String.raw`(?:kgs?|g|l|lit(?:re|er)s?|yards?|met(?:re|er)s?)`;
const FIG = String.raw`(?:(?:₦|NGN|N)\s*\d[\d,]*(?:\.\d+)?(?:\s*[km](?![a-z0-9]))?|\d[\d,]*\.\d+\s*[km](?![a-z0-9])|\d[\d,]*\.\d+(?=\s*${MEASURE_UNIT}\b)|\d[\d,]*(?:\s*[km](?![a-z0-9]))?)`;
const TIME_WORD = String.raw`(?:am|pm|o'?clock|h|hrs?|hours?|mins?|minutes?|s|secs?|seconds?|days?|weeks?|months?|years?|st|nd|rd|th|today|tomorrow|tonight|noon|midnight|morning|evening|night|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)`;
/* A figure, then at most one word that is not a time or a date ("4 wigs", "4pcs", "60k each"). */
/* Words that add to the draft or start another one ("5 more", "5 also", "another") never fill it,
 * nor do words that count records or people ("2 sales", "2 customers", "2 separate"): a request to
 * restructure, not a field corrected. */
const ADDING_WORD = String.raw`(?:more|extra|also|too|again|another|new|additional|plus|and|other|others|sales?|orders?|invoices?|receipts?|payments?|customers?|people|persons?|transactions?|times|different|separate)`;
const AMOUNT = String.raw`${FIG}(?:\s*(?!(?:${TIME_WORD}|${ADDING_WORD})\b)[a-z]+)?`;
const OPENER = String.raw`(?:(?:no+|nope|nah|sorry|wait|actually|correction|oh|ok|okay|e no be)\b[\s,.!:;-]*)*`;
/* Who or which field is corrected: a closed list, never "the other" or "the new" (another sale). */
const FIELD = String.raw`(?:price|unit\s+price|total|amount|quantity|qty|balance|cost|rate|discount|delivery\s+fee|payment)`;
const SUBJECT = String.raw`(?:(?:it|she|he|they|(?:the\s+)?${FIELD})\s+)?`;
const CLEAR_CORRECTION = new RegExp(
  String.raw`^${OPENER}(?:` +
    String.raw`${SUBJECT}(?:should\s+be|make\s+it|change\s+(?:it\s+|(?:the\s+)?${FIELD}\s+)?to)\s+${AMOUNT}(?:,?\s+not\s+${AMOUNT})?` +
    String.raw`|${AMOUNT}\s+(?:instead\s+of|rather\s+than)\s+${AMOUNT}` +
    /* No "for <word>": "4 for Bola, not 3" names someone, and the grammar cannot tell a name from
     * an item ("4 for shoes"), so it is asked about (CodeRabbit on #437 at ebeeadb). */
    String.raw`|(?:(?:it\s+was|it'?s|it\s+is|(?:she|he|they)\s+paid|paid)\s+)?${AMOUNT},?\s+not\s+${AMOUNT}` +
    String.raw`)\s*[.!]*$`,
  'i',
);

/** A correction is a line, never a paragraph: anything longer is asked about, in constant time. */
const MAX_CORRECTION_LENGTH = 80;

export function clearlyCorrects(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_CORRECTION_LENGTH) return false;
  return CLEAR_CORRECTION.test(trimmed);
}

/* The words a clear correction is built from, which say nothing about who or what. */
const STRUCTURE_WORDS = new Set([
  'no',
  'noo',
  'nooo',
  'nope',
  'nah',
  'sorry',
  'wait',
  'actually',
  'correction',
  'oh',
  'ok',
  'okay',
  'e',
  'be',
  'should',
  'make',
  'it',
  'change',
  'to',
  'the',
  'instead',
  'of',
  'rather',
  'than',
  'not',
  'was',
  'is',
  's',
  'she',
  'he',
  'they',
  'paid',
  'k',
  'n',
  'ngn',
  'price',
  'unit',
  'total',
  'amount',
  'quantity',
  'qty',
  'balance',
  'cost',
  'rate',
  'discount',
  'delivery',
  'fee',
  'payment',
]);
/* Units and counting words a figure may carry whatever was sold ("60k each", "4pcs"). */
const UNIT_WORDS = new Set([
  'each',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'unit',
  'units',
  'item',
  'items',
  'naira',
  'pack',
  'packs',
  'carton',
  'cartons',
  'dozen',
  'kg',
  'kgs',
  'g',
  'l',
  'litre',
  'litres',
  'liter',
  'liters',
  'yard',
  'yards',
  'metre',
  'metres',
  'meter',
  'meters',
  'set',
  'sets',
  'pair',
  'pairs',
]);
const WORD = /\p{L}+/gu;

/**
 * Whether every word of a clear correction is explained by the draft it corrects (CG5, OWN-100:
 * "the correction names no other customer"). A figure may carry one word, and nothing in the
 * grammar tells "make it 5 wigs" from "make it 5 Tunde": the word must be one of the structure
 * words, a unit, or a plural form of a word of the waiting draft itself (`vocabulary`, its items
 * and products, no names): "wigs" for "wig". Any other word may be a person, so the correction is
 * asked about and inherits nobody (independent review of #437 at ebeeadb).
 *
 * The bare item word itself never explains a correction (OD-63(a) Option B, owner ruling 22 Nov
 * 2026): an item may be named like a person ("Tunde"), and nothing in "4 Tunde not 3" tells the
 * item from somebody else, so it is asked about. The cost is accepted: "make it 4 ankara" for an
 * ankara sale is asked about once.
 */
export function correctionWordsExplained(text: string, vocabulary: Iterable<string>): boolean {
  const known = new Set<string>();
  for (const phrase of vocabulary) {
    for (const w of phrase.toLowerCase().match(WORD) ?? []) known.add(w);
  }
  const lower = text.toLowerCase();
  /* Where a word stands right after a figure ("4 Price"), it is the free item-word position. The
   * figure includes its currency suffix ("4k Price", "1.6m Price"), and leaves whole item words
   * such as "kits" and "mugs" to the vocabulary check. */
  const afterFigure = new Set<number>();
  const suffixes = new Set<number>();
  for (const m of lower.matchAll(/\d[\d,.]*(?:\s*([km])(?![\p{L}\p{N}]))?\s*/gu)) {
    afterFigure.add(m.index + m[0].length);
    if (m[1]) suffixes.add(m.index + m[0].trimEnd().length - 1);
  }
  const explained = (word: string, at: number): boolean => {
    if (suffixes.has(at)) return true;
    /* The bare item word in the item-word position: an item named "Price" or "Set" is still the
     * bare item word there, never a structure or unit word (CodeRabbit on #437 at ccdcc8e). A
     * grammatical word elsewhere ("change the price to 60k" for "ready to wear") is the grammar
     * (CodeRabbit on #437 at 9c587bd). */
    if (known.has(word) && (afterFigure.has(at) || !STRUCTURE_WORDS.has(word))) return false;
    if (STRUCTURE_WORDS.has(word) || UNIT_WORDS.has(word)) return true;
    for (const k of known) {
      if (k.length < 3) continue;
      if (word === `${k}s` || word === `${k}es`) return true;
    }
    return false;
  };
  return [...lower.matchAll(WORD)].every((m) => explained(m[0], m.index));
}

/**
 * The figures a waiting draft holds, which a correction may say were wrong (OD-67 Option B, owner
 * ruling OWN-103(3), 22 Nov 2026). Money is integer kobo, converted once from the contract's naira
 * (`nairaToKobo`); quantities are counts. The two are kept apart: "4 not 3" against a sale of 3 wigs
 * replaces a quantity, never a ₦3 price.
 */
export interface DraftFigures {
  readonly moneyKobo: readonly number[];
  readonly quantities: readonly number[];
}

/* A sale's money as its preview computes it (`gateSale`), or null when its lines are not all
 * numbers the preview could have shown. */
function saleFigures(
  command: Record<string, unknown>,
  items: readonly unknown[],
): MoneyBlock | null {
  const lines: SaleItemLike[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const { name, quantity, unitPrice } = item as Record<string, unknown>;
    if (typeof quantity !== 'number' || typeof unitPrice !== 'number') return null;
    lines.push({ name: typeof name === 'string' ? name : '', quantity, unitPrice });
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  try {
    return computeMoney(
      saleToDraft({
        items: lines,
        discount: num(command['discount']),
        deliveryFee: num(command['deliveryFee']),
        statedTotal: num(command['statedTotal']),
        reportedPayment: num(command['reportedPayment']),
      }),
    );
  } catch {
    return null;
  }
}

export function draftFigures(command: Record<string, unknown>): DraftFigures {
  const money: number[] = [];
  const quantities: number[] = [];
  const naira = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000_000_000) return null;
    return nairaToKobo(v);
  };
  const addMoney = (v: unknown) => {
    const k = naira(v);
    if (k !== null) money.push(k);
  };
  const addQuantity = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) quantities.push(v);
  };
  const items = Array.isArray(command['items']) ? (command['items'] as unknown[]) : [];
  let gross: number | null = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const { quantity, unitPrice } = item as { quantity?: unknown; unitPrice?: unknown };
    addQuantity(quantity);
    const each = naira(unitPrice);
    if (each === null) {
      if (unitPrice !== undefined) gross = null;
      continue;
    }
    money.push(each);
    /* A line total as the preview shows it: rounded to the kobo the same way (`itemLine`), so a
     * fractional line ("1.5 kg at ₦10.25") is the ₦15.38 the merchant saw (CodeRabbit on #437 at
     * d80426e). */
    const line =
      typeof quantity === 'number' && typeof unitPrice === 'number'
        ? Math.round(quantity * unitPrice * 100)
        : NaN;
    if (Number.isSafeInteger(line)) {
      money.push(line);
      if (gross !== null) gross += line;
    } else {
      gross = null;
    }
  }
  /* A sale's preview shows its line totals and `computeMoney`'s total, never the lines' sum or the
   * sum less discount plus delivery as such (CodeRabbit on #437 at 1ec5a22): those are figures of a
   * sale only through `saleFigures` below. Other records keep the rebuilt sums. */
  const isSale = command['intent'] === 'RecordSale' && items.length > 0;
  if (!isSale && gross !== null && gross > 0) {
    money.push(gross);
    const discount = naira(command['discount']) ?? 0;
    const delivery = naira(command['deliveryFee']) ?? 0;
    if (discount || delivery) money.push(gross - discount + delivery);
  }
  for (const key of ['statedTotal', 'reportedPayment', 'discount', 'deliveryFee', 'amount']) {
    addMoney(command[key]);
  }
  const quantity = command['quantity'];
  if (command['intent'] === 'RecordPurchase') {
    /* The balance the preview shows as "Owing to supplier" is a figure the merchant saw
     * (CodeRabbit on #437 at 600a155). */
    const amountK = naira(command['amount']);
    const paidK = naira(command['reportedPayment']);
    if (amountK !== null && paidK !== null && amountK > paidK) money.push(amountK - paidK);
    const productMention = command['productMention'];
    if (typeof productMention === 'string' && typeof quantity === 'number') {
      addQuantity(stockArrival(productMention, quantity)?.quantity);
    }
  } else {
    addQuantity(quantity);
  }
  /* The balance a part-paid sale preview shows, from the same `computeMoney` the preview uses
   * (CodeRabbit on #437 at 400ca58). Shown only when something was paid and something is owed. */
  if (command['intent'] === 'RecordSale' && items.length > 0) {
    const sale = saleFigures(command, items);
    if (sale) {
      /* The total the preview shows is `computeMoney`'s, which rounds the unit price to the kobo
       * first, so it can differ by a kobo from the gross rebuilt above ("1.5 at ₦0.29" is ₦0.44
       * there, ₦0.43 here). It is a figure the merchant saw whether or not anything was paid, and
       * a CG1 question shows both the stated and the computed total (CodeRabbit on #437). */
      money.push(sale.totalK);
      if (sale.mismatch) money.push(sale.computedTotalK);
    }
    /* A sale whose figures disagree goes to the CG1 question, which shows no balance. */
    if (sale && !sale.mismatch && sale.amountPaidK > 0 && sale.balanceDueK > 0) {
      money.push(sale.balanceDueK);
    }
    /* "Paid over by ₦…" is shown on the preview, so it is a figure the merchant saw. */
    if (sale && !sale.mismatch && sale.overpaymentK > 0) money.push(sale.overpaymentK);
  }
  /* A stock adjustment's preview shows its count ("Adding 3"), whichever way it moves (Codex on
   * #437 at af169b0). */
  const delta = command['quantityDelta'];
  if (typeof delta === 'number') addQuantity(Math.abs(delta));
  return { moneyKobo: money, quantities };
}

/* A figure a correction says was wrong: after "not", "instead of" or "rather than" ("4 not 3",
 * "no, 60k not 50k", "Not paid 5k, it was 4k"), with at most one word after it. */
/* A figure never ends on a comma: "3, amount 60" is the figure 3, then another clause. */
/* A figure keeps its thousands or millions suffix ("5k", "1.5m"; CodeRabbit on #437 at d80426e). */
const FIGURE_TEXT = String.raw`(?:₦|ngn|n)?\s*\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s*[km](?![\p{L}\p{N}]))?`;
/* A figure a correction says was wrong: after "not", "instead of" or "rather than", past a word or
 * two that only points at it ("not the 5k", "not paid 5k", "it was 60k not that 50k"), with at most
 * one word after it. */
const REPLACED_FIGURE = new RegExp(
  String.raw`(?:\bnot\s+(?:(?:the|that|this|it|its|it's|was|paid)\s+){0,2}|\binstead\s+of\s+(?:the\s+)?|\brather\s+than\s+(?:the\s+)?)(${FIGURE_TEXT})(?:\s*([\p{L}]+))?`,
  'giu',
);
/* Every figure in a stretch of text, with the word after it: the last one before a "not" is the
 * figure that replaces what follows. */
const ANY_FIGURE = new RegExp(String.raw`(${FIGURE_TEXT})(?:\s*([\p{L}]+))?`, 'giu');
/* A "not", "instead of" or "rather than" a figure follows closely: each one must be read above, or
 * the correction cannot be checked and is asked about. */
const NEGATED_FIGURE = /\b(?:not|instead\s+of|rather\s+than)\b[^\d.!?]{0,12}\d/giu;
const MONEY_WORDS = new Set(['naira', 'each', 'k']);
const MONEY_FIELD =
  /\b(?:price|total|amount|balance|cost|rate|discount|fee|payment|paid|pay|charge)\b/iu;
const QUANTITY_FIELD = /\b(?:quantity|qty|pieces|pcs|units|count)\b/iu;

/** A figure's kind from how it is written: money (₦, NGN, "k", "m", "naira", "each"), a quantity
 * (a unit after it: "3 pcs", "1.5 kg"), or nothing said ("3", "3 wigs", "1.5"). A unit wins over a
 * decimal point: "1.5 kg" is a weight, never ₦1.50 (CodeRabbit on #437 at d80426e). */
function figureKind(figure: string, word: string | undefined): 'money' | 'quantity' | null {
  const f = figure.toLowerCase();
  if (/^(?:₦|ngn|n)/u.test(f) || /[km]$/u.test(f)) return 'money';
  const w = word?.toLowerCase();
  if (w && MONEY_WORDS.has(w)) return 'money';
  if (w && UNIT_WORDS.has(w) && w !== 'naira') return 'quantity';
  return null;
}

/** The sense of a figure nothing marks: an unmarked decimal ("1.5") is read as money. */
function guessedKind(figure: string | undefined): 'money' | null {
  return figure?.includes('.') ? 'money' : null;
}

/** A figure as integer kobo, by integer arithmetic only: "50k" is 5,000,000; "1.5m" is
 * 150,000,000; "₦4.50" is 450. */
function figureKobo(figure: string): number | null {
  const m = /^(?:₦|ngn|n)?\s*(\d+)(?:\.(\d+))?\s*([km])?$/u.exec(
    figure.toLowerCase().replace(/,/gu, ''),
  );
  if (!m?.[1]) return null;
  const perUnit = m[3] === 'm' ? 100_000_000 : m[3] === 'k' ? 100_000 : 100;
  const frac = m[2] ?? '';
  const scale = 10 ** frac.length;
  const fracKobo = (Number(frac || '0') * perUnit) / scale;
  if (!Number.isInteger(fracKobo)) return null;
  const kobo = Number(m[1]) * perUnit + fracKobo;
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/**
 * Whether every figure a correction says was wrong is one the waiting draft holds, read in its own
 * sense (OD-67 Option B, fail closed; owner ruling OWN-103(3)). "4 not 3" beside a sale of 3 wigs
 * fits; beside a ₦5,000 expense it does not, and is asked about, changing nothing. A figure written
 * as money ("50k", "₦3,000", "4.50k", "60k each") is compared with the draft's money in kobo; one
 * with a unit after it ("3 pcs") with its quantities; any other takes the sense of the figure it is
 * replaced by, then of the field the message names ("price", "paid"), and otherwise the draft's
 * quantities when it has any ("4 wigs not 3" beside a sale), else its money ("6000 not 5000" beside
 * an expense). A correction that names no replaced figure ("make it
 * 5", "no, it was Bola not Ada") has nothing to check and fits.
 */
export function replacedFiguresFit(text: string, draft: DraftFigures): boolean {
  const lower = text.toLowerCase();
  const replaced = [...lower.matchAll(REPLACED_FIGURE)];
  /* A negated figure the reading above cannot place is unchecked, so it is asked about
   * (CodeRabbit on #437 at 4a5fd80). */
  if (replaced.length < [...lower.matchAll(NEGATED_FIGURE)].length) return false;
  let from = 0;
  for (const m of replaced) {
    const figure = m[1]?.trim();
    if (!figure) continue;
    /* Each figure's sense comes from its own clause: its own marker or unit, the figure it is
     * replaced by, the field it names, never another clause's (CodeRabbit on #437 at 4a5fd80). */
    const clause = lower.slice(from, m.index);
    from = m.index + m[0].length;
    const before = [...clause.matchAll(ANY_FIGURE)].at(-1);
    const field = MONEY_FIELD.test(clause)
      ? 'money'
      : QUANTITY_FIELD.test(clause)
        ? 'quantity'
        : null;
    const replacementFigure = before?.[1]?.trim();
    const replacedMarked = figureKind(figure, m[2]);
    const replacementMarked = replacementFigure ? figureKind(replacementFigure, before?.[2]) : null;
    /* An unmarked decimal is read as money only when nothing explicit says otherwise: the field
     * the message names wins over the guess, so "quantity should be 2 not 1.5" is a quantity
     * (CodeRabbit on #437 at 400ca58). A marked figure still conflicts with the field. */
    const replacedKind = replacedMarked ?? (field ? null : guessedKind(figure));
    const replacementKind = replacementMarked ?? (field ? null : guessedKind(replacementFigure));
    /* Both figures written with their own sense must agree: "4 pc not ₦3" puts a count in place
     * of an amount, and is asked about (CodeRabbit on #437 at 6b3fc05). */
    if (replacedKind && replacementKind && replacedKind !== replacementKind) return false;
    const own = replacedKind ?? replacementKind;
    if (own && field && own !== field) return false;
    let kind = own ?? field;
    if (!kind) {
      /* Two or more figures with nothing to say which is which: asked about. One alone is read
       * as the draft's quantity when it has any ("4 not 3" beside 3 wigs), else its money. */
      if (replaced.length > 1) return false;
      kind = draft.quantities.length > 0 ? 'quantity' : 'money';
    }
    if (kind === 'quantity') {
      const count = Number(figure.replace(/,/gu, ''));
      if (!draft.quantities.includes(count)) return false;
    } else {
      const kobo = figureKobo(figure);
      if (kobo === null || !draft.moneyKobo.includes(kobo)) return false;
    }
  }
  return true;
}

/**
 * Whether a correction's reading changes a financial figure the merchant did not name (OD-76 Option
 * A, owner ruling OWN-107). "No, 4 not 3" names a quantity; a reading of it that also changes what
 * was paid, a price, a quantity, a discount, a delivery fee or an amount changes something the
 * merchant never mentioned, so it is asked about and nothing is replaced.
 *
 * Each figure the correction's words hold answers for one change only, in its own sense (CodeRabbit
 * on #437 at c5392f0): a change counts as named by its new value, or by its old value when it falls
 * to nothing ("no discount, not 2k"). So "price 50k not 40k" names the price, never also a payment
 * of 50k. A plain figure equal to a quantity of the draft or the reading is that quantity, never
 * also a price ("No, 4 not 3" names no ₦4). A stated total the correction does not name must equal
 * the total its corrected lines compute, and one the reading drops must have been the computed one.
 */
export function unnamedFiguresChanged(
  text: string,
  stored: Record<string, unknown>,
  reading: Record<string, unknown>,
): boolean {
  const lines = (v: unknown) =>
    Array.isArray(v)
      ? (v as unknown[]).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
      : [];
  const before = lines(stored['items']);
  const after = lines(reading['items']);
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const seenQuantities = new Set<number>();
  for (const v of [
    ...before.map((l) => l['quantity']),
    ...after.map((l) => l['quantity']),
    stored['quantity'],
    reading['quantity'],
  ]) {
    const q = count(v);
    if (q !== null) seenQuantities.add(q);
  }
  /* The money figures the merchant wrote, each usable once, with the field its clause names (Codex
   * and CodeRabbit on #437 at 50f1cd9): a figure written as a count or equal to one of the draft's or
   * the reading's quantities is a count, never money. A figure right after "not" is the one its
   * predecessor replaces: the two are a pair and answer only together, for the change from the one
   * to the other, so "price 50k not 40k" names the price change and the 40k never names a payment. */
  const lower = text.toLowerCase();
  const money: NamedFigure[] = [];
  const namedCounts: number[] = [];
  let end = 0;
  let previous: NamedFigure | null = null;
  for (const m of lower.matchAll(ANY_FIGURE)) {
    const figure = m[1]?.trim();
    if (!figure) continue;
    /* The gap runs to the figure itself: the word after the last figure ("50k not") is in it. */
    const gap = lower.slice(end, m.index);
    end = m.index + (m[1]?.length ?? 0);
    const kind = figureKind(figure, m[2]);
    const plain = Number(figure.replace(/,/gu, ''));
    const isCount = kind !== 'money' && Number.isFinite(plain);
    if (isCount) namedCounts.push(plain);
    if (kind === 'quantity' || (kind === null && isCount && seenQuantities.has(plain))) {
      previous = null;
      continue;
    }
    const k = figureKobo(figure);
    if (k === null) {
      previous = null;
      continue;
    }
    const replaces = previous !== null && PAIRED_GAP.test(gap) && previous.pair === null;
    const own: NamedFigure = {
      kobo: k,
      field: m[2]?.toLowerCase() === 'each' ? 'price' : fieldOf(gap),
      replaced: replaces || NEGATED_GAP.test(gap),
      pair: null,
      used: false,
    };
    if (replaces && previous) {
      own.field ??= previous.field;
      previous.field ??= own.field;
      own.pair = previous;
      previous.pair = own;
    }
    money.push(own);
    previous = own;
  }
  const fits = (f: NamedFigure, field: FigureField) =>
    !f.used && (f.field === null || FIELD_FITS[f.field].includes(field));
  const use = (f: NamedFigure | undefined) => {
    if (!f) return false;
    f.used = true;
    if (f.pair) f.pair.used = true;
    return true;
  };
  /* The pair naming exactly this change, from its replaced figure to its replacement. */
  const exactPair = (field: FigureField, was: number | null, now: number | null) =>
    money.find(
      (f) =>
        !f.replaced &&
        f.pair !== null &&
        f.kobo === now &&
        f.pair.kobo === was &&
        fits(f, field) &&
        fits(f.pair, field),
    );
  /* Otherwise a change is named by a figure for its new value (never one a "not" replaces), or, when
   * it falls to nothing, by a lone figure for its old value ("no discount, not 2k"); never by a
   * pair's figure, which already names its own change. */
  const loose = (field: FigureField, was: number | null, now: number | null) =>
    now !== null && now !== 0
      ? (money.find((f) => !f.replaced && f.pair === null && f.kobo === now && fits(f, field)) ??
        money.find((f) => !f.replaced && f.pair !== null && f.kobo === now && fits(f, field)))
      : money.find((f) => f.pair === null && f.kobo === was && fits(f, field));
  const take = (pool: number[], value: number) => {
    const i = pool.indexOf(value);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  /* Whether a change of a count from `was` to `now` is one the merchant named: by its new value, or
   * by its old one when it falls to nothing. Unchanged is always fine. */
  const namedCount = (was: number | null, now: number | null) => {
    if (was === now) return true;
    if (now !== null && now !== 0) return take(namedCounts, now);
    if (was !== null && was !== 0) return take(namedCounts, was);
    return true;
  };
  const kobo = (v: unknown, nullIsZero: boolean): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? nairaToKobo(v) : nullIsZero ? 0 : null;
  /* A purchase with no payment stated is paid in full (`gatePurchase`), so "nothing stated" and ₦0
   * are different payments there (CodeRabbit on #437 at c5392f0). */
  const purchase = stored['intent'] === 'RecordPurchase' || reading['intent'] === 'RecordPurchase';
  const paid = (command: Record<string, unknown>) =>
    purchase && command['reportedPayment'] == null
      ? kobo(command['amount'], false)
      : kobo(command['reportedPayment'], true);
  const changes: Array<[FigureField, number | null, number | null]> = [];
  const counts: Array<[number | null, number | null]> = [];
  if (purchase) {
    /* Paid in full stays paid in full when only the amount moves: the amount names that change. */
    const wasFull =
      stored['reportedPayment'] == null || paid(stored) === kobo(stored['amount'], false);
    const nowFull =
      reading['reportedPayment'] == null || paid(reading) === kobo(reading['amount'], false);
    if (!(wasFull && nowFull)) changes.push(['payment', paid(stored), paid(reading)]);
  } else {
    changes.push(['payment', paid(stored), paid(reading)]);
  }
  changes.push(['discount', kobo(stored['discount'], true), kobo(reading['discount'], true)]);
  changes.push(['fee', kobo(stored['deliveryFee'], true), kobo(reading['deliveryFee'], true)]);
  if ('amount' in stored) {
    /* A payment's or an expense's amount is what was paid: "paid 150k not 180k" names it. */
    const intent = stored['intent'] ?? reading['intent'];
    const paidAmount = intent === 'RecordPayment' || ('description' in stored && !purchase);
    changes.push([
      paidAmount ? 'paidAmount' : 'amount',
      kobo(stored['amount'], false),
      kobo(reading['amount'], false),
    ]);
  }
  if ('quantity' in stored) {
    counts.push([count(stored['quantity']), count(reading['quantity'])]);
  }
  /* A price and a quantity are checked on every line the draft had: matched one to one, by its
   * exact name, else its name without case or spaces, else its position when the reading has as many
   * lines. A priced line the reading drops or renames past matching cannot be checked, so it is asked
   * about, never exempted (Codex on #437 at 0bf9298 and c5392f0); a line the reading adds must have
   * its price named (CodeRabbit on #437 at c5392f0). */
  const key = (line: Record<string, unknown>) =>
    typeof line['name'] === 'string' ? line['name'].trim().toLowerCase() : '';
  const used = new Set<number>();
  const pick = (match: (l: Record<string, unknown>, j: number) => boolean) => {
    const j = after.findIndex((l, k) => !used.has(k) && match(l, k));
    if (j < 0) return undefined;
    used.add(j);
    return after[j];
  };
  for (const [i, line] of before.entries()) {
    const same =
      pick((l) => typeof l['name'] === 'string' && l['name'] === line['name']) ??
      pick((l) => key(l) !== '' && key(l) === key(line)) ??
      (after.length === before.length ? pick((_l, j) => j === i) : undefined);
    const price = kobo(line['unitPrice'], false);
    if (!same) {
      changes.push(['price', price, null]);
      continue;
    }
    changes.push(['price', price, kobo(same['unitPrice'], false)]);
    counts.push([count(line['quantity']), count(same['quantity'])]);
  }
  for (const [j, line] of after.entries()) {
    if (!used.has(j)) changes.push(['price', null, kobo(line['unitPrice'], false)]);
  }
  for (const [was, now] of counts) {
    if (!namedCount(was, now)) return true;
  }
  /* Exact pairs first, so a pair answers for its own change before any looser reading. */
  const open = changes.filter(
    ([field, was, now]) => was !== now && !use(exactPair(field, was, now)),
  );
  for (const [field, was, now] of open) {
    if (!use(loose(field, was, now))) return true;
  }
  const namesTotal = (value: number) =>
    money.some((f) => !f.replaced && f.kobo === value && fits(f, 'total'));
  /* A stated total the correction does not name must follow from the corrected figures: within
   * `computeMoney`'s tolerance a different one would become the invoice total unasked (Codex on #437
   * at 0bf9298). One the reading drops must have been the total the draft's lines computed, or the
   * invoice total moves unasked (CodeRabbit on #437 at c5392f0). */
  const statedBefore = kobo(stored['statedTotal'], false);
  const statedAfter = kobo(reading['statedTotal'], false);
  if (statedBefore !== statedAfter && !(statedAfter !== null && namesTotal(statedAfter))) {
    if (statedAfter !== null) {
      const figures = after.length > 0 ? saleFigures(reading, after) : null;
      if (!figures || figures.computedTotalK !== statedAfter) return true;
    } else if (statedBefore !== null && !namesTotal(statedBefore)) {
      const figures = before.length > 0 ? saleFigures(stored, before) : null;
      if (!figures || figures.computedTotalK !== statedBefore) return true;
    }
  }
  return false;
}

/** The field a correction's clause names for its figure, if it names one. */
type NamedField = 'price' | 'payment' | 'discount' | 'fee' | 'amount' | 'total';
/** A change's field: a named one, or the amount of a payment or an expense, which is what was paid. */
type FigureField = NamedField | 'paidAmount';
interface NamedFigure {
  kobo: number;
  field: NamedField | null;
  /** Written after a "not", "instead of" or "rather than": the value being corrected away. */
  replaced: boolean;
  /** Its other half in "50k not 40k"; the two answer for one change, together. */
  pair: NamedFigure | null;
  used: boolean;
}
/** What a figure named for one field may answer for. */
const FIELD_FITS: Record<NamedField, readonly FigureField[]> = {
  price: ['price', 'amount', 'paidAmount'],
  payment: ['payment', 'paidAmount'],
  discount: ['discount'],
  fee: ['fee'],
  amount: ['amount', 'total', 'price', 'paidAmount'],
  total: ['total', 'amount', 'paidAmount'],
};
const FIELD_WORDS: ReadonlyArray<readonly [RegExp, NamedField]> = [
  [/\b(?:paid|pay|payment|deposit)\b/u, 'payment'],
  [/\bdiscount\b/u, 'discount'],
  [/\b(?:delivery|fee|shipping)\b/u, 'fee'],
  [/\b(?:price|each|cost|rate|per)\b/u, 'price'],
  [/\btotal\b/u, 'total'],
  [/\bamount\b/u, 'amount'],
];
/** The text between two figures that makes the second the one the first replaces. */
const PAIRED_GAP = /^\s*,?\s*(?:not|instead\s+of|rather\s+than)\s*$/u;
const NEGATED_GAP = /\b(?:not|instead\s+of|rather\s+than)\s*$/u;

/** The field a figure's own clause names: the last field word before it, since the last figure. */
function fieldOf(gap: string): NamedField | null {
  let found: { at: number; field: NamedField } | null = null;
  for (const [pattern, field] of FIELD_WORDS) {
    for (const m of gap.matchAll(new RegExp(pattern.source, 'gu'))) {
      if (!found || m.index > found.at) found = { at: m.index, field };
    }
  }
  return found?.field ?? null;
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
  | {
      gate: 'CG2';
      preview: string;
      /** What was received. */
      amountK: number;
      balanceAfterK: number;
      /** What the invoice takes: `amountK`, or its balance when paid over. */
      allocatedK: number;
      /** The excess the merchant is confirming as customer credit; 0 if none. */
      creditK: number;
    };

/**
 * A merchant reporting money received against an invoice they already issued.
 *
 * The balance is passed in from SQL rather than read here, so the resolution
 * of "half" and "the rest" is arithmetic over a real figure and stays a pure
 * function. The contract is explicit that this is core's job and not the
 * model's: a model that guesses what "the rest" means is a model deciding how
 * much a customer owes.
 *
 * No amount at all, absolute or relative, is a CG1 question: the books must
 * never absorb a number nobody stated.
 *
 * More than the invoice still owes is a deliberate overpayment (OWN-16): the
 * preview shows what was received, what the invoice takes and the excess, and
 * only the merchant's "yes" to exactly those figures books it. The excess is
 * customer credit when the invoice has a customer, and otherwise an amount
 * not linked to anyone yet; `customerLinked` comes from SQL, never the model.
 * The figures shown here are what the confirmation is checked against: a
 * balance that has moved by then is never turned into credit.
 */
export function gatePayment(
  payment: PaymentLike,
  invoiceNumber: string,
  balanceDueK: number,
  options: { customerLinked?: boolean } = {},
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

  const received = `Received by ${payment.paymentMethod === 'cash' ? 'cash' : 'transfer'}`;

  if (amountK > balanceDueK) {
    const creditK = amountK - balanceDueK;
    const lines: string[] = ['Please check this before I save it:', ''];
    lines.push(`Payment on ${invoiceNumber}`);
    lines.push(`*Amount received: ${formatKobo(amountK)}*`);
    lines.push(`Applied to ${invoiceNumber}: ${formatKobo(balanceDueK)}`);
    lines.push(
      options.customerLinked
        ? `Customer credit: ${formatKobo(creditK)}`
        : `Unapplied: ${formatKobo(creditK)}. It is not linked to a customer yet.`,
    );
    lines.push(received);
    lines.push('This settles the invoice.');
    lines.push('', 'Reply *yes* to save it, or tell me what to change.');
    return {
      gate: 'CG2',
      preview: lines.join('\n'),
      amountK,
      balanceAfterK: 0,
      allocatedK: balanceDueK,
      creditK,
    };
  }

  const balanceAfterK = balanceDueK - amountK;
  const lines: string[] = ['Please check this before I save it:', ''];
  lines.push(`Payment on ${invoiceNumber}`);
  lines.push(`*Amount: ${formatKobo(amountK)}*`);
  lines.push(received);
  lines.push(
    balanceAfterK === 0
      ? 'This settles the invoice.'
      : `Still owing after this: ${formatKobo(balanceAfterK)}`,
  );
  lines.push('', 'Reply *yes* to save it, or tell me what to change.');
  return {
    gate: 'CG2',
    preview: lines.join('\n'),
    amountK,
    balanceAfterK,
    allocatedK: amountK,
    creditK: 0,
  };
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
  return stockArrival(purchase.productMention, purchase.quantity);
}

function stockArrival(
  productMention: string | null | undefined,
  count: number | null | undefined,
): { productMention: string; quantity: number } | null {
  const name = productMention?.trim();
  const quantity = Math.trunc(count ?? 0);
  if (!name || quantity <= 0) return null;
  return { productMention: name, quantity };
}
