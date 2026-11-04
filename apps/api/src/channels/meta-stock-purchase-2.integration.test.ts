/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: stock arriving with a purchase (part 2 of 2). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { stockRepo, withBusiness } from '@rekoda/db';
import { issueRepo } from '@rekoda/db';
import { db, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import { buy, seedMerchant, say, plain, onHand } from './meta-stock-purchase.fixtures.js';

useMetaWebhookHarness();

/**
 * A purchase that is also a delivery.
 *
 * "bought 10 crates of ankara for 50k" is two facts, and until the contract
 * carried a product and a quantity only the money one was recorded: a sale
 * took stock off the shelf and a purchase never put any back.
 */
describe('stock arriving with a purchase', () => {
  /**
   * A product nobody has ever bought through Rekoda has no cost, and a sale
   * of it must post none rather than nothing-per-unit. The revenue stands;
   * the statements say how much of it had no cost against it.
   */
  it('posts no cost for goods nobody has told Rekoda the price of', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.C5',
      { intent: 'AdjustInventory', productMention: 'head ties', quantityDelta: 40 },
      'add 40 head ties',
    );
    await plain('wamid.C6', 'yes');
    await say(
      'wamid.C7',
      {
        intent: 'RecordSale',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
        items: [{ name: 'head ties', quantity: 2, unitPrice: 2_500 }],
        statedTotal: 5_000,
        reportedPayment: 5_000,
        paymentMethod: 'cash',
        discount: null,
        deliveryFee: null,
        dueDescription: null,
      },
      'sold 2 head ties for 5k',
    );
    await plain('wamid.C8', 'yes');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries.some((e) => e.account === 'COGS')).toBe(false);
    /* The sale itself is recorded in full: an unknown cost is not a reason to
     * lose the revenue. */
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'SALES_REVENUE', creditK: 5_000_00 }),
    );
  });

  it('moves no stock for a purchase the merchant described in prose', async () => {
    const business = await seedMerchant('+2348031234567');

    await say(
      'wamid.P8',
      buy({ description: 'restocked the shop', productMention: null, quantity: null }),
      'restocked the shop, 50k',
    );
    await plain('wamid.P9', 'yes');

    /* A purchase of a service, or one described only in prose, is still a
     * purchase. It just is not a count. */
    expect(stubSender.lastText).toContain('Saved');
    expect(stubSender.lastText).not.toContain('on hand');
    expect(
      (await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id))).rows,
    ).toEqual([]);
  });

  it('still records the money owed when stock arrives part paid', async () => {
    const business = await seedMerchant('+2348031234567');

    await say('wamid.P10', buy({ reportedPayment: 20_000 }), 'bought 10 crates, paid 20k');
    await plain('wamid.P11', 'yes');

    expect(stubSender.lastText).toContain('₦30,000');
    expect((await onHand(business.id, 'crates of ankara'))?.onHand).toBe(10);
  });
});
