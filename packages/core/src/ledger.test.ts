import { describe, expect, it } from 'vitest';
import {
  UnbalancedPostingError,
  assertBalanced,
  postExpense,
  postPurchase,
  postProviderPayment,
  postReceivablePayment,
  postSale,
  reversal,
  trialBalance,
  type Posting,
} from './ledger.js';

describe('the balancing invariant', () => {
  it('rejects an unbalanced posting loudly', () => {
    const bad: Posting = {
      memo: 'bug',
      lines: [
        { account: 'CASH', debitK: 100, creditK: 0 },
        { account: 'SALES_REVENUE', debitK: 0, creditK: 99 },
      ],
    };
    expect(() => assertBalanced(bad)).toThrow(UnbalancedPostingError);
  });

  it('rejects empty, negative, and both-sided lines', () => {
    expect(() => assertBalanced({ memo: 'empty', lines: [] })).toThrow(UnbalancedPostingError);
    expect(() =>
      assertBalanced({
        memo: 'negative',
        lines: [
          { account: 'CASH', debitK: -100, creditK: 0 },
          { account: 'SALES_REVENUE', debitK: 0, creditK: -100 },
        ],
      }),
    ).toThrow(UnbalancedPostingError);
    expect(() =>
      assertBalanced({
        memo: 'both sides',
        lines: [{ account: 'CASH', debitK: 100, creditK: 100 }],
      }),
    ).toThrow(UnbalancedPostingError);
  });
});

describe('posting builders balance by construction', () => {
  it('a fully paid sale: cash and revenue', () => {
    const p = postSale({ memo: 'cash sale', totalK: 4_500_000, paidK: 4_500_000, method: 'cash' });
    expect(p.lines).toEqual([
      { account: 'CASH', debitK: 4_500_000, creditK: 0 },
      { account: 'SALES_REVENUE', debitK: 0, creditK: 4_500_000 },
    ]);
  });

  it('a part-paid sale: the unpaid part is a receivable — the debt book IS the ledger', () => {
    const p = postSale({ memo: 'Amaka 4 bags', totalK: 11_200_000, paidK: 8_000_000 });
    expect(p.lines).toContainEqual({ account: 'BANK_PAYSTACK', debitK: 8_000_000, creditK: 0 });
    expect(p.lines).toContainEqual({
      account: 'ACCOUNTS_RECEIVABLE',
      debitK: 3_200_000,
      creditK: 0,
    });
    expect(p.lines).toContainEqual({ account: 'SALES_REVENUE', debitK: 0, creditK: 11_200_000 });
  });

  it('VAT carved from an inclusive sale is a liability, never revenue', () => {
    const p = postSale({ memo: 'vat sale', totalK: 4_000_000, paidK: 4_000_000, vatK: 279_070 });
    expect(p.lines).toContainEqual({ account: 'SALES_REVENUE', debitK: 0, creditK: 3_720_930 });
    expect(p.lines).toContainEqual({ account: 'VAT_PAYABLE', debitK: 0, creditK: 279_070 });
  });

  it('paying more than the total inside a sale is a construction error', () => {
    expect(() => postSale({ memo: 'x', totalK: 100, paidK: 200 })).toThrow(UnbalancedPostingError);
  });

  it('expense and purchase support paid-now and on-credit splits', () => {
    const e = postExpense({ memo: 'diesel', amountK: 4_500_000, method: 'cash' });
    expect(e.lines).toContainEqual({ account: 'CASH', debitK: 0, creditK: 4_500_000 });
    const pu = postPurchase({ memo: 'stock from Chima', amountK: 60_000_000, paidK: 40_000_000 });
    expect(pu.lines).toContainEqual({
      account: 'ACCOUNTS_PAYABLE',
      debitK: 0,
      creditK: 20_000_000,
    });
  });
});

describe('a provider-confirmed payment (payments-v1 §15, §23)', () => {
  it('merchant-borne: fee comes out of settlement, receivable clears in full', () => {
    // ₦100,000 allocated, ₦1,500 Paystack fee → ₦98,500 to the bank,
    // ₦1,500 collection expense, ₦100,000 off the receivable.
    const p = postProviderPayment({
      memo: 'RKD-PAY-20260819-A83F92',
      allocatedK: 10_000_000,
      providerFeeK: 150_000,
      feePolicy: 'merchant_bearing',
    });
    expect(p.lines).toEqual([
      { account: 'BANK_PAYSTACK', debitK: 9_850_000, creditK: 0 },
      { account: 'EXPENSES', debitK: 150_000, creditK: 0 },
      { account: 'ACCOUNTS_RECEIVABLE', debitK: 0, creditK: 10_000_000 },
    ]);
  });

  it('customer-borne: the fee never enters the merchant`s books', () => {
    const p = postProviderPayment({
      memo: 'ref',
      allocatedK: 10_000_000,
      providerFeeK: 150_000,
      feePolicy: 'customer_bearing',
    });
    // The customer paid ₦100,300; the merchant's books see exactly ₦100,000.
    expect(p.lines).toEqual([
      { account: 'BANK_PAYSTACK', debitK: 10_000_000, creditK: 0 },
      { account: 'ACCOUNTS_RECEIVABLE', debitK: 0, creditK: 10_000_000 },
    ]);
  });

  it('never touches SALES_REVENUE — revenue was recognised at issue', () => {
    for (const feePolicy of ['customer_bearing', 'merchant_bearing', 'platform_bearing'] as const) {
      const p = postProviderPayment({
        memo: 'ref',
        allocatedK: 5_000_000,
        providerFeeK: 75_000,
        feePolicy,
      });
      expect(p.lines.some((l) => l.account === 'SALES_REVENUE')).toBe(false);
    }
  });

  it('throws on a fee larger than the payment it collected', () => {
    expect(() =>
      postProviderPayment({
        memo: 'ref',
        allocatedK: 100,
        providerFeeK: 200,
        feePolicy: 'merchant_bearing',
      }),
    ).toThrow(UnbalancedPostingError);
  });

  it('throws on a zero or negative allocation', () => {
    expect(() => postProviderPayment({ memo: 'ref', allocatedK: 0 })).toThrow(
      UnbalancedPostingError,
    );
  });
});

