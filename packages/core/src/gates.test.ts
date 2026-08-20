/**
 * The conversation gates (MASTER-PLAN §5.3.4, CG1–CG5).
 *
 * Every assertion here is a claim about a merchant's money, which is why the
 * gates are pure: this file needs no database, no network and no model to
 * prove that a mismatch is questioned rather than guessed at, and that nothing
 * reaches a document unread.
 */
import { describe, expect, it } from 'vitest';
import {
  gateExpense,
  gatePurchase,
  gateSale,
  looksLikeCorrection,
  saleToDraft,
  type SaleLike,
  gatePayment,
} from './gates.js';
import { computeMoney } from './money.js';

const WIGS: SaleLike = {
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 100_000,
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
};

describe('CG1 — an arithmetic mismatch is questioned, never guessed at', () => {
  it('asks when the stated total is below the items', () => {
    const gate = gateSale({ ...WIGS, statedTotal: 120_000, reportedPayment: null });
    expect(gate.gate).toBe('CG1');
    if (gate.gate !== 'CG1') throw new Error('unreachable');

    /**
     * Both silent options are wrong. Trusting the stated total buries a
     * discrepancy in a document the merchant signs; trusting the arithmetic
     * overrides a merchant who haggled and knows something we do not.
     */
    expect(gate.question).toContain('₦150,000'); // what the items come to
    expect(gate.question).toContain('₦120,000'); // what they said
    expect(gate.question).toContain('₦30,000'); // the gap, named
    expect(gate.question).toMatch(/discount/i);
  });

  it('puts the real figures in the question, not "the totals do not match"', () => {
    const gate = gateSale({ ...WIGS, statedTotal: 120_000 });
    if (gate.gate !== 'CG1') throw new Error('unreachable');
    // A vague question sends a merchant back to re-read their own message.
    expect(gate.question).not.toMatch(/^the totals do not match\.?$/i);
    expect(gate.question).toContain('3 × wig');
  });

  it('asks a DIFFERENT question when the stated total is above the items', () => {
    const gate = gateSale({ ...WIGS, statedTotal: 200_000, reportedPayment: null });
    if (gate.gate !== 'CG1') throw new Error('unreachable');
    // Not a discount — more likely a price we recorded wrong.
    expect(gate.question).not.toMatch(/discount/i);
    expect(gate.question).toMatch(/price/i);
    expect(gate.question).toContain('₦50,000');
  });

  it('does not fire on a stated total that agrees', () => {
    expect(gateSale(WIGS).gate).toBe('CG2');
  });

  it('tolerates rounding rather than interrogating a ₦20 difference', () => {
    // A gate that questions every kobo is a gate merchants learn to ignore.
    const gate = gateSale({ ...WIGS, statedTotal: 149_980, reportedPayment: null });
    expect(gate.gate).toBe('CG2');
  });
});

describe('CG2 — nothing is issued unread', () => {
  it('shows every figure that will appear on the document', () => {
    const gate = gateSale(WIGS);
    if (gate.gate !== 'CG2') throw new Error('unreachable');

    // A preview that omits a line teaches the merchant that skimming is safe.
    expect(gate.preview).toContain('CUSTOMER_7K2');
    expect(gate.preview).toContain('3 × wig @ ₦50,000 = ₦150,000');
    expect(gate.preview).toContain('Total: ₦150,000');
    expect(gate.preview).toContain('Paid: ₦100,000');
    expect(gate.preview).toContain('Balance: ₦50,000');
  });

  it('asks for a yes and offers the alternative', () => {
    const gate = gateSale(WIGS);
    if (gate.gate !== 'CG2') throw new Error('unreachable');
    expect(gate.preview).toMatch(/reply \*yes\*/i);
    expect(gate.preview).toMatch(/tell me what to change/i);
  });

  it('says "nothing yet" rather than ₦0 when nobody has paid', () => {
    const gate = gateSale({ ...WIGS, reportedPayment: null });
    if (gate.gate !== 'CG2') throw new Error('unreachable');
    expect(gate.preview).toContain('Paid: nothing yet');
    expect(gate.preview).not.toContain('Balance:');
  });

  it('surfaces an overpayment instead of rounding it away', () => {
    const gate = gateSale({ ...WIGS, reportedPayment: 200_000 });
    if (gate.gate !== 'CG2') throw new Error('unreachable');

    // A real event with a real meaning — change owed, or a credit — and the
    // merchant is the one who decides which.
    expect(gate.preview).toMatch(/paid over by ₦50,000/i);
    expect(gate.money.overpaymentK).toBe(5_000_000);
    expect(gate.money.balanceDueK).toBe(0);
  });

  it('shows a discount and a delivery fee as their own lines', () => {
    const gate = gateSale({
      items: [{ name: 'bag', quantity: 2, unitPrice: 20_000 }],
      discount: 5_000,
      deliveryFee: 2_000,
      reportedPayment: null,
      customer: { kind: 'none' },
    });
    if (gate.gate !== 'CG2') throw new Error('unreachable');
    expect(gate.preview).toContain('Discount: −₦5,000');
    expect(gate.preview).toContain('Delivery: ₦2,000');
    expect(gate.preview).toContain('Total: ₦37,000');
  });

  it('omits the customer line when there is no customer', () => {
    const gate = gateSale({ ...WIGS, customer: { kind: 'none' } });
    if (gate.gate !== 'CG2') throw new Error('unreachable');
    expect(gate.preview).not.toContain('CUSTOMER_');
  });

  it('names an unresolved customer by what the merchant called them', () => {
    const gate = gateSale({
      ...WIGS,
      customer: { kind: 'mention', mention: 'the lady from Surulere' },
    });
    if (gate.gate !== 'CG2') throw new Error('unreachable');
    expect(gate.preview).toContain('the lady from Surulere');
  });
});

