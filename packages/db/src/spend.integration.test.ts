/**
 * Money going out (spend.ts), against real PostgreSQL.
 *
 * The claims that matter: an expense and its posting commit together and the
 * ledger balances from a database READ-BACK; a purchase partly on credit
 * carries exactly the unpaid remainder to ACCOUNTS_PAYABLE; and another
 * tenant sees none of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { sql } from 'drizzle-orm';
import { identity, issueRepo, journalRepo, spendRepo, stockRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348120000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const entriesOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId));

describe('an expense', () => {
  it('writes the row and a balanced EXPENSES posting in one transaction', async () => {
    const businessId = await seedBusiness();

    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-x',
      }),
    );
    expect(recorded.owedK).toBe(0);

    const rows = await withBusiness(db, businessId, (tx) => spendRepo.expensesFor(tx, businessId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: 'fuel for generator',
      /* Not 'utilities'. The model's word is a hint; what lands in the column
       * is one of the ten the profit and loss groups by, decided by
       * `categoriseExpense` so no write path can invent an eleventh. */
      category: 'power',
      amountK: 1_200_000,
      method: 'cash',
    });

    const entries = await entriesOf(businessId);
    const debits = entries.reduce((sum, e) => sum + Number(e.debitK), 0);
    const credits = entries.reduce((sum, e) => sum + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'EXPENSES', debitK: 1_200_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', creditK: 1_200_000 }),
    );
  });
});

describe('a stock purchase', () => {
  it('on credit: INVENTORY in full, cash for what was paid, AP for the rest', async () => {
    const businessId = await seedBusiness();

    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara fabric',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'draft-y',
      }),
    );
    expect(recorded.owedK).toBe(3_000_000);

    const entries = await entriesOf(businessId);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', creditK: 2_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'ACCOUNTS_PAYABLE', creditK: 3_000_000 }),
    );
  });

  it('paid in full: no ACCOUNTS_PAYABLE line at all', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'thread',
        amountK: 500_000,
        paidK: 500_000,
        sourceType: 'chat',
        sourceId: 'draft-z',
      }),
    );
    const entries = await entriesOf(businessId);
    expect(entries.some((e) => e.account === 'ACCOUNTS_PAYABLE')).toBe(false);
  });
});

describe('the spend register', () => {
  it('totals expenses and stock apart, and never adds them', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: 'utilities',
        amountK: 800_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      });
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'shop rent',
        category: null,
        amountK: 2_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'd2',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'd3',
      });
    });

    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));

    expect(list.count).toBe(3);
    expect(list.expensesK).toBe(2_800_000);
    expect(list.purchasesK).toBe(5_000_000);
    /* The whole point of the split: one figure would read as 7,800,000 spent
     * when 5,000,000 of it is still on the shelf. */
    expect(list.expensesK + list.purchasesK).not.toBe(list.expensesK);
  });

  it('labels a stock purchase as one, and an uncategorised expense as an expense', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'transport',
        category: null,
        amountK: 150_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'lace',
        amountK: 900_000,
        paidK: 900_000,
        sourceType: 'chat',
        sourceId: 'd2',
      });
    });

    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    const byDescription = Object.fromEntries(list.rows.map((r) => [r.description, r.kind]));
    expect(byDescription).toEqual({ transport: 'expense', lace: 'purchase' });
  });

  it('reports what is still owed on a part-paid purchase, off the ledger', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.payableK).toBe(3_000_000);
  });

  it('owes nothing when every purchase was paid in full', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'thread',
        amountK: 500_000,
        paidK: 500_000,
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.payableK).toBe(0);
  });

  it('is newest first and bounded by the limit, with the all-time count intact', async () => {
    const businessId = await seedBusiness();
    for (const description of ['first', 'second', 'third']) {
      await withBusiness(db, businessId, (tx) =>
        spendRepo.recordExpense(tx, {
          businessId,
          description,
          category: null,
          amountK: 100_000,
          method: 'cash',
          sourceType: 'chat',
          sourceId: description,
        }),
      );
    }
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 2));
    expect(list.rows.map((r) => r.description)).toEqual(['third', 'second']);
    /* The count is the books, not the page. A merchant told "2 entries" when
     * they have three would think one had gone missing. */
    expect(list.count).toBe(3);
  });

  it('is empty and zeroed for a business that has spent nothing', async () => {
    const businessId = await seedBusiness();
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list).toMatchObject({
      rows: [],
      count: 0,
      expensesK: 0,
      purchasesK: 0,
      payableK: 0,
    });
  });
});

