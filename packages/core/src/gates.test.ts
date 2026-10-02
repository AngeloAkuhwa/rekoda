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
  gateStockChange,
  purchaseArrival,
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

  it('promises customer credit only when the sale is resolved to a customer (G-49)', () => {
    const tokened = {
      ...WIGS,
      reportedPayment: 200_000,
      customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    } as const;
    const named = gateSale(tokened, { customerLinked: true });
    /* A token with no customer record behind it is not a customer to credit. */
    const unfiled = gateSale(tokened);
    const nobody = gateSale({ ...WIGS, reportedPayment: 200_000, customer: { kind: 'none' } });
    if (named.gate !== 'CG2' || nobody.gate !== 'CG2' || unfiled.gate !== 'CG2') {
      throw new Error('unreachable');
    }
    expect(unfiled.preview).not.toContain('note it as a credit');
    expect(named.preview).toContain('Paid over by ₦50,000. I will note it as a credit.');
    expect(nobody.preview).toContain(
      'Paid over by ₦50,000. I will record it as unapplied; it is not linked to a customer yet.',
    );
    expect(nobody.preview).not.toContain('note it as a credit');
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
      paymentMethod: 'cash',
    });
    if (gate.gate !== 'CG2') throw new Error('unexpected gate');
    expect(gate.preview).toContain('Stock: ankara fabric');
    expect(gate.preview).toContain('From: Mama Nkechi');
    expect(gate.preview).toContain('Paid: ₦20,000 by cash');
    expect(gate.preview).toContain('Owing to supplier: ₦30,000');
    expect(gate.paidK).toBe(2_000_000);
  });

  it('says "Paid in full" when nothing is owed, not "Owing: ₦0"', () => {
    const gate = gatePurchase({
      description: 'ankara fabric',
      amount: 50_000,
      paymentMethod: 'transfer',
    });
    if (gate.gate !== 'CG2') throw new Error('unexpected gate');
    expect(gate.preview).toContain('Paid in full by transfer');
    expect(gate.preview).not.toContain('Owing');
  });

  it('names the account the payment left, and none when nothing was paid (G-61)', () => {
    const cases = [
      {
        reportedPayment: 180_000,
        paymentMethod: 'cash',
        line: 'Paid in full by cash',
        method: 'cash',
      },
      {
        reportedPayment: 180_000,
        paymentMethod: 'transfer',
        line: 'Paid in full by transfer',
        method: 'transfer',
      },
      {
        reportedPayment: 100_000,
        paymentMethod: 'transfer',
        line: 'Paid: ₦100,000 by transfer',
        method: 'transfer',
      },
      { reportedPayment: 0, paymentMethod: null, line: 'Paid: nothing yet', method: null },
      /* Nothing paid: a method the model reported anyway is not shown or used. */
      { reportedPayment: 0, paymentMethod: 'cash', line: 'Paid: nothing yet', method: null },
    ] as const;
    for (const c of cases) {
      const gate = gatePurchase({
        description: '10 cartons',
        amount: 180_000,
        supplierMention: 'Emeka',
        reportedPayment: c.reportedPayment,
        paymentMethod: c.paymentMethod,
      });
      if (gate.gate !== 'CG2') throw new Error(`unexpected gate for ${c.line}`);
      expect(gate.preview).toContain(c.line);
      expect(gate.method).toBe(c.method);
    }
    const credit = gatePurchase({
      description: '10 cartons',
      amount: 180_000,
      reportedPayment: 0,
      paymentMethod: null,
    });
    if (credit.gate !== 'CG2') throw new Error('unexpected gate');
    expect(credit.preview).not.toMatch(/by cash|by transfer/);
  });

  it('asks how money was paid rather than guessing an account (G-61)', () => {
    for (const paymentMethod of [null, undefined, 'unknown']) {
      const part = gatePurchase({
        description: '20 bags',
        amount: 400_000,
        reportedPayment: 150_000,
        ...(paymentMethod === undefined ? {} : { paymentMethod }),
      });
      if (part.gate !== 'CG1') throw new Error(`a paid purchase with ${paymentMethod} must ask`);
      expect(part.question).toContain(
        'You paid ₦150,000 for this stock. Was that cash or transfer?',
      );
    }
    /* "Bought 20 bags for 400k" says nothing about payment, which reads as
     * paid in full: still an account nobody named, so still a question. */
    const implied = gatePurchase({ description: '20 bags', amount: 400_000 });
    if (implied.gate !== 'CG1') throw new Error('an implied full payment with no method must ask');
    expect(implied.question).toContain('did you pay it all by cash or by transfer?');
    expect(implied.question).not.toMatch(/[–—]/);
  });

  it('never previews a null method, and asks about a ₦0 purchase instead of posting it', () => {
    /* Every purchase shape the contract allows, including amount 0. */
    for (const amount of [0, 180_000]) {
      for (const reportedPayment of [null, 0, amount]) {
        for (const paymentMethod of [null, undefined, 'unknown', 'pos', 'cash', 'transfer']) {
          const gate = gatePurchase({
            description: 'stock',
            amount,
            reportedPayment,
            ...(paymentMethod === undefined ? {} : { paymentMethod }),
          });
          const text = gate.gate === 'CG1' ? gate.question : gate.preview;
          expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
          if (gate.gate === 'CG2' && gate.paidK === 0) {
            expect(gate.preview).not.toMatch(/by cash|by transfer/);
          }
        }
      }
    }
    const zero = gatePurchase({ description: 'stock', amount: 0, reportedPayment: 0 });
    if (zero.gate !== 'CG1') throw new Error('a ₦0 purchase must be asked about');
    expect(zero.question).toContain('I read the stock as costing ₦0');
    expect(zero.reason).toBe('zero_amount');
  });

  it('marks the funding-source question as such, and only that one', () => {
    const pos = gatePurchase({
      description: 's',
      amount: 100,
      reportedPayment: 100,
      paymentMethod: 'pos',
    });
    const unknown = gatePurchase({ description: 's', amount: 100, reportedPayment: 50 });
    const over = gatePurchase({
      description: 's',
      amount: 100,
      reportedPayment: 200,
      paymentMethod: 'cash',
    });
    expect(pos.gate === 'CG1' && pos.reason).toBe('funding_source');
    expect(unknown.gate === 'CG1' && unknown.reason).toBe('funding_source');
    expect(over.gate === 'CG1' && over.reason).toBeUndefined();
  });

  it('asks a POS or card payer for the ACCOUNT, not "cash or transfer" again (owner ruling)', () => {
    for (const reportedPayment of [150_000, null]) {
      const gate = gatePurchase({
        description: '20 bags',
        amount: 400_000,
        reportedPayment,
        paymentMethod: 'pos',
      });
      if (gate.gate !== 'CG1') throw new Error('a POS purchase with no account must ask');
      expect(gate.question).toContain(
        'I know you paid by POS. I just need the source of the money for your books: ' +
          'did it come from your bank account or from physical cash?',
      );
      expect(gate.question).toContain('paid by POS from my bank account');
      expect(gate.question).not.toContain('Was that cash or transfer?');
      expect(gate.question).not.toMatch(/[–—]/);
    }
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

  it('previews a deliberate overpayment with what was received, applied and credited (OWN-16)', () => {
    const gate = gatePayment({ amount: 80_000, paymentMethod: 'transfer' }, INV, 5_000_000, {
      customerLinked: true,
    });
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate).toMatchObject({
      amountK: 8_000_000,
      allocatedK: 5_000_000,
      creditK: 3_000_000,
      balanceAfterK: 0,
    });
    /* Every figure the confirmation will be held to is in front of them. */
    expect(gate.preview).toContain('Amount received: ₦80,000');
    expect(gate.preview).toContain(`Applied to ${INV}: ₦50,000`);
    expect(gate.preview).toContain('Customer credit: ₦30,000');
    expect(gate.preview).toContain('Received by transfer');
    expect(gate.preview).toContain('Reply *yes*');
  });

  it('never calls an excess customer credit when the invoice has no customer', () => {
    const gate = gatePayment({ amount: 80_000 }, INV, 5_000_000);
    if (gate.gate !== 'CG2') throw new Error('expected a preview');
    expect(gate.creditK).toBe(3_000_000);
    expect(gate.preview).toContain('Unapplied: ₦30,000. It is not linked to a customer yet.');
    expect(gate.preview).not.toContain('Customer credit');
  });

  it('an exact or partial payment carries no credit', () => {
    const exact = gatePayment({ relativeAmount: 'remainder' }, INV, 5_000_000);
    const part = gatePayment({ amount: 20_000 }, INV, 5_000_000);
    if (exact.gate !== 'CG2' || part.gate !== 'CG2') throw new Error('expected previews');
    expect(exact).toMatchObject({ allocatedK: 5_000_000, creditK: 0 });
    expect(part).toMatchObject({ allocatedK: 2_000_000, creditK: 0 });
    expect(part.preview).not.toMatch(/credit|Unapplied/i);
  });
});