describe('CG1 runs before CG2', () => {
  it('never previews numbers it already knows are wrong', () => {
    // A preview of a known-wrong total is a request to approve a mistake.
    const gate = gateSale({ ...WIGS, statedTotal: 120_000 });
    expect(gate.gate).toBe('CG1');
    expect(gate).not.toHaveProperty('preview');
  });
});

describe('the draft handed to the money engine', () => {
  it('carries the stated total through as testimony, not as truth', () => {
    const draft = saleToDraft({ ...WIGS, statedTotal: 120_000 });
    expect(draft.statedTotalNaira).toBe(120_000);
    // The engine keeps both, which is what makes the mismatch visible at all.
    const money = computeMoney(draft);
    expect(money.computedTotalK).toBe(15_000_000);
    expect(money.totalK).toBe(12_000_000);
  });

  it('omits absent optional figures rather than sending zeros', () => {
    // Under exactOptionalPropertyTypes a null discount and an absent one are
    // different things, and a zero discount would print a "Discount: ₦0" line.
    const draft = saleToDraft({ items: WIGS.items, discount: null, statedTotal: null });
    expect(draft).not.toHaveProperty('discountNaira');
    expect(draft).not.toHaveProperty('statedTotalNaira');
  });
});

describe('money out — an expense is previewed, never slipped into the books', () => {
  it('always gates behind CG2, with the figure and the method in the preview', () => {
    const gate = gateExpense({
      description: 'fuel for generator',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });
    if (gate.gate !== 'CG2') throw new Error('an expense has no arithmetic to question');
    expect(gate.preview).toContain('Expense: fuel for generator');
    expect(gate.preview).toContain('Category: utilities');
    expect(gate.preview).toContain('*Amount: ₦12,000*');
    expect(gate.preview).toContain('Paid by cash');
    expect(gate.preview).toMatch(/reply \*yes\*/i);
    expect(gate.amountK).toBe(1_200_000);
    expect(gate.paidK).toBe(1_200_000);
  });

  it('skips the category line when none was given, rather than printing "null"', () => {
    const gate = gateExpense({ description: 'okada delivery', amount: 1_500 });
    if (gate.gate !== 'CG2') throw new Error('unexpected gate');
    expect(gate.preview).not.toContain('Category');
  });
});