describe('withdrawing an entry', () => {
  async function recordOne(businessId: string, description = 'diesel') {
    return withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description,
        category: 'utilities',
        amountK: 800_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: `draft-${description}`,
      }),
    );
  }

  it('mirrors the posting instead of deleting anything', async () => {
    const businessId = await seedBusiness();
    const recorded = await recordOne(businessId);

    const outcome = await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'recorded twice', 'user:1'),
    );
    expect(outcome).toMatchObject({
      outcome: 'voided',
      description: 'diesel',
      kind: 'expense',
      reversedK: 800_000,
      stockUnchanged: false,
    });

    /* BOTH transactions remain. An expense and its reversal is a different
     * story from an expense that never happened, and the books must tell
     * those apart. */
    const entries = await entriesOf(businessId);
    expect(entries).toHaveLength(4);
    const net = new Map<string, number>();
    for (const e of entries) {
      net.set(e.account, (net.get(e.account) ?? 0) + Number(e.debitK) - Number(e.creditK));
    }
    expect([...net.values()].every((v) => v === 0)).toBe(true);
  });

  it('stops the withdrawn entry counting, and leaves it on the page', async () => {
    const businessId = await seedBusiness();
    const recorded = await recordOne(businessId);
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'recorded twice', 'user:1'),
    );

    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.expensesK).toBe(0);
    expect(list.count).toBe(1);
    expect(list.rows[0]).toMatchObject({ description: 'diesel', status: 'voided' });
  });

  it('reverses a part-paid purchase for what the LEDGER says, not what the row says', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'draft-p',
      }),
    );

    const outcome = await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'never delivered', 'user:1'),
    );
    expect(outcome).toMatchObject({ outcome: 'voided', kind: 'purchase' });

    /* The row stores 5,000,000 and nothing else. Only the ledger knows that
     * 3,000,000 of it went to ACCOUNTS_PAYABLE, and rebuilding the posting
     * from the row would have left that debt standing. */
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.payableK).toBe(0);
    expect(list.purchasesK).toBe(0);
  });

  it('says so when the entry also brought stock in', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, async (tx) => {
      const purchase = await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'lace',
        amountK: 900_000,
        paidK: 900_000,
        sourceType: 'chat',
        sourceId: 'draft-s',
      });
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'lace');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: 12,
        reason: 'purchase',
        sourceType: 'chat',
        sourceId: 'draft-s',
      });
      return purchase;
    });

    const outcome = await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'never delivered', 'user:1'),
    );
    expect(outcome).toMatchObject({ outcome: 'voided', stockUnchanged: true });

    /* Deliberate: what is on the shelf is a physical fact, and subtracting a
     * delivery nobody recounted would put a number in the books that no
     * merchant took. The outcome flag is how they are told. */
    const stock = await withBusiness(db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId, 10),
    );
    expect(stock.rows[0]).toMatchObject({ name: 'lace', onHand: 12 });
  });

  /**
   * The real test of the exclusion, because the sequential one is not.
   *
   * Two transactions both read `recorded` before either writes, so the status
   * check inside the function settles nothing. Only the UPDATE decides, and
   * the reversal has to come after it: one winner, one reversal, and never a
   * posting in an append-only ledger with nothing to explain it.
   */
  it('two concurrent withdrawals write exactly ONE reversal between them', async () => {
    const businessId = await seedBusiness();
    const recorded = await recordOne(businessId);

    const attempt = () =>
      withBusiness(db, businessId, (tx) =>
        spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'raced', 'user:1'),
      );
    const outcomes = await Promise.all([attempt(), attempt()]);

    expect(outcomes.filter((o) => o.outcome === 'voided')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'already_void')).toHaveLength(1);
    // Two lines for the expense, two for its single reversal. Never six.
    expect(await entriesOf(businessId)).toHaveLength(4);
  });

  it('refuses the second withdrawal, so one entry can never reverse twice', async () => {
    const businessId = await seedBusiness();
    const recorded = await recordOne(businessId);
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'recorded twice', 'user:1'),
    );

    const again = await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'again', 'user:1'),
    );
    expect(again).toEqual({ outcome: 'already_void' });
    expect(await entriesOf(businessId)).toHaveLength(4);
  });

  it('answers not_found for an id that is not this tenant`s', async () => {
    const ada = await seedBusiness('+2348120000001');
    const bola = await seedBusiness('+2348120000002');
    const recorded = await recordOne(ada);

    const outcome = await withBusiness(db, bola, (tx) =>
      spendRepo.voidExpense(tx, bola, recorded.expenseId, 'not mine', 'user:2'),
    );
    expect(outcome).toEqual({ outcome: 'not_found' });
    expect(await entriesOf(ada)).toHaveLength(2);
  });

  it('writes the reason and the actor into the audit trail', async () => {
    const businessId = await seedBusiness();
    const recorded = await recordOne(businessId);
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'supplier cancelled', 'user:7'),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actor: string; reason: string; entity: string; entity_id: string }>(
        sql`SELECT actor, reason, entity, entity_id FROM audit_events
            WHERE business_id = ${businessId}::uuid AND action = 'voided'`,
      ),
    );
    expect([...rows][0]).toMatchObject({
      actor: 'user:7',
      reason: 'supplier cancelled',
      entity: 'expense',
      entity_id: recorded.expenseId,
    });
  });
});

