/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: stock arriving with a purchase (part 1 of 2). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { issueRepo } from '@rekoda/db';
import { db, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import {
  buy,
  seedMerchant,
  say,
  plain,
  onHand,
  cartons,
  nets,
  purchaseRows,
  purchaseFootprint,
} from './meta-stock-purchase.fixtures.js';

useMetaWebhookHarness();

/**
 * A purchase that is also a delivery.
 *
 * "bought 10 crates of ankara for 50k" is two facts, and until the contract
 * carried a product and a quantity only the money one was recorded: a sale
 * took stock off the shelf and a purchase never put any back.
 */
describe('stock arriving with a purchase', () => {
  for (const c of [
    {
      name: 'paid in full by transfer',
      over: { reportedPayment: 180_000, paymentMethod: 'transfer' },
      text: 'I bought 10 cartons for 180k from Emeka, paid transfer',
      preview: ['Paid in full by transfer'],
      ledger: { INVENTORY: 18_000_000, BANK: -18_000_000 },
      register: 'transfer',
    },
    {
      name: 'paid in full by cash',
      over: { reportedPayment: 180_000, paymentMethod: 'cash' },
      text: 'I bought 10 cartons for 180k from Emeka, paid cash',
      preview: ['Paid in full by cash'],
      ledger: { INVENTORY: 18_000_000, CASH: -18_000_000 },
      register: 'cash',
    },
    {
      name: 'wholly on credit',
      over: { reportedPayment: 0, paymentMethod: null },
      text: 'I bought 10 cartons for 180k from Emeka on credit',
      preview: ['Paid: nothing yet', 'Owing to supplier: ₦180,000'],
      ledger: { INVENTORY: 18_000_000, ACCOUNTS_PAYABLE: -18_000_000 },
      register: 'credit',
    },
    {
      name: 'part paid by transfer',
      over: { reportedPayment: 100_000, paymentMethod: 'transfer' },
      text: 'I bought 10 cartons for 180k from Emeka, paid 100k transfer',
      preview: ['Paid: ₦100,000 by transfer', 'Owing to supplier: ₦80,000'],
      ledger: { INVENTORY: 18_000_000, BANK: -10_000_000, ACCOUNTS_PAYABLE: -8_000_000 },
      register: 'transfer',
    },
  ] as const) {
    it(`G-61: ${c.name}, the preview names the account and yes posts to it`, async () => {
      const business = await seedMerchant('+2348031234567');
      await say(`wamid.G61-${c.name}`, cartons(c.over), c.text);
      for (const line of c.preview) expect(stubSender.lastText).toContain(line);
      if (c.register === 'credit') expect(stubSender.lastText).not.toMatch(/by cash|by transfer/);
      /* Nothing is written before the yes. */
      expect(await purchaseRows(business.id)).toHaveLength(0);

      await plain(`wamid.G61-${c.name}-yes`, 'yes');
      expect(await nets(business.id)).toEqual(c.ledger);
      const rows = await purchaseRows(business.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amountK: 18_000_000, method: c.register });
      expect((await onHand(business.id, 'cartons'))?.onHand).toBe(10);
    });
  }

  it('G-61: money paid with no stated account is asked about, never guessed', async () => {
    const business = await seedMerchant('+2348031234567');
    /* Part paid, method not said. */
    await say(
      'wamid.G61-ask',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    /* Kept on the record, never confirmable. */
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    /* The draft that asked is retired, never confirmable: a yes straight
     * after it gets the question again, and writes nothing. */
    await plain('wamid.G61-ask-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );

    /* "Bought 20 bags for 400k" reads as paid in full, from an account nobody
     * named: also a question, whatever the model thought of the method. */
    for (const paymentMethod of [null, 'unknown']) {
      await say(
        `wamid.G61-implied-${String(paymentMethod)}`,
        buy({
          description: '20 bags',
          amount: 400_000,
          reportedPayment: null,
          paymentMethod,
          productMention: 'bags',
          quantity: 20,
        }),
        'Bought 20 bags for 400k from Chima',
      );
      expect(stubSender.lastText).toContain('did you pay it all by cash or by transfer?');
    }

    expect(await purchaseRows(business.id)).toHaveLength(0);
    expect(await nets(business.id)).toEqual({});
    expect(await onHand(business.id, 'cartons')).toBeNull();
  });

  it('G-61: POS, then the bank answer, then yes twice records the purchase exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-dup-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    /* The clarification is on the record but not confirmable. */
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    await say(
      'wamid.G61-dup-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');

    await plain('wamid.G61-dup-yes1', 'yes');
    expect(stubSender.lastText).toContain('Saved');
    /* The second, double-tapped yes resurrects nothing. */
    await plain('wamid.G61-dup-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(stubSender.lastText).not.toContain('did it come from your bank account');

    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 0,
      announced: 1,
      pending: 0,
      retired: 0,
    });
    expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, BANK: -18_000_000 });

    /* A stray "no" later, with nothing waiting, cancels nothing: it never
     * says "Cancelled" over the recorded purchase. The answered question
     * keeps its record, CLOSED by the resend (G-68 review: a new preview
     * closes every older retired question, so nobody can rebuild it). */
    const sentBefore = stubSender.sent.length;
    await plain('wamid.G61-dup-no', 'no');
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text ?? '')).not.toContainEqual(
      expect.stringContaining('Cancelled'),
    );
    expect(await purchaseFootprint(business.id)).toMatchObject({ purchases: 1, retired: 0 });
  });

  it('G-61: part paid from an unnamed account, then the transfer answer, then yes twice: exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-dup-part',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );

    await say(
      'wamid.G61-dup-part-transfer',
      cartons({ reportedPayment: 100_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid 100k transfer',
    );
    expect(stubSender.lastText).toContain('Paid: ₦100,000 by transfer');

    await plain('wamid.G61-dup-part-yes1', 'yes');
    await plain('wamid.G61-dup-part-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');

    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 1,
      announced: 1,
      pending: 0,
      retired: 0,
    });
    expect(await nets(business.id)).toEqual({
      INVENTORY: 18_000_000,
      BANK: -10_000_000,
      ACCOUNTS_PAYABLE: -8_000_000,
    });
  });

  it('G-61: a ₦0 purchase, then the resend with an amount, then yes twice: exactly once', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-zero',
      cartons({ amount: 0, reportedPayment: 0, paymentMethod: null }),
      'I bought 10 cartons for 0 from Emeka',
    );
    expect(stubSender.lastText).toContain('I read the stock as costing ₦0');
    expect(await purchaseFootprint(business.id)).toMatchObject({ pending: 0, retired: 1 });

    await say(
      'wamid.G61-zero-resend',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid transfer',
    );
    await plain('wamid.G61-zero-yes1', 'yes');
    await plain('wamid.G61-zero-yes2', 'yes');
    /* The retired ₦0 question is never answered again as if still open. */
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(stubSender.lastText).not.toContain('costing ₦0');
    expect(await purchaseFootprint(business.id)).toEqual({
      purchases: 1,
      postings: 1,
      arrivals: 1,
      bills: 0,
      announced: 1,
      pending: 0,
      retired: 0,
    });
  });

  it('G-61: a yes straight after the question never confirms an OLDER preview behind it', async () => {
    const business = await seedMerchant('+2348031234567');
    /* A sale previewed and left waiting. */
    await say(
      'wamid.G61-older-sale',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 1, unitPrice: 10_000 }],
        statedTotal: 10_000,
        reportedPayment: 0,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold a wig for 10k',
    );
    expect(stubSender.lastText).toContain('Reply *yes*');

    /* Then a purchase that can only be asked about. */
    await say(
      'wamid.G61-older-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );

    /* "yes", aimed at that question: it is asked again, the sale is not
     * confirmed behind the merchant's back, and nothing is written. */
    await plain('wamid.G61-older-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    const [counts] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases,
            (SELECT count(*)::int FROM command_drafts
              WHERE business_id = ${business.id}::uuid AND state = 'pending') AS pending
        `),
      )),
    ];
    /* The older sale is closed by the question, kept on the record. */
    expect(counts).toEqual({ invoices: 0, purchases: 0, pending: 0 });

    /* The merchant answers by resending, then double-taps yes: the
     * replacement is saved once and the older sale is still never
     * confirmed behind the merchant's back. */
    await say(
      'wamid.G61-older-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    await plain('wamid.G61-older-yes1', 'yes');
    expect(stubSender.lastText).toContain('Saved');
    await plain('wamid.G61-older-yes2', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    const [after] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases
        `),
      )),
    ];
    expect(after).toEqual({ invoices: 0, purchases: 1 });

    /* A stray "no" days later finds nothing hidden to cancel. */
    const sentBefore = stubSender.sent.length;
    await plain('wamid.G61-older-no', 'no');
    expect(stubSender.sent.slice(sentBefore).map((m) => m.text ?? '')).not.toContainEqual(
      expect.stringContaining('Cancelled'),
    );

    /* And a NEW sale previewed after all this is confirmed as normal. */
    await say(
      'wamid.G61-older-new-sale',
      {
        intent: 'RecordSale',
        customer: { kind: 'none' },
        items: [{ name: 'wig', quantity: 1, unitPrice: 10_000 }],
        statedTotal: 10_000,
        reportedPayment: 0,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold a wig for 10k',
    );
    await plain('wamid.G61-older-new-yes', 'yes');
    const [last] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${business.id}::uuid) AS invoices,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS purchases
        `),
      )),
    ];
    expect(last).toEqual({ invoices: 1, purchases: 1 });
  });

  it('G-61: two purchase questions in a row, then yes, asks the second one again', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-two-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    await say(
      'wamid.G61-two-part',
      cartons({ reportedPayment: 100_000, paymentMethod: null }),
      'I bought 10 cartons for 180k from Emeka, paid 100k',
    );
    await plain('wamid.G61-two-yes', 'yes');
    expect(stubSender.lastText).toContain(
      'You paid ₦100,000 for this stock. Was that cash or transfer?',
    );
    /* The newest question wins (G-68, Codex review): asking the second one
     * closed the first, so ONE question is still open, the newest. */
    expect(await purchaseFootprint(business.id)).toMatchObject({
      purchases: 0,
      postings: 0,
      pending: 0,
      retired: 1,
    });
  });

  it('G-61: a question the merchant cancels with "no" is never asked again by a later yes', async () => {
    const business = await seedMerchant('+2348031234567');
    /* The arithmetic question (paid more than it cost) keeps its old
     * behaviour: "no" cancels it and a later yes has nothing to confirm. */
    await say(
      'wamid.G61-over',
      cartons({ reportedPayment: 200_000, paymentMethod: 'cash' }),
      'I bought 10 cartons for 180k from Emeka, paid 200k cash',
    );
    expect(stubSender.lastText).toContain('which is ₦20,000 more');
    await plain('wamid.G61-over-no', 'no');
    await plain('wamid.G61-over-yes', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');

    /* The funding question too: "no" closes it for good. */
    await say(
      'wamid.G61-no-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'did it come from your bank account or from physical cash?',
    );
    await plain('wamid.G61-no-pos-no', 'no');
    expect(stubSender.lastText).toContain('Cancelled');
    await plain('wamid.G61-no-pos-yes', 'yes');
    expect(stubSender.lastText).toContain('There is nothing waiting for a yes');
    expect(await purchaseFootprint(business.id)).toMatchObject({
      purchases: 0,
      postings: 0,
      pending: 0,
      retired: 0,
    });
  });

  it('G-61: a POS payer is asked where the money came from, and the answer posts to it', async () => {
    const business = await seedMerchant('+2348031234567');
    await say(
      'wamid.G61-pos',
      cartons({ reportedPayment: 180_000, paymentMethod: 'pos' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS',
    );
    expect(stubSender.lastText).toContain(
      'I know you paid by POS. I just need the source of the money for your books',
    );
    expect(stubSender.lastText).not.toContain('Was that cash or transfer?');
    expect(await purchaseRows(business.id)).toHaveLength(0);

    /* Sent again with the source: "POS from my bank account" reads as transfer. */
    await say(
      'wamid.G61-pos-bank',
      cartons({ reportedPayment: 180_000, paymentMethod: 'transfer' }),
      'I bought 10 cartons for 180k from Emeka, paid by POS from my bank account',
    );
    expect(stubSender.lastText).toContain('Paid in full by transfer');
    await plain('wamid.G61-pos-bank-yes', 'yes');
    expect(await nets(business.id)).toEqual({ INVENTORY: 18_000_000, BANK: -18_000_000 });
  });

  it('names the delivery in the preview and writes nothing yet', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P1', buy(), 'bought 10 crates of ankara for 50k');

    expect(stubSender.lastText).toContain('Adding to stock: 10 crates of ankara');
    expect(await onHand(business.id, 'crates of ankara')).toBeNull();
  });

  it('puts the stock on the shelf on yes, and says the new count', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P2', buy(), 'bought 10 crates of ankara for 50k');
    await plain('wamid.P3', 'yes');

    expect(stubSender.lastText).toContain('crates of ankara is now 10 on hand');
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(10);
  });

  it('adds onto a count the merchant already had', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.P4',
      { intent: 'AdjustInventory', productMention: 'crates of ankara', quantityDelta: 4 },
      'add 4 crates of ankara',
    );
    await plain('wamid.P5', 'yes');
    await say('wamid.P6', buy(), 'bought 10 more crates of ankara for 50k');
    await plain('wamid.P7', 'yes');

    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(14);
  });

  /**
   * The whole point of a cost, end to end and through the real chat path.
   *
   * A delivery says what ten crates cost. A sale of three takes three off the
   * shelf AND posts what those three cost, so the profit and loss stops
   * reporting gross profit equal to revenue.
   */
  it('a delivery sets the cost, and a later sale posts it against the goods', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.C1', buy(), 'bought 10 crates of ankara for 50k');
    await plain('wamid.C2', 'yes');
    expect((await onHand(business.id, 'crates of ankara'))?.unitCostK).toBe(5_000_00);

    await say(
      'wamid.C3',
      {
        intent: 'RecordSale',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'crates of ankara', quantity: 3, unitPrice: 9_000 }],
        statedTotal: 27_000,
        reportedPayment: 27_000,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold 3 crates of ankara for 27k',
    );
    await plain('wamid.C4', 'yes');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    /* Three at ₦5,000: the cost of exactly what left the shelf. */
    expect(entries).toContainEqual(expect.objectContaining({ account: 'COGS', debitK: 15_000_00 }));
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', creditK: 15_000_00 }),
    );
    /* And the books still balance with a second posting on the same sale. */
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(7);
  });
});
