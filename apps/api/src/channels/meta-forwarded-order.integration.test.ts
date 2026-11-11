/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a forwarded order. Split by concern from meta.integration.test.ts; the
 * shared app, stubs and payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  identity,
  catalogueRepo,
  ordersRepo,
  usageRepo,
  stockRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { allowanceFor, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { customersRepo, issueRepo, paymentsHub, reportsRepo } from '@rekoda/db';
import { encryptFacet } from '@rekoda/core/vault';
import {
  db,
  deps,
  invoiceCount,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { setPlanForTest } from '@rekoda/db/testing';

useMetaWebhookHarness();

/**
 * An order somebody else placed (Door 2), end to end.
 *
 * The whole journey a Nigerian merchant actually has: a customer messages
 * them asking for things, they forward that message, and what comes back is a
 * quote priced from their own catalogue. Nothing about it is a sale until
 * they say yes.
 */
describe('a forwarded order', () => {
  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  /** A shop that sells two things, one of them never priced. */
  async function seedCatalogue(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: bale.id,
        delta: 10,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
      await catalogueRepo.editProduct(tx, businessId, bale.id, { unitPriceK: 850_000 });
      await stockRepo.findOrCreateProduct(tx, businessId, 'Head tie');
    });
  }

  const THE_ORDER = {
    intent: 'RecordOrder',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'Ankara bale', quantity: 2 }],
    note: 'deliver to Lekki on Friday',
  };

  it('quotes from the catalogue, then raises the invoice on a yes', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.ORDER');

    /* Priced by Rekoda, from the merchant's own list. Nothing the customer
     * or the model said about money reached this figure. */
    expect(stubSender.lastText).toContain('This is what they are asking for');
    expect(stubSender.lastText).toContain('2 × Ankara bale at ₦8,500');
    expect(stubSender.lastText).toContain('Total: ₦17,000');
    expect(stubSender.lastText).toContain('They also said: deliver to Lekki on Friday');

    // Nothing issued yet, and no order recorded either: this is still a quote.
    expect(await invoiceCount(business.id)).toBe(0);
    expect(
      (await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))).rows,
    ).toEqual([]);

    await send('yes', 'wamid.ORDERYES');
    expect(stubSender.lastText).toMatch(/ORD-\d{4}-000001 is now INV-\d{4}-000001 for ₦17,000/);
    expect(stubSender.lastText).toContain('Nothing has been paid yet');

    expect(await invoiceCount(business.id)).toBe(1);

    const orders = await withBusiness(db, business.id, (tx) =>
      ordersRepo.ordersFor(tx, business.id),
    );
    expect(orders.rows).toHaveLength(1);
    expect(orders.count).toBe(1);
    expect(orders.rows[0]).toMatchObject({ status: 'confirmed', totalK: 1_700_000, itemCount: 1 });

    /* The books balance, read back out of the database. An order confirmed is
     * a sale on credit: receivable up, revenue up, nothing paid. */
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(1_700_000);

    /* And the shelf says so. Ten bales, two committed. */
    const stock = await withBusiness(db, business.id, (tx) => stockRepo.stockList(tx, business.id));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(8);
  });

  /**
   * The persistence boundary (launch remediation R5): the customer's
   * delivery words are echoed to the merchant ONCE and never stored. The
   * contract has said so since RecordOrder existed; this pins that the
   * stored draft actually honours it — through the central
   * sanitizeCommandForPersistence boundary, not a call-site if.
   */
  it('echoes the delivery note once and stores a draft WITHOUT it (R5)', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale, deliver to Lekki on Friday', 'wamid.ORDERNOTE');

    // Said once, to the merchant, from the LIVE command.
    expect(stubSender.lastText).toContain('They also said: deliver to Lekki on Friday');

    /* Never written down. The stored draft keeps every bookkeeping field
     * and none of the customer's words. */
    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ command: Record<string, unknown> }>(sql`
        SELECT command FROM command_drafts WHERE business_id = ${business.id}::uuid
      `),
    );
    const stored = JSON.stringify([...drafts].map((row) => row.command));
    expect(stored).not.toContain('Lekki');
    expect(stored).not.toContain('Friday');
    expect(stored).toContain('Ankara bale');

    // And the sanitised draft still confirms into a real invoice.
    await send('yes', 'wamid.ORDERNOTEYES');
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('meters the order: a confirmed order consumes one orders unit on top of the document', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.METER');
    await send('yes', 'wamid.METERYES');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(1);
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('refuses capture on a plan without orders, keeps the quote, and gives the document back', async () => {
    const business = await seedMerchant('+2348031234567');
    await setPlanForTest(db, {
      businessId: business.id,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:test',
    });
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    /* The quote itself is free and still works: refusing to PRICE would
     * punish the merchant before they even hit the gate. */
    await send('please I want 2 ankara bale', 'wamid.CHATORDER');
    expect(stubSender.lastText).toContain('Total: ₦17,000');

    await send('yes', 'wamid.CHATORDERYES');
    expect(stubSender.lastText).toContain('Automatic order capture is part of the Integrate plan');

    /* Nothing booked, and the document unit the yes reserved went back:
     * a refused capture must not cost a document nobody received. */
    expect(await invoiceCount(business.id)).toBe(0);
    expect(
      (await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))).rows,
    ).toEqual([]);
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used ?? 0).toBe(0);
  });

  /**
   * The other half of the refund, and the reachable one.
   *
   * A merchant with orders LEFT in their entitlement but NONE left in their
   * allowance passes the gate above and fails the counter below, after the
   * document unit is already spent. Two units are reserved in sequence and
   * only one of them was taken, so only one goes back — and the branch that
   * decides which is the same branch every other exit uses. Before the
   * shared refund path this arithmetic lived in seven places, each free to
   * be wrong on its own.
   */
  it('gives the document back when the orders allowance, not the plan, is what refuses', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    const period = usagePeriod(new Date());
    const orderAllowance = allowanceFor('trial', 'CATALOGUE_ORDERS');

    /* A trial month with every order already used. Spent through the same
     * counter the confirmation spends, so the refusal below is the real one. */
    for (let taken = 0; taken < orderAllowance; taken += 1) {
      const granted = await withBusiness(db, business.id, (tx) =>
        usageRepo.consumeUnit(tx, business.id, period, 'CATALOGUE_ORDERS', orderAllowance),
      );
      expect(granted).toBe(true);
    }

    stubTransport.replyWith(THE_ORDER);
    await send('please I want 2 ankara bale', 'wamid.ORDERCAP');
    await send('yes', 'wamid.ORDERCAPYES');

    expect(stubSender.lastText).toContain(`You have used all ${orderAllowance} orders`);
    expect(await invoiceCount(business.id)).toBe(0);

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    /* The document unit the yes reserved came back. */
    expect(rows.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
    /* And the exhausted counter was not moved by the attempt. */
    expect(rows.find((r) => r.unit === 'CATALOGUE_ORDERS')?.used).toBe(orderAllowance);
  });

  /**
   * The refusal that matters. Inventing a price would put a number in front
   * of a customer that the merchant never agreed to, so it asks instead.
   */
  it('asks for a price rather than quoting one it does not have', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith({
      ...THE_ORDER,
      items: [
        { name: 'Ankara bale', quantity: 1 },
        { name: 'Head tie', quantity: 2 },
      ],
    });

    await send('they want a bale and 2 head ties', 'wamid.UNPRICED');
    expect(stubSender.lastText).toContain('I do not have a price for Head tie');
    /* And nothing was quoted, so there is nothing to say yes to. */
    expect(stubSender.lastText).not.toContain('Total:');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The bug the message above would have told a lie about.
   *
   * Order pricing used to run over `catalogueFor`, which returns three
   * hundred products ordered by name. A provisions shop with more than that
   * had everything sorting past the cap answered with "I cannot find it in
   * what you sell" about a product it stocks and has priced. It failed safe,
   * in that no invented figure ever reached a customer, and it was still the
   * assistant telling a merchant their own shop does not carry something.
   */
  it('prices a product the catalogue page would have cut off', async () => {
    const business = await seedMerchant('+2348031234567');
    await withBusiness(db, business.id, async (tx) => {
      for (let i = 0; i < 320; i += 1) {
        await stockRepo.findOrCreateProduct(tx, business.id, `Aaa filler ${i + 1}`);
      }
      const zobo = await stockRepo.findOrCreateProduct(tx, business.id, 'Zobo drink');
      await catalogueRepo.editProduct(tx, business.id, zobo.id, { unitPriceK: 50_000 });
    });
    stubTransport.replyWith({ ...THE_ORDER, items: [{ name: 'Zobo drink', quantity: 4 }] });

    await send('customer wants 4 zobo', 'wamid.PASTCAP');

    expect(stubSender.lastText).toContain('4 × Zobo drink at ₦500');
    expect(stubSender.lastText).toContain('Total: ₦2,000');
    expect(stubSender.lastText).not.toContain('I cannot find');

    // And the yes still raises the invoice, at the price the merchant set.
    await send('yes', 'wamid.PASTCAPYES');
    expect(await invoiceCount(business.id)).toBe(1);
    expect(stubSender.lastText).toMatch(/for ₦2,000/);
  });

  it('says so when the shop does not sell what they asked for', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith({ ...THE_ORDER, items: [{ name: 'gele', quantity: 1 }] });

    await send('customer wants a gele', 'wamid.UNKNOWN');
    expect(stubSender.lastText).toContain('I cannot find gele in what you sell');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The catalogue is re-read at the yes, not carried on the draft. A merchant
   * who changes a price between the preview and the confirmation gets the
   * price they have now, and one who UNPRICES something gets asked rather
   * than an invoice at yesterday's figure.
   */
  it('refuses at the yes if the price it quoted has since gone', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.STALE');
    expect(stubSender.lastText).toContain('Total: ₦17,000');

    await withBusiness(db, business.id, async (tx) => {
      const [bale] = (await catalogueRepo.catalogueFor(tx, business.id)).rows.filter(
        (p) => p.name === 'Ankara bale',
      );
      await catalogueRepo.editProduct(tx, business.id, bale!.id, { unitPriceK: null });
    });

    await send('yes', 'wamid.STALEYES');
    expect(stubSender.lastText).toContain('I do not have a price for Ankara bale');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /**
   * The whole of Door 2, with the money door open: a customer's own message
   * becomes an invoice and a link the merchant can forward straight back.
   *
   * The link needs the customer's EMAIL, which lives in the identity vault
   * against a customer row. Chat-issued invoices used to carry
   * `customer_id = NULL` and keep only the token, so the vault had nothing to
   * hang on and no chat-created invoice could ever be paid online. That is
   * what resolving the token at issue time fixes.
   */
  it('offers a payable link when the shop can take one', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    await withBusiness(db, business.id, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId: business.id,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
    });

    /* The customer the gateway would have resolved, with an email on file:
     * the forwarded message named them, and Rekoda never invents an address. */
    await customersRepo.createCustomerWithIdentities(db, business.id, 'CUSTOMER_7K2', [
      {
        facet: 'email',
        ciphertext: encryptFacet(
          'adaeze@example.com',
          deps.config.vaultKey,
          `${business.id}:email`,
        ),
        matchKey: null,
      },
    ]);

    stubTransport.replyWith(THE_ORDER);
    await send('please I want 2 ankara bale', 'wamid.LINK');
    await send('yes', 'wamid.LINKYES');

    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001: ₦17,000 outstanding/);
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  /* A shop with no provider connection hears nothing extra. The link job runs
   * and stays quiet: telling them after every order that they cannot take
   * card is a sentence they would learn to scroll past. */
  it('says nothing extra when the shop cannot take a payment', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.NOLINK');
    await send('yes', 'wamid.NOLINKYES');

    /* The last thing they heard is the confirmation itself, not an apology. */
    expect(stubSender.lastText).toMatch(/ORD-\d{4}-000001 is now INV-\d{4}-000001/);
    expect(stubSender.lastText).not.toContain('Payment link');
  });

  it('records which invoice the order became', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.LINKED');
    await send('yes', 'wamid.LINKEDYES');

    const [order] = (
      await withBusiness(db, business.id, (tx) => ordersRepo.ordersFor(tx, business.id))
    ).rows;
    expect(order!.invoiceNumber).toMatch(/^INV-\d{4}-000001$/);
  });

  /* A quote is not an agreement to pay on a day. What the customer said about
   * timing is about DELIVERY, and reading it as a payment date would put
   * somebody on the debtors list on a day nobody agreed. */
  it('leaves the invoice undated rather than reading a delivery note as terms', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedCatalogue(business.id);
    stubTransport.replyWith(THE_ORDER);

    await send('please I want 2 ankara bale', 'wamid.DUE');
    await send('yes', 'wamid.DUEYES');

    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows[0]?.dueDate).toBeNull();
  });
});