describe('gateStockChange', () => {
  it('previews an arrival with the count before and after', () => {
    const gate = gateStockChange({ productMention: 'bags of rice', quantityDelta: 20 }, 5);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.preview).toContain('Adding 20 bags of rice');
    expect(gate.preview).toContain('Was: 5');
    expect(gate.preview).toContain('Now: 25');
    expect(gate.onHandAfter).toBe(25);
    expect(gate.quantityDelta).toBe(20);
  });

  it('previews a removal as a removal, not a negative addition', () => {
    const gate = gateStockChange({ productMention: 'wigs', quantityDelta: -3 }, 10);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.preview).toContain('Removing 3 wigs');
    expect(gate.preview).not.toContain('-3');
    expect(gate.onHandAfter).toBe(7);
  });

  it('asks rather than saving a change of nothing', () => {
    const gate = gateStockChange({ productMention: 'crates', quantityDelta: 0 }, 4);
    expect(gate.gate).toBe('CG1');
    if (gate.gate !== 'CG1') return;
    expect(gate.question).toContain('add or remove');
    expect(gate.question).toContain('4');
  });

  it('refuses to take a shop below zero', () => {
    const gate = gateStockChange({ productMention: 'bags of rice', quantityDelta: -9 }, 4);
    expect(gate.gate).toBe('CG1');
    if (gate.gate !== 'CG1') return;
    expect(gate.question).toContain('less than none');
    expect(gate.question).toContain('4');
  });

  it('allows a removal that lands exactly on zero', () => {
    const gate = gateStockChange({ productMention: 'wigs', quantityDelta: -4 }, 4);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.onHandAfter).toBe(0);
  });

  it('adds onto a product nothing is known about yet', () => {
    const gate = gateStockChange({ productMention: 'new thing', quantityDelta: 12 }, 0);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.onHandAfter).toBe(12);
  });

  it('takes whole units only, because half a bag is not a count', () => {
    const gate = gateStockChange({ productMention: 'bags', quantityDelta: 7.8 }, 0);
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.quantityDelta).toBe(7);
  });
});