describe('reversal — the only correction mechanism', () => {
  it('a posting plus its reversal nets every account to zero', () => {
    const sale = postSale({ memo: 'wrong sale', totalK: 5_000_000, paidK: 2_000_000 });
    const undo = reversal(sale, 'reversal of wrong sale');
    const tb = trialBalance([sale, undo]);
    expect(tb.balanced).toBe(true);
    for (const row of tb.rows) expect(row.balanceK).toBe(0);
  });
});

describe('trial balance', () => {
  it('a full day of mixed activity always balances and tells the truth', () => {
    // Ada Fashion's day, straight from the spec's example (§14):
    const postings = [
      postSale({ memo: 'catalogue order', totalK: 40_000_000, paidK: 40_000_000 }), // ₦400k online
      postSale({ memo: 'shop gown', totalK: 4_500_000, paidK: 4_500_000, method: 'cash' }), // ₦45k cash
      postSale({ memo: 'credit sale', totalK: 13_000_000, paidK: 8_000_000 }), // ₦130k, ₦80k paid
      postExpense({ memo: 'delivery + fuel', amountK: 2_800_000, method: 'cash' }), // ₦28k
      postReceivablePayment({ memo: 'old debt cleared', amountK: 2_000_000 }), // ₦20k
    ];
    const tb = trialBalance(postings);
    expect(tb.balanced).toBe(true);
    const by = Object.fromEntries(tb.rows.map((r) => [r.account, r.balanceK]));
    expect(by['SALES_REVENUE']).toBe(57_500_000); // ₦575k sold
    expect(by['ACCOUNTS_RECEIVABLE']).toBe(3_000_000); // ₦50k new debt − ₦20k cleared
    expect(by['CASH']).toBe(1_700_000); // ₦45k in − ₦28k out
    expect(by['BANK_PAYSTACK']).toBe(50_000_000); // ₦400k + ₦80k + ₦20k
    expect(by['EXPENSES']).toBe(2_800_000);
  });

  it('property sweep: random well-formed activity can never unbalance the ledger', () => {
    let seed = 20260819;
    const rnd = () => {
      // deterministic LCG — reproducible failures matter more than "true" randomness
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run++) {
      const postings = [];
      for (let i = 0; i < 20; i++) {
        const totalK = Math.floor(rnd() * 10_000_000) + 100;
        const paidK = Math.floor(rnd() * (totalK + 1));
        const kind = rnd();
        if (kind < 0.5) postings.push(postSale({ memo: `s${i}`, totalK, paidK }));
        else if (kind < 0.75) postings.push(postExpense({ memo: `e${i}`, amountK: totalK, paidK }));
        else postings.push(postPurchase({ memo: `p${i}`, amountK: totalK, paidK }));
      }
      expect(trialBalance(postings).balanced).toBe(true);
    }
  });
});

describe('reversing a posting, as a void does', () => {
  it('swaps every side and still balances', () => {
    const sale = postSale({ memo: 'Sale INV-2026-000041', totalK: 15_000_000, paidK: 0 });
    const reversed = reversal(sale, 'Void INV-2026-000041');

    expect(reversed.memo).toBe('Void INV-2026-000041');
    expect(reversed.lines).toHaveLength(sale.lines.length);
    for (const [i, original] of sale.lines.entries()) {
      const mirror = reversed.lines[i]!;
      expect(mirror.account).toBe(original.account);
      expect(mirror.debitK).toBe(original.creditK);
      expect(mirror.creditK).toBe(original.debitK);
    }
  });

  it('cancels the original exactly, account by account', () => {
    const sale = postSale({
      memo: 'Sale INV-2026-000042',
      totalK: 10_750_000,
      paidK: 0,
      vatK: 750_000,
    });
    const reversed = reversal(sale, 'Void INV-2026-000042');

    /* The pair leaves nothing behind: for every account touched, what the
     * sale did and what the void did sum to zero on both sides. That is the
     * whole claim a void makes to an auditor. */
    const net = new Map<string, number>();
    for (const l of [...sale.lines, ...reversed.lines]) {
      net.set(l.account, (net.get(l.account) ?? 0) + l.debitK - l.creditK);
    }
    for (const [, amount] of net) expect(amount).toBe(0);
  });
});
