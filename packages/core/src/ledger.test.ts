import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  UnbalancedPostingError,
  assertBalanced,
  monthlyDepreciationK,
  postAssetPurchase,
  postCreditNote,
  postDepreciation,
  postExpense,
  postJournal,
  postOpeningBalances,
  postStockCount,
  postProviderPayment,
  postPurchase,
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
    /* The merchant's own bank, not the settlement account (ADR 0025). A
     * customer transferring into a GTB account has nothing to do with
     * Paystack, and putting it there is what made the balance sheet match no
     * statement anybody holds. */
    expect(p.lines).toContainEqual({ account: 'BANK', debitK: 8_000_000, creditK: 0 });
    expect(p.lines.map((l) => l.account)).not.toContain('BANK_PAYSTACK');
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

  /* The other half of the split (ADR 0025). Settlements are the one thing
   * that belongs on the provider account, and if this ever reached BANK a
   * merchant would be reconciling their own statement against money that has
   * not arrived in it yet. */
  it('settles to the provider account and never to the merchant`s own bank', () => {
    const p = postProviderPayment({ memo: 'ref', allocatedK: 10_000_000 });
    expect(p.lines.map((l) => l.account)).toContain('BANK_PAYSTACK');
    expect(p.lines.map((l) => l.account)).not.toContain('BANK');
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
    expect(by['BANK']).toBe(50_000_000); // ₦400k + ₦80k + ₦20k
    /* Not a penny of an ordinary trading day reaches the settlement account.
     * Only `postProviderPayment` writes there, and none of these is one. */
    expect(by['BANK_PAYSTACK']).toBeUndefined();
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

/**
 * The instrument the void refuses to be.
 *
 * A void reverses a sale that should never have happened. A credit note
 * reduces one that did, and money may already have arrived, so reversing the
 * whole posting would describe a payment still sitting in the merchant's
 * account.
 */
describe('a credit note', () => {
  it('takes back revenue and clears the receivable, in balance', () => {
    const posting = postCreditNote({ memo: 'Credit CRN-2026-000001', amountK: 5_000_000 });

    expect(posting.lines).toEqual([
      { account: 'SALES_REVENUE', debitK: 5_000_000, creditK: 0 },
      { account: 'ACCOUNTS_RECEIVABLE', debitK: 0, creditK: 5_000_000 },
    ]);
    expect(() => assertBalanced(posting)).not.toThrow();
  });

  /* Leaving the VAT liability standing would have the merchant owing tax on
   * income they no longer have. */
  it('gives back the VAT with the revenue it was carved out of', () => {
    const posting = postCreditNote({
      memo: 'Credit CRN-2026-000002',
      amountK: 5_375_000,
      vatK: 375_000,
    });

    expect(posting.lines).toContainEqual({
      account: 'SALES_REVENUE',
      debitK: 5_000_000,
      creditK: 0,
    });
    expect(posting.lines).toContainEqual({ account: 'VAT_PAYABLE', debitK: 375_000, creditK: 0 });
    expect(posting.lines).toContainEqual({
      account: 'ACCOUNTS_RECEIVABLE',
      debitK: 0,
      creditK: 5_375_000,
    });
  });

  /**
   * The property that keeps this from needing a new account. A customer
   * credited beyond what they still owe IS in credit, and a negative
   * receivable is how a ledger says so. Inventing a refunds-payable account
   * would put customer credits in with what the shop owes its suppliers.
   */
  it('lets the receivable go negative, because a customer in credit is a real thing', () => {
    const sale = postSale({ memo: 'Sale', totalK: 15_000_000, paidK: 6_000_000 });
    const credit = postCreditNote({ memo: 'Credit', amountK: 15_000_000 });

    const { rows } = trialBalance([sale, credit]);
    const receivable = rows.find((r) => r.account === 'ACCOUNTS_RECEIVABLE');
    // Billed 15m, 9m of it still owed, then all 15m credited: 6m the other way.
    expect(receivable?.balanceK).toBe(-6_000_000);

    const revenue = rows.find((r) => r.account === 'SALES_REVENUE');
    expect(revenue?.balanceK).toBe(0);
  });

  it('still balances the books overall', () => {
    const sale = postSale({ memo: 'Sale', totalK: 15_000_000, paidK: 6_000_000, vatK: 1_000_000 });
    const credit = postCreditNote({ memo: 'Credit', amountK: 15_000_000, vatK: 1_000_000 });
    expect(trialBalance([sale, credit]).balanced).toBe(true);
  });

  it('refuses a credit of nothing, and VAT larger than the credit', () => {
    expect(() => postCreditNote({ memo: 'x', amountK: 0 })).toThrow(UnbalancedPostingError);
    expect(() => postCreditNote({ memo: 'x', amountK: -1 })).toThrow(UnbalancedPostingError);
    expect(() => postCreditNote({ memo: 'x', amountK: 1_000, vatK: 2_000 })).toThrow(
      UnbalancedPostingError,
    );
  });

  /* A credit note moves no cash. Handing the money back is a payment, and a
   * separate posting on the day it actually happens. */
  it('never touches cash or the bank', () => {
    const posting = postCreditNote({ memo: 'Credit', amountK: 5_000_000, vatK: 100_000 });
    for (const l of posting.lines) {
      expect(['CASH', 'BANK', 'BANK_PAYSTACK']).not.toContain(l.account);
    }
  });
});

describe('opening balances', () => {
  it('debits what the business holds and credits it all to the owner', () => {
    const posting = postOpeningBalances({
      memo: 'Opening balances',
      cashK: 20_000_000,
      bankK: 5_000_000,
      stockK: 15_000_000,
    });
    expect(posting.lines).toEqual([
      { account: 'CASH', debitK: 20_000_000, creditK: 0 },
      { account: 'BANK', debitK: 5_000_000, creditK: 0 },
      { account: 'INVENTORY', debitK: 15_000_000, creditK: 0 },
      /* The accounting equation, stated as a line: what the business holds
       * is what the owner has in it. */
      { account: 'OWNERS_EQUITY', debitK: 0, creditK: 40_000_000 },
    ]);
  });

  it('writes only the lines it was given something for', () => {
    const posting = postOpeningBalances({ memo: 'Opening balances', cashK: 20_000_000 });
    expect(posting.lines.map((l) => l.account)).toEqual(['CASH', 'OWNERS_EQUITY']);
  });

  /* Never touches receivables or payables. An opening figure for what
   * customers owe would have no invoice behind it, and the debtors page and
   * the ledger would answer the same question differently. */
  it('cannot set what customers owe or what is owed to suppliers', () => {
    const posting = postOpeningBalances({
      memo: 'Opening balances',
      cashK: 1,
      bankK: 1,
      stockK: 1,
    });
    const accounts = posting.lines.map((l) => l.account);
    expect(accounts).not.toContain('ACCOUNTS_RECEIVABLE');
    expect(accounts).not.toContain('ACCOUNTS_PAYABLE');
  });

  it('refuses an entry of nothing, and refuses a negative holding', () => {
    expect(() => postOpeningBalances({ memo: 'x' })).toThrow(RangeError);
    expect(() => postOpeningBalances({ memo: 'x', cashK: 0, bankK: 0 })).toThrow(RangeError);
    expect(() => postOpeningBalances({ memo: 'x', cashK: -1 })).toThrow(RangeError);
  });
});

describe('a stock count', () => {
  /**
   * The ordinary case. A purchase described in prose debits inventory and
   * nothing ever credits it, so the account sits above what the shelf holds
   * and the difference is cost that was incurred and never recorded.
   */
  it('puts a shortfall through cost of sales', () => {
    const posting = postStockCount({ memo: 'Stock count', differenceK: -15_000_00 });
    expect(posting.lines).toEqual([
      { account: 'COGS', debitK: 15_000_00, creditK: 0 },
      { account: 'INVENTORY', debitK: 0, creditK: 15_000_00 },
    ]);
  });

  /* And a surplus gives the same account back what it was overcharged. */
  it('puts a surplus back the other way', () => {
    const posting = postStockCount({ memo: 'Stock count', differenceK: 4_000_00 });
    expect(posting.lines).toEqual([
      { account: 'INVENTORY', debitK: 4_000_00, creditK: 0 },
      { account: 'COGS', debitK: 0, creditK: 4_000_00 },
    ]);
  });

  it('refuses to write an entry for a count that agrees', () => {
    expect(() => postStockCount({ memo: 'x', differenceK: 0 })).toThrow(RangeError);
  });
});

describe('a correction made by hand', () => {
  it('moves one amount between two accounts, balanced by its shape', () => {
    const posting = postJournal({
      memo: 'Took the day takings to the bank',
      amountK: 5_000_000,
      intoAccount: 'BANK_PAYSTACK',
      outOfAccount: 'CASH',
    });
    expect(posting.lines).toEqual([
      { account: 'BANK_PAYSTACK', debitK: 5_000_000, creditK: 0 },
      { account: 'CASH', debitK: 0, creditK: 5_000_000 },
    ]);
    expect(() => assertBalanced(posting)).not.toThrow();
  });

  /* The shape is the guarantee: there is no arrangement of these inputs that
   * produces an unbalanced posting, which is why the merchant is never asked
   * to make one balance. */
  it('balances for every pair of accounts and any amount', () => {
    const keys = Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[];
    for (const into of keys) {
      for (const out of keys) {
        if (into === out) continue;
        const posting = postJournal({
          memo: 'x',
          amountK: 1,
          intoAccount: into,
          outOfAccount: out,
        });
        expect(() => assertBalanced(posting)).not.toThrow();
      }
    }
  });

  it('refuses an entry into and out of the same account', () => {
    expect(() =>
      postJournal({ memo: 'x', amountK: 100, intoAccount: 'CASH', outOfAccount: 'CASH' }),
    ).toThrow(RangeError);
  });

  it('refuses nothing, and refuses less than nothing', () => {
    for (const amountK of [0, -100]) {
      expect(() =>
        postJournal({
          memo: 'x',
          amountK,
          intoAccount: 'CASH',
          outOfAccount: 'BANK_PAYSTACK',
        }),
      ).toThrow();
    }
  });
});

describe('equipment and what wears it down', () => {
  it('puts what was paid on the balance sheet, not in this month`s profit', () => {
    const posting = postAssetPurchase({ memo: 'Generator', costK: 45_000_000 });
    expect(posting.lines).toEqual([
      { account: 'EQUIPMENT', debitK: 45_000_000, creditK: 0 },
      { account: 'BANK', debitK: 0, creditK: 45_000_000 },
    ]);
    /* Nothing here reaches the profit and loss. That is the whole point. */
    expect(posting.lines.some((l) => ACCOUNTS[l.account].type === 'expense')).toBe(false);
  });

  it('carries the unpaid remainder to the supplier, like a purchase', () => {
    const posting = postAssetPurchase({
      memo: 'Freezer',
      costK: 30_000_000,
      paidK: 10_000_000,
      method: 'cash',
    });
    expect(posting.lines).toEqual([
      { account: 'EQUIPMENT', debitK: 30_000_000, creditK: 0 },
      { account: 'CASH', debitK: 0, creditK: 10_000_000 },
      { account: 'ACCOUNTS_PAYABLE', debitK: 0, creditK: 20_000_000 },
    ]);
  });

  it('refuses a cost of nothing and a payment larger than the cost', () => {
    expect(() => postAssetPurchase({ memo: 'x', costK: 0 })).toThrow(UnbalancedPostingError);
    expect(() => postAssetPurchase({ memo: 'x', costK: 100, paidK: 101 })).toThrow(
      UnbalancedPostingError,
    );
  });

  /**
   * The credit goes to the contra-asset, never to EQUIPMENT. What the business
   * paid and how much has been used up are two facts, and a lender asks about
   * the first.
   */
  it('charges wear without touching what was paid', () => {
    const posting = postDepreciation({ memo: 'Generator, August', amountK: 750_000 });
    expect(posting.lines).toEqual([
      { account: 'DEPRECIATION', debitK: 750_000, creditK: 0 },
      { account: 'ACCUMULATED_DEPRECIATION', debitK: 0, creditK: 750_000 },
    ]);
    expect(posting.lines.some((l) => l.account === 'EQUIPMENT')).toBe(false);
  });

  it('refuses a charge of nothing', () => {
    expect(() => postDepreciation({ memo: 'x', amountK: 0 })).toThrow(RangeError);
  });
});

describe('what a month of wear costs', () => {
  it('divides the cost evenly across the life', () => {
    expect(
      monthlyDepreciationK({ costK: 45_000_000, usefulLifeMonths: 60, monthsCharged: 0 }),
    ).toBe(750_000);
  });

  /**
   * The property that keeps a balance sheet honest for good. Every month's
   * charge summed must equal the cost EXACTLY, at every life and every price,
   * or an asset depreciates to four kobo and stays there forever.
   */
  it('always sums to exactly the cost, whatever the arithmetic leaves over', () => {
    for (const costK of [100_000, 45_000_000, 999_999, 1, 7, 123_456_789]) {
      for (const months of [1, 2, 3, 7, 12, 13, 60, 84]) {
        let total = 0;
        for (let m = 0; m < months; m++) {
          total += monthlyDepreciationK({ costK, usefulLifeMonths: months, monthsCharged: m });
        }
        expect(total).toBe(costK);
      }
    }
  });

  it('stops at the end of the life, and never runs backwards', () => {
    const args = { costK: 100_000, usefulLifeMonths: 10 };
    expect(monthlyDepreciationK({ ...args, monthsCharged: 10 })).toBe(0);
    expect(monthlyDepreciationK({ ...args, monthsCharged: 99 })).toBe(0);
    expect(monthlyDepreciationK({ ...args, monthsCharged: -1 })).toBe(0);
  });

  it('refuses a life that is not a whole number of months', () => {
    const args = { costK: 100_000, monthsCharged: 0 };
    expect(() => monthlyDepreciationK({ ...args, usefulLifeMonths: 0 })).toThrow(RangeError);
    expect(() => monthlyDepreciationK({ ...args, usefulLifeMonths: 1.5 })).toThrow(RangeError);
  });
});