/**
 * Accounts payable, aged.
 *
 * It ages by how long the debt has STOOD, not by how late it is: a purchase
 * carries no terms because Rekoda stores nothing about suppliers, so there is
 * no deadline to be late against. The claim that matters most is the last one
 * here - the buckets and the ledger must agree, because two figures for the
 * same debt is how a merchant stops believing either.
 */
describe('ageing what is owed to suppliers', () => {
  async function purchaseAt(businessId: string, daysAgo: number, amountK: number, paidK: number) {
    const at = new Date(Date.now() - daysAgo * 86_400_000);
    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: `bales ${daysAgo}d`,
        amountK,
        paidK,
        sourceType: 'chat',
        sourceId: `p-${daysAgo}`,
      }),
    );
    /* Back-date the row, because the ageing reads the expense's own date. */
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE expenses SET created_at = ${at.toISOString()}::timestamptz
            WHERE id = ${recorded.expenseId}::uuid`,
      ),
    );
    return recorded;
  }

  it('sorts what is owed into buckets by how long it has stood', async () => {
    const businessId = await seedBusiness();
    await purchaseAt(businessId, 5, 5_000_000, 1_000_000); // owes 4m, fresh
    await purchaseAt(businessId, 45, 3_000_000, 0); // owes 3m
    await purchaseAt(businessId, 75, 2_000_000, 500_000); // owes 1.5m
    await purchaseAt(businessId, 200, 1_000_000, 0); // owes 1m, very old

    const ageing = await withBusiness(db, businessId, (tx) =>
      spendRepo.payableAgeingFor(tx, businessId),
    );
    expect(ageing).toEqual({
      d0_30K: 4_000_000,
      d31_60K: 3_000_000,
      d61_90K: 1_500_000,
      d90PlusK: 1_000_000,
      /* Every naira here belongs to a purchase with a date. */
      unlinkedK: 0,
      totalK: 9_500_000,
    });
  });

  /**
   * The assertion that keeps two numbers from drifting apart. The buckets are
   * derived from the same ledger entries the balance is, so if they ever
   * disagree one of them is lying and a merchant cannot tell which.
   */
  it('sums to exactly the accounts payable balance on the register', async () => {
    const businessId = await seedBusiness();
    await purchaseAt(businessId, 3, 5_000_000, 2_000_000);
    await purchaseAt(businessId, 100, 4_000_000, 1_000_000);

    const [ageing, list] = await Promise.all([
      withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
      withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50)),
    ]);
    expect(ageing.totalK).toBe(list.payableK);
    expect(ageing.d0_30K + ageing.d31_60K + ageing.d61_90K + ageing.d90PlusK).toBe(ageing.totalK);
  });

  it('drops a withdrawn purchase out of the ageing, as it drops out of the balance', async () => {
    const businessId = await seedBusiness();
    const kept = await purchaseAt(businessId, 10, 5_000_000, 0);
    const withdrawn = await purchaseAt(businessId, 10, 8_000_000, 0);

    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, withdrawn.expenseId, 'never delivered', 'user:1'),
    );

    const [ageing, list] = await Promise.all([
      withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
      withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50)),
    ]);
    expect(ageing.d0_30K).toBe(5_000_000);
    expect(ageing.totalK).toBe(list.payableK);
    expect(kept.owedK).toBe(5_000_000);
  });

  it('ignores a purchase that was paid for in full', async () => {
    const businessId = await seedBusiness();
    await purchaseAt(businessId, 10, 5_000_000, 5_000_000);

    expect(
      await withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
    ).toMatchObject({ totalK: 0, d0_30K: 0 });
  });

  /**
   * The contradiction this slice was built to end. Settling a supplier with a
   * manual journal used to part the two figures: the register reported the
   * debt gone and the ageing reported it standing, growing older, forever.
   *
   * A journal names no purchase, so Rekoda still does not claim to know which
   * debt it cleared. What it will not do is drop the money on the floor: it
   * comes back as `unlinkedK`, and the buckets plus that equal the balance.
   */
  it('reads a settlement made outside the purchase, as the balance does', async () => {
    const businessId = await seedBusiness();
    const purchase = await purchaseAt(businessId, 40, 5_000_000, 0);

    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'Paid the supplier',
        amountK: 5_000_000,
        intoAccount: 'ACCOUNTS_PAYABLE',
        outOfAccount: 'CASH',
        actor: 'user:1',
      }),
    );

    const [ageing, list] = await Promise.all([
      withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
      withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50)),
    ]);
    expect(list.payableK).toBe(0);
    expect(ageing.totalK).toBe(list.payableK);
    expect(purchase.owedK).toBe(5_000_000);
    /* The purchase still stands at its own age; the journal cancels it out
     * as an unlinked negative. Rekoda declines to guess which is which. */
    expect(ageing.d31_60K).toBe(5_000_000);
    expect(ageing.unlinkedK).toBe(-5_000_000);
  });

  describe('paying a supplier', () => {
    it('clears the debt, on the balance and in the bucket alike', async () => {
      const businessId = await seedBusiness();
      const purchase = await purchaseAt(businessId, 40, 5_000_000, 0);

      expect(
        await withBusiness(db, businessId, (tx) =>
          spendRepo.paySupplier(tx, {
            businessId,
            expenseId: purchase.expenseId,
            amountK: 5_000_000,
            method: 'cash',
            actor: 'user:1',
          }),
        ),
      ).toMatchObject({ outcome: 'paid', owedK: 0 });

      const [ageing, list] = await Promise.all([
        withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
        withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50)),
      ]);
      /* Both, and the same. The attribution is what lets the bucket move. */
      expect(list.payableK).toBe(0);
      expect(ageing).toMatchObject({ d31_60K: 0, unlinkedK: 0, totalK: 0 });
    });

    it('takes part of it, and still owes the rest at the same age', async () => {
      const businessId = await seedBusiness();
      const purchase = await purchaseAt(businessId, 40, 5_000_000, 0);

      expect(
        await withBusiness(db, businessId, (tx) =>
          spendRepo.paySupplier(tx, {
            businessId,
            expenseId: purchase.expenseId,
            amountK: 2_000_000,
            method: 'transfer',
            actor: 'user:1',
          }),
        ),
      ).toMatchObject({ outcome: 'paid', owedK: 3_000_000 });

      const ageing = await withBusiness(db, businessId, (tx) =>
        spendRepo.payableAgeingFor(tx, businessId),
      );
      /* Still 40 days old. Paying some of a debt does not make it younger. */
      expect(ageing).toMatchObject({ d31_60K: 3_000_000, d0_30K: 0, totalK: 3_000_000 });
    });

    /**
     * Overpaying is a prepayment, which is an asset, not a negative liability.
     * Absorbing it here would drive ACCOUNTS_PAYABLE below zero and read on a
     * balance sheet as a supplier owing the merchant through an account that
     * cannot mean that.
     */
    it('refuses more than is owed, and names the figure', async () => {
      const businessId = await seedBusiness();
      const purchase = await purchaseAt(businessId, 10, 5_000_000, 1_000_000);

      expect(
        await withBusiness(db, businessId, (tx) =>
          spendRepo.paySupplier(tx, {
            businessId,
            expenseId: purchase.expenseId,
            amountK: 4_000_001,
            method: 'cash',
            actor: 'user:1',
          }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'more_than_owed', owedK: 4_000_000 });

      /* And nothing moved. */
      expect(
        (await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50)))
          .payableK,
      ).toBe(4_000_000);
    });

    it('refuses a purchase that owes nothing, and one that was withdrawn', async () => {
      const businessId = await seedBusiness();
      const settled = await purchaseAt(businessId, 10, 5_000_000, 5_000_000);
      const withdrawn = await purchaseAt(businessId, 10, 3_000_000, 0);
      await withBusiness(db, businessId, (tx) =>
        spendRepo.voidExpense(tx, businessId, withdrawn.expenseId, 'never delivered', 'user:1'),
      );
      const pay = (expenseId: string) =>
        withBusiness(db, businessId, (tx) =>
          spendRepo.paySupplier(tx, {
            businessId,
            expenseId,
            amountK: 1_000_000,
            method: 'cash',
            actor: 'user:1',
          }),
        );

      expect(await pay(settled.expenseId)).toMatchObject({ reason: 'nothing_owed' });
      expect(await pay(withdrawn.expenseId)).toMatchObject({ reason: 'withdrawn' });
    });

    /* A merchant of one business must not settle another's purchase, even
     * holding a valid uuid. RLS is what refuses, not a check here. */
    it('will not pay across businesses', async () => {
      const ada = await seedBusiness('+2348120000001');
      const bola = await seedBusiness('+2348120000002');
      const theirs = await withBusiness(db, bola, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId: bola,
          description: 'bales',
          amountK: 5_000_000,
          paidK: 0,
          sourceType: 'chat',
          sourceId: 'x-1',
        }),
      );

      expect(
        await withBusiness(db, ada, (tx) =>
          spendRepo.paySupplier(tx, {
            businessId: ada,
            expenseId: theirs.expenseId,
            amountK: 1_000_000,
            method: 'cash',
            actor: 'user:1',
          }),
        ),
      ).toMatchObject({ outcome: 'refused', reason: 'no_such_purchase' });
    });

    it('lists what is still standing, oldest first', async () => {
      const businessId = await seedBusiness();
      const old = await purchaseAt(businessId, 90, 4_000_000, 0);
      await purchaseAt(businessId, 5, 2_000_000, 0);
      await purchaseAt(businessId, 20, 1_000_000, 1_000_000); // settled at source

      const outstanding = await withBusiness(db, businessId, (tx) =>
        spendRepo.outstandingPurchases(tx, businessId),
      );
      expect(outstanding).toHaveLength(2);
      expect(outstanding[0]).toMatchObject({ expenseId: old.expenseId, owedK: 4_000_000 });

      /* Paying one in full takes it off the list entirely. */
      await withBusiness(db, businessId, (tx) =>
        spendRepo.paySupplier(tx, {
          businessId,
          expenseId: old.expenseId,
          amountK: 4_000_000,
          method: 'cash',
          actor: 'user:1',
        }),
      );
      expect(
        await withBusiness(db, businessId, (tx) => spendRepo.outstandingPurchases(tx, businessId)),
      ).toHaveLength(1);
    });

    /* Append-only, and the REVOKE is what enforces it rather than the comment
     * above the table. */
    it('holds no UPDATE on a payment once made', async () => {
      const businessId = await seedBusiness();
      const purchase = await purchaseAt(businessId, 10, 5_000_000, 0);
      await withBusiness(db, businessId, (tx) =>
        spendRepo.paySupplier(tx, {
          businessId,
          expenseId: purchase.expenseId,
          amountK: 1_000_000,
          method: 'cash',
          actor: 'user:1',
        }),
      );

      const refused = await withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE supplier_payments SET amount_k = 1
               WHERE business_id = ${businessId}::uuid`,
        ),
      ).catch((error: unknown) => {
        for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
          const candidate = e as { code?: string; cause?: unknown };
          if (candidate.code === '42501') return candidate;
          e = candidate.cause;
        }
        return {};
      });
      expect(refused).toMatchObject({ code: '42501' });
    });
  });

  it('is all zeros for a business that owes nothing', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) => spendRepo.payableAgeingFor(tx, businessId)),
    ).toEqual({ d0_30K: 0, d31_60K: 0, d61_90K: 0, d90PlusK: 0, unlinkedK: 0, totalK: 0 });
  });

  /* The boundary an off-by-one lands on. Exactly 30 days old is still the
   * first bucket; 31 has moved on. */
  it('puts the boundary days where the labels say', async () => {
    const businessId = await seedBusiness();
    await purchaseAt(businessId, 30, 1_000_000, 0);
    await purchaseAt(businessId, 31, 2_000_000, 0);

    const ageing = await withBusiness(db, businessId, (tx) =>
      spendRepo.payableAgeingFor(tx, businessId),
    );
    expect(ageing.d0_30K).toBe(1_000_000);
    expect(ageing.d31_60K).toBe(2_000_000);
  });
});

describe('tenancy', () => {
  it('one tenant never reads the other`s spending', async () => {
    const ada = await seedBusiness('+2348120000001');
    const bola = await seedBusiness('+2348120000002');

    await withBusiness(db, ada, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: ada,
        description: 'fuel',
        category: null,
        amountK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );

    expect(await withBusiness(db, bola, (tx) => spendRepo.expensesFor(tx, bola))).toHaveLength(0);
    expect(await withBusiness(db, bola, (tx) => spendRepo.spendFor(tx, bola, 50))).toMatchObject({
      rows: [],
      count: 0,
      expensesK: 0,
      payableK: 0,
    });
    expect(await entriesOf(bola)).toHaveLength(0);
  });
});
