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
/* A decimal figure needs a currency sign or "k" ("60.5k", "₦4.50"): a bare "4.30" is a time. */
const FIG = String.raw`(?:(?:₦|NGN|N)\s*\d[\d,]*(?:\.\d+)?(?:\s*k)?|\d[\d,]*\.\d+\s*k|\d[\d,]*(?:\s*k)?)`;
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
  /* Where a word stands right after a figure ("4 Price"), it is the free item-word position. */
  const afterFigure = new Set<number>();
  for (const m of lower.matchAll(/\d[\d,.]*\s*(?=\p{L})/gu)) afterFigure.add(m.index + m[0].length);
  const explained = (word: string, at: number): boolean => {
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
  const name = purchase.productMention?.trim();
  const quantity = Math.trunc(purchase.quantity ?? 0);
  if (!name || quantity <= 0) return null;
  return { productMention: name, quantity };
}