describe('a purchase that is also a delivery', () => {
  const ANKARA = {
    description: '10 crates of ankara',
    amount: 50_000,
    supplierMention: 'Mama Nkechi',
    reportedPayment: 50_000,
    paymentMethod: 'cash',
  };

  it('names the stock arriving in the preview', () => {
    const gate = gatePurchase({ ...ANKARA, productMention: 'crates of ankara', quantity: 10 });
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    /* A purchase that moves stock and does not say so in the preview is a
     * stock change nobody confirmed. */
    expect(gate.preview).toContain('Adding to stock: 10 crates of ankara');
  });

  it('says nothing about stock when the merchant counted none', () => {
    const gate = gatePurchase({ ...ANKARA, productMention: null, quantity: null });
    expect(gate.gate).toBe('CG2');
    if (gate.gate !== 'CG2') return;
    expect(gate.preview).not.toContain('Adding to stock');
  });

  it('reads exactly as before for a purchase with no stock fields at all', () => {
    const withFields = gatePurchase({ ...ANKARA, productMention: null, quantity: null });
    const without = gatePurchase(ANKARA);
    expect(withFields).toEqual(without);
  });
});

describe('purchaseArrival', () => {
  const BASE = { description: 'ankara', amount: 50_000 };

  it('is the product and quantity when both are there', () => {
    expect(purchaseArrival({ ...BASE, productMention: 'crates', quantity: 10 })).toEqual({
      productMention: 'crates',
      quantity: 10,
    });
  });

  it('is nothing when only a quantity was named', () => {
    /* A number with no product is not a delivery anybody can count. */
    expect(purchaseArrival({ ...BASE, productMention: null, quantity: 10 })).toBeNull();
  });

  it('is nothing when only a product was named', () => {
    /* And a product with no number is not a count. */
    expect(purchaseArrival({ ...BASE, productMention: 'crates', quantity: null })).toBeNull();
  });

  it('is nothing for a purchase of a service', () => {
    expect(purchaseArrival(BASE)).toBeNull();
  });

  it('ignores whitespace that names nothing', () => {
    expect(purchaseArrival({ ...BASE, productMention: '   ', quantity: 4 })).toBeNull();
  });

  it('takes whole units, because half a crate is not a delivery', () => {
    expect(purchaseArrival({ ...BASE, productMention: 'crates', quantity: 9.7 })?.quantity).toBe(9);
  });

  it('refuses a zero or negative count', () => {
    expect(purchaseArrival({ ...BASE, productMention: 'crates', quantity: 0 })).toBeNull();
  });
});

describe('the funding question offers the short answer only while it can be taken (G-68)', () => {
  const pos = {
    description: '10 cartons',
    supplierMention: null,
    amount: 180_000,
    reportedPayment: 180_000,
    paymentMethod: 'pos',
  } as never;

  it('offers "Reply *bank* or *cash*" by default, and only "send it again" when told not to', () => {
    const offered = gatePurchase(pos);
    const plain = gatePurchase(pos, { shortAnswer: false });
    expect(offered.gate === 'CG1' && offered.question).toContain('Reply *bank* or *cash*');
    expect(plain.gate === 'CG1' && plain.question).not.toContain('Reply *bank*');
    expect(plain.gate === 'CG1' && plain.question).toContain(
      'Send it again with where the money came',
    );
  });
});

describe('a stated supplier reference on a purchase preview (G-81)', () => {
  const base = {
    description: '10 cartons of Milo',
    amount: 100_000,
    reportedPayment: 100_000,
    paymentMethod: 'cash',
  };

  it('is shown when it is a document number, so the merchant sees what is compared', () => {
    const gate = gatePurchase({ ...base, supplierReference: 'EMK-0041' });
    expect(gate.gate === 'CG2' && gate.preview).toContain('Reference: EMK-0041');
  });

  it('is not shown when it is not one', () => {
    const gate = gatePurchase({ ...base, supplierReference: 'Emeka' });
    expect(gate.gate === 'CG2' && gate.preview).not.toContain('Reference');
  });
});