describe('money out — a stock purchase states what is owed', () => {
  it('shows paid and owing when the purchase is partly on credit', () => {
    const gate = gatePurchase({
      description: 'ankara fabric',
      amount: 50_000,
      supplierMention: 'Mama Nkechi',
      reportedPayment: 20_000,
    });
    if (gate.gate !== 'CG2') throw new Error('unexpected gate');
    expect(gate.preview).toContain('Stock: ankara fabric');
    expect(gate.preview).toContain('From: Mama Nkechi');
    expect(gate.preview).toContain('Paid: ₦20,000');
    expect(gate.preview).toContain('Owing to supplier: ₦30,000');
    expect(gate.paidK).toBe(2_000_000);
  });

  it('says "Paid in full" when nothing is owed, not "Owing: ₦0"', () => {
    const gate = gatePurchase({ description: 'ankara fabric', amount: 50_000 });
    if (gate.gate !== 'CG2') throw new Error('unexpected gate');
    expect(gate.preview).toContain('Paid in full');
    expect(gate.preview).not.toContain('Owing');
  });

  it('CG1: paying MORE than the stock cost is a question with the figures in it', () => {
    const gate = gatePurchase({
      description: 'ankara fabric',
      amount: 50_000,
      reportedPayment: 60_000,
    });
    if (gate.gate !== 'CG1') throw new Error('an overpaid purchase must be questioned');
    expect(gate.question).toContain('₦50,000');
    expect(gate.question).toContain('₦60,000');
    expect(gate.question).toContain('₦10,000');
  });

  it('previews read human: no em or en dashes anywhere', () => {
    for (const gate of [
      gateExpense({ description: 'fuel', amount: 5_000 }),
      gatePurchase({ description: 'fabric', amount: 10_000, reportedPayment: 4_000 }),
      gatePurchase({ description: 'fabric', amount: 10_000, reportedPayment: 14_000 }),
    ]) {
      const text = gate.gate === 'CG2' ? gate.preview : gate.question;
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe('CG5 — telling a correction from a new sale', () => {
  it.each([
    'no, 3 not 4',
    'No it was 150k',
    'actually make it 5',
    'sorry, change it to 2 bags',
    'wait — the price should be 60k',
  ])('%j corrects the draft', (text) => {
    expect(looksLikeCorrection(text, true)).toBe(true);
  });

  it('is never a correction when nothing is pending', () => {
    // Otherwise "no" to a question we did not ask would silently discard
    // something the merchant is still typing.
    expect(looksLikeCorrection('no, 3 not 4', false)).toBe(false);
  });

  it.each(['Ada bought 3 wigs for 150k', 'fuel 12k', 'sold 2 bags to Bola'])(
    '%j is a NEW sale, not a correction',
    (text) => {
      // Getting this backwards makes a merchant fixing a quantity lose the
      // sale they were fixing.
      expect(looksLikeCorrection(text, true)).toBe(false);
    },
  );

  it('treats an empty message as neither', () => {
    expect(looksLikeCorrection('   ', true)).toBe(false);
  });
});

describe('reported payments (gatePayment)', () => {
  const INV = 'INV-2026-000004';

  it('previews an absolute amount and says what is left', () => {
    const gate = gatePayment({ amount: 20_000, paymentMethod: 'cash' }, INV, 5_000_000);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.amountK).toBe(2_000_000);
    expect(gate.balanceAfterK).toBe(3_000_000);
    expect(gate.preview).toContain('₦20,000');
    expect(gate.preview).toContain('Still owing after this: ₦30,000');
  });

  it('resolves "the rest" against the real balance, settling the invoice', () => {
    const gate = gatePayment({ relativeAmount: 'remainder' }, INV, 5_000_000);
    if (gate.gate !== 'CG2') throw new Error('expected a preview');
    expect(gate.amountK).toBe(5_000_000);
    expect(gate.balanceAfterK).toBe(0);
    expect(gate.preview).toContain('settles the invoice');
  });

  it('resolves "half" as half of what is OWED, not half of the total', () => {
    const gate = gatePayment({ relativeAmount: 'half' }, INV, 5_000_000);
    if (gate.gate !== 'CG2') throw new Error('expected a preview');
    expect(gate.amountK).toBe(2_500_000);
  });

  it('asks rather than guessing when no amount was stated at all', () => {
    const gate = gatePayment({ amount: null, relativeAmount: null }, INV, 5_000_000);
    expect(gate.gate).toBe('CG1');
    if (gate.gate !== 'CG1') return;
    expect(gate.question).toContain('How much');
    expect(gate.question).toContain('₦50,000');
  });

  it('NEVER absorbs more than the invoice owes — an overpayment is a question', () => {
    const gate = gatePayment({ amount: 80_000 }, INV, 5_000_000);
    expect(gate.gate).toBe('CG1');
    if (gate.gate !== 'CG1') return;
    // Both figures are in the question: the merchant decides, we do not round.
    expect(gate.question).toContain('₦50,000');
    expect(gate.question).toContain('₦80,000');
  });
});
