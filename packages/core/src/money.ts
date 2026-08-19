/**
 * The money engine. ALL financial arithmetic in Rekoda happens here, in
 * INTEGER KOBO (minor units), so floating-point drift can never unbalance a
 * document. Ported from the proven VoiceReceipt engine (118-test suite) and
 * hardened with types.
 *
 * The invariant every document must satisfy before it can exist:
 *
 *   subtotal − discount + deliveryFee + serviceCharge + vat = total
 *   total − amountPaid = balanceDue
 *
 * Nothing outside this package may do arithmetic on money. AI never sees
 * this layer; AI reports what a human said, this code decides what is true.
 */

/** Integer kobo. Plain number (2^53 covers ₦90 trillion), enforced integral. */
export type Kobo = number;

const KOBO_PER_NAIRA = 100;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Assert a value is a safe integer kobo amount. */
export function assertKobo(value: number, label = 'amount'): asserts value is Kobo {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer kobo amount, got ${value}`);
  }
}

export const toKobo = (naira: number): Kobo => {
  const k = Math.round((Number(naira) || 0) * KOBO_PER_NAIRA);
  assertKobo(k, 'converted amount');
  return k;
};

export const fromKobo = (kobo: Kobo): number => Math.round(kobo) / KOBO_PER_NAIRA;

/**
 * Parse Nigerian money shorthand from speech/text: "20k" → 20_000 naira,
 * "1.5m" → 1_500_000. Strict: "1.2.3" and "5." are rejected, not truncated.
 * Returns naira (not kobo) or null.
 */
export function parseAmountText(text: string): number | null {
  const m = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[,₦$£€\s]/g, '')
    .match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m || m[1] === undefined) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === 'm' ? n * 1_000_000 : m[2] === 'k' ? n * 1000 : n;
}

/**
 * Every field below is NAIRA, and says so in its name.
 *
 * This is the one boundary in Rekoda where naira are legal: a human speaks
 * naira, so the value arrives as naira and is converted here. The `Naira`
 * suffix is not decoration — the previous names (`price`, `amountPaid`) sat
 * beside outputs called `totalK` and `amountPaidK`, so the only thing telling a
 * reader which unit they held was knowing which side of the function they were
 * on. That is exactly the confusion that ends with a bill 100× too large.
 */
export interface DraftItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceNaira: number;
}

export interface MoneyDraft {
  readonly items: readonly DraftItem[];
  readonly discountNaira?: number;
  readonly deliveryFeeNaira?: number;
  readonly serviceChargeNaira?: number;
  readonly vatAmountNaira?: number;
  /** Total as STATED by the human. May disagree with the arithmetic. */
  readonly statedTotalNaira?: number;
  readonly amountPaidNaira?: number;
}

export interface MoneyBlock {
  readonly subtotalK: Kobo;
  readonly discountK: Kobo;
  readonly deliveryFeeK: Kobo;
  readonly serviceChargeK: Kobo;
  readonly vatK: Kobo;
  readonly totalK: Kobo;
  readonly computedTotalK: Kobo;
  /**
   * What the customer actually handed over — NOT capped at the total.
   *
   * This used to be `Math.min(paid, total)`. "Sold for ₦100k, she paid ₦150k"
   * became ₦100k paid and a zero balance, and the ₦50k simply ceased to exist:
   * a discrepancy silently fixed, which is the one thing this engine must
   * never do. `applyPayment` had always refused the same overpayment outright,
   * so the two disagreed about the same event.
   */
  readonly amountPaidK: Kobo;
  /** Still owed. Never negative — an overpayment is not a negative debt. */
  readonly balanceDueK: Kobo;
  /**
   * Paid beyond the total. Zero unless it happened.
   *
   * A real event with a real business meaning — change owed, a credit against
   * the next order, or a customer who paid the wrong invoice — so it is
   * surfaced for a human to settle rather than rounded away.
   *
   * The invariant: `totalK - amountPaidK === balanceDueK - overpaymentK`.
   */
  readonly overpaymentK: Kobo;
  /** Stated total disagrees with the equation by >1% AND >₦50 — that is a
   * clarification question for the human, never a silent fix. */
  readonly mismatch: boolean;
  readonly impliedDiscountK: Kobo;
}

export function computeMoney(draft: MoneyDraft): MoneyBlock {
  const subtotalK = draft.items.reduce(
    (sum, it) => sum + Math.round((Number(it.quantity) || 0) * toKobo(it.unitPriceNaira)),
    0,
  );
  assertKobo(subtotalK, 'subtotal');
  const discountK = Math.max(0, toKobo(draft.discountNaira ?? 0));
  const deliveryK = Math.max(0, toKobo(draft.deliveryFeeNaira ?? 0));
  const serviceK = Math.max(0, toKobo(draft.serviceChargeNaira ?? 0));
  const vatK = Math.max(0, toKobo(draft.vatAmountNaira ?? 0));

  const computedK = subtotalK - discountK + deliveryK + serviceK + vatK;
  const statedK = toKobo(draft.statedTotalNaira ?? 0);

  const totalK = statedK > 0 ? statedK : computedK;
  let mismatch = false;
  let impliedDiscountK = 0;

  if (statedK > 0 && subtotalK > 0) {
    const diffK = computedK - statedK;
    const tolerance = Math.max(50 * KOBO_PER_NAIRA, Math.round(computedK * 0.01));
    if (Math.abs(diffK) > tolerance) {
      mismatch = true;
      if (diffK > 0) impliedDiscountK = diffK; // items exceed stated → likely a discount
    }
  }

  // Recorded as stated, then split into what is still owed and what was paid
  // over. Nothing is discarded to make the arithmetic tidy.
  const paidK = Math.max(0, toKobo(draft.amountPaidNaira ?? 0));
  const balanceDueK = Math.max(0, totalK - paidK);
  const overpaymentK = Math.max(0, paidK - totalK);

  return {
    subtotalK,
    discountK,
    deliveryFeeK: deliveryK,
    serviceChargeK: serviceK,
    vatK,
    totalK,
    computedTotalK: computedK,
    amountPaidK: paidK,
    balanceDueK,
    overpaymentK,
    mismatch,
    impliedDiscountK,
  };
}

/**
 * True when the document balances. Either the equation holds exactly, or the
 * human's stated total was accepted within tolerance (mismatch=false) — in
 * which case the stated figure is authoritative and small rounding drift in
 * the reported components is tolerated rather than silently "fixed".
 */
export function isBalanced(b: MoneyBlock): boolean {
  const lhs = b.subtotalK - b.discountK + b.deliveryFeeK + b.serviceChargeK + b.vatK;
  if (lhs === b.totalK) return true;
  return !b.mismatch;
}

/**
 * Deterministic VAT — computed by CODE, never by AI. (The parser only ever
 * reports VAT a vendor explicitly spoke aloud.)
 *
 * inclusive=true  → the quoted price already contains VAT; we carve it out
 *                   WITHOUT changing what the customer pays:
 *                     vat = base × rate / (100 + rate)
 * inclusive=false → VAT is added on top: vat = base × rate / 100
 */
export function computeVat(
  baseK: Kobo,
  ratePercent: number,
  inclusive: boolean,
): { vatK: Kobo; totalK: Kobo; taxableK: Kobo } {
  assertKobo(baseK, 'VAT base');
  const rate = Number(ratePercent) || 0;
  if (rate <= 0) return { vatK: 0, totalK: baseK, taxableK: baseK };
  if (inclusive) {
    const vatK = Math.round((baseK * rate) / (100 + rate));
    return { vatK, totalK: baseK, taxableK: baseK - vatK };
  }
  const vatK = Math.round((baseK * rate) / 100);
  return { vatK, totalK: baseK + vatK, taxableK: baseK };
}

/**
 * Apply a payment to an existing document. Overpayment is refused, with the
 * exact excess, for the caller to resolve.
 *
 * This REFUSES where `computeMoney` RECORDS, and the difference is the stage,
 * not a disagreement. `computeMoney` builds a draft from what a human said —
 * "she paid 150k" on a 100k sale is a fact to write down and flag. This one
 * mutates a document that already exists, where quietly accepting an extra
 * ₦50k would leave the ledger unbalanced against nothing. Both obey the same
 * rule: the discrepancy reaches a human, and neither invents a fix.
 */
export function applyPayment(
  currentPaidK: Kobo,
  totalK: Kobo,
  paymentK: Kobo,
):
  | { ok: true; amountPaidK: Kobo; balanceDueK: Kobo; paymentStatus: 'paid' | 'partial' }
  | { ok: false; reason: 'overpayment'; excessK: Kobo } {
  assertKobo(currentPaidK, 'currentPaid');
  assertKobo(totalK, 'total');
  assertKobo(paymentK, 'payment');
  const newPaidK = currentPaidK + paymentK;
  if (newPaidK > totalK) return { ok: false, reason: 'overpayment', excessK: newPaidK - totalK };
  const balanceK = totalK - newPaidK;
  return {
    ok: true,
    amountPaidK: newPaidK,
    balanceDueK: balanceK,
    paymentStatus: balanceK === 0 ? 'paid' : 'partial',
  };
}

/** Format kobo for humans: ₦1,234,567.89 (presentation edge only). */
export function formatKobo(kobo: Kobo, currency = 'NGN'): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100).toLocaleString('en-NG');
  const minor = String(abs % 100).padStart(2, '0');
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${sign}${symbol}${whole}${minor === '00' ? '' : `.${minor}`}`;
}
