/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: due dates, chasing an overdue invoice, and the command bus as the default
 * door. Split by concern from meta.integration.test.ts; the shared app, stubs and payload
 * helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, withBusiness, sql } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, reportsRepo, settleRepo } from '@rekoda/db';
import { type ApiConfig } from '../config.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

/**
 * When the merchant says the money is expected, and what that turns into.
 *
 * The model has always captured the phrase and nothing ever read it: a
 * merchant told us their customer would pay on Friday and we threw it away,
 * which is the whole debtors book discarded at the door.
 */
describe('due dates from what the merchant said', () => {
  const A_SALE_DUE = (dueDescription: string | null) => ({
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription,
  });

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

  async function sell(wamid: string, dueDescription: string | null) {
    stubTransport.replyWith(A_SALE_DUE(dueDescription));
    await post(messagePayload('2348031234567', `${wamid}-sale`, 'Ada bought 3 wigs for 150k'));
    await drain();
    await post(messagePayload('2348031234567', `${wamid}-yes`, 'yes'));
    await drain();
  }

  it('turns a spoken day into a date on the invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE1', 'she will pay on Friday');

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeInstanceOf(Date);
  });

  /* Null is the honest answer and the common one. A guessed date puts a real
   * customer on an overdue list for a deadline nobody agreed. */
  it('leaves the date empty when nobody named one', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE2', null);

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeNull();
  });

  it('leaves the date empty for a phrase that names no day', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE3', 'when she can');

    const list = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(list.rows[0]?.dueDate).toBeNull();
  });

  it('ages the debt into the right bucket once the day has passed', async () => {
    const business = await seedMerchant('+2348031234567');
    await sell('wamid.DUE4', 'in 7 days');

    /* Read from far enough ahead that the promised day is long gone. The
     * ageing query takes `now`, so this needs no clock trickery. */
    const inFortyDays = new Date(Date.now() + 40 * 86_400_000);
    const ageing = await withBusiness(db, business.id, (tx) =>
      reportsRepo.ageingFor(tx, business.id, inFortyDays),
    );
    expect(ageing.d31_60K).toBe(15_000_000);
    expect(ageing.currentK).toBe(0);
    expect(ageing.overdueK).toBe(15_000_000);
  });

  it('tells the merchant in chat how late each debt is', async () => {
    const business = await seedMerchant('+2348031234567');
    /* Issued directly with a day already gone. The resolver deliberately
     * cannot produce a past due date from a phrase — "she will pay
     * yesterday" is not a thing anybody says — so the overdue state is
     * seeded rather than spoken. */
    await withBusiness(db, business.id, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: business.id,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-late',
        actor: 'system',
        dueDate: new Date(Date.now() - 5 * 86_400_000),
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.DUE5-ask', 'who owes me'));
    await drain();

    /* A debtors list is a work queue. Invoice numbers, never customer names:
     * this text crosses WhatsApp in the clear. */
    expect(stubSender.lastText).toMatch(/day(s)? late/);
    expect(stubSender.lastText).toContain('past the day it was promised');
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
  });

  it('says nothing about lateness when nothing is late', async () => {
    await seedMerchant('+2348031234567');
    await sell('wamid.DUE6', 'next month');

    await post(messagePayload('2348031234567', 'wamid.DUE6-ask', 'who owes me'));
    await drain();

    expect(stubSender.lastText).not.toContain('late');
    expect(stubSender.lastText).not.toContain('past the day it was promised');
  });
});

/**
 * The reminder a merchant forwards to the person who owes them.
 *
 * Two messages: ours to them, then theirs to forward. The second is written
 * to be read by a customer, so what it must NOT contain is as much of the
 * assertion as what it must.
 */
describe('chasing an overdue invoice', () => {
  async function seedMerchant(phone: string, name = 'Ada Fashion') {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name,
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /** An unpaid invoice, `daysLate` past the day it was promised. */
  async function overdueInvoice(businessId: string, daysLate: number, totalK = 15_000_000) {
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: totalK / 3 }],
        subtotalK: totalK,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK,
        paidK: 0,
        balanceDueK: totalK,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: `draft-chase-${daysLate}`,
        actor: 'system',
        dueDate: new Date(Date.now() - daysLate * 86_400_000),
      }),
    );
  }

  it('hands over a forwardable reminder, as its own message', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 5);

    await post(messagePayload('2348031234567', 'wamid.CHASE1', `remind ${sale.invoiceNumber}`));
    await drain();

    /* Two messages: the forwardable one, then the instruction above it. The
     * merchant reads the instruction last and forwards what is under their
     * thumb. */
    const sent = stubSender.sent.map((m) => m.text);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain(sale.invoiceNumber);
    expect(sent[0]).toContain('₦150,000');
    expect(sent[0]).toContain('5 days overdue');
    expect(sent[1]).toContain('Forward the next message');
  });

  /**
   * The forwardable message is read by a CUSTOMER. It must not announce that
   * a robot wrote it, and it must not carry a token or anybody's name.
   */
  it('writes the reminder for the customer, not for the merchant', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 3);

    await post(messagePayload('2348031234567', 'wamid.CHASE2', `remind ${sale.invoiceNumber}`));
    await drain();

    const forwardable = stubSender.sent[0]!.text;
    expect(forwardable).toContain('Ada Fashion');
    expect(forwardable).not.toContain('CUSTOMER_');
    expect(forwardable).not.toContain('Rekoda');
    // Somebody who has already paid should not be accused of anything.
    expect(forwardable).toContain('If you have already sent it');
  });

  it('says there is nothing to chase on a settled invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    const sale = await overdueInvoice(business.id, 10);
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: sale.invoiceId,
        amountK: 15_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'settled',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.CHASE3', `remind ${sale.invoiceNumber}`));
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
  });

  it('says the same for an invoice that never existed', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.CHASE4', 'remind INV-2026-999999'));
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
  });

  /**
   * Tenant isolation on a command that names a document by number. Another
   * merchant's invoice number is not a secret, so the answer has to be the
   * same as for one that does not exist.
   */
  it('will not chase another business invoice', async () => {
    const ada = await seedMerchant('+2348031234567', 'Ada Fashion');
    const chidi = await seedMerchant('+2348039990002', 'Chidi Electronics');
    const chidiSale = await overdueInvoice(chidi.id, 8);
    expect(ada.id).not.toBe(chidi.id);

    await post(
      messagePayload('2348031234567', 'wamid.CHASE5', `remind ${chidiSale.invoiceNumber}`),
    );
    await drain();

    expect(stubSender.lastText).toContain('nothing owing');
    expect(stubSender.sent.every((m) => !m.text.includes('Chidi'))).toBe(true);
  });
});

/**
 * Build 9, OD-4 (approved 8 Oct 2026): the command bus is the default door.
 *
 * The rest of this file now runs every write through the bus by default;
 * these prove it at the ingress, side by side with the rollback. Two
 * merchants, one on the default configuration and one with that command's
 * flag at `0`, book the same thing: the business truth (documents, money,
 * stock and every ledger account's net movement) must be identical, and
 * the only difference is the bus's own idempotency claim.
 */
describe('the command bus is the default door, and 0 rolls back to the same truth (Build 9)', () => {
  const BUS = '2348039991011';
  const DIRECT = '2348039991012';
  const SALE = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const PURCHASE = {
    intent: 'RecordPurchase',
    supplierMention: 'Emeka',
    description: '10 cartons',
    amount: 180_000,
    reportedPayment: 100_000,
    paymentMethod: 'cash',
    productMention: 'cartons',
    quantity: 10,
  };

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, `+${phone}`);
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

  async function say(phone: string, wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload(phone, wamid, text));
    await drain();
  }

  async function plain(phone: string, wamid: string, text: string) {
    await post(messagePayload(phone, wamid, text));
    await drain();
  }

  /** Run `fn` with one command flag set as an operator's `0` would set it. */
  async function rolledBack<T>(flag: keyof ApiConfig, fn: () => Promise<T>): Promise<T> {
    const config = deps.config as unknown as Record<string, boolean>;
    const was = config[flag as string]!;
    config[flag as string] = false;
    try {
      return await fn();
    } finally {
      config[flag as string] = was;
    }
  }

  async function claims(businessId: string, command: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ key: string; completed: boolean }>(sql`
        SELECT key, completed_at IS NOT NULL AS completed FROM idempotency_records
         WHERE business_id = ${businessId}::uuid AND command_name = ${command}
         ORDER BY created_at`),
    );
    return [...rows];
  }

  /** The business truth: documents, money, stock, and every account's net. */
  async function truth(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
            (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}::uuid) AS receipts,
            (SELECT count(*)::int FROM expenses WHERE business_id = ${businessId}::uuid) AS purchases,
            (SELECT count(*)::int FROM bills WHERE business_id = ${businessId}::uuid) AS bills,
            (SELECT count(*)::int FROM inventory_movements WHERE business_id = ${businessId}::uuid) AS movements,
            (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${businessId}::uuid) AS postings,
            (SELECT count(*)::int FROM outbox_events WHERE business_id = ${businessId}::uuid) AS announcements,
            (SELECT count(*)::int FROM jobs WHERE business_id = ${businessId}::uuid AND kind = 'document.render') AS documents
        `),
      )),
    ];
    const nets: Record<string, number> = {};
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    for (const e of entries) nets[e.account] = (nets[e.account] ?? 0) + e.debitK - e.creditK;
    return { counts: row!, nets };
  }

  it('a Chat sale takes the bus by default; 0 books the same sale, payment, receipt and ledger directly', async () => {
    const bus = await seedMerchant(BUS);
    const direct = await seedMerchant(DIRECT);

    await say(BUS, 'wamid.B9-s-bus', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
    await plain(BUS, 'wamid.B9-s-bus-yes', 'yes');
    await rolledBack('commandRecordSale', async () => {
      await say(DIRECT, 'wamid.B9-s-dir', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
      await plain(DIRECT, 'wamid.B9-s-dir-yes', 'yes');
    });

    const onBus = await truth(bus.id);
    expect(onBus.counts).toMatchObject({ invoices: 1, payments: 1, receipts: 1 });
    expect(await truth(direct.id)).toEqual(onBus);
    /* The only difference is the bus's claim, keyed on the confirmed draft. */
    const busClaims = await claims(bus.id, 'RecordSale');
    expect(busClaims).toHaveLength(1);
    expect(busClaims[0]!.key).toMatch(/^draft:/);
    expect(busClaims[0]!.completed).toBe(true);
    expect(await claims(direct.id, 'RecordSale')).toHaveLength(0);
  });

  it('a redelivered yes, and a second yes, on the bus book nothing twice', async () => {
    const bus = await seedMerchant(BUS);
    await say(BUS, 'wamid.B9-r', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
    await plain(BUS, 'wamid.B9-r-yes', 'yes');
    const once = await truth(bus.id);
    /* Meta redelivers the same webhook (dropped by the message's own
     * dedupe), and the merchant says yes again (a new message: the draft is
     * already claimed, so nothing reaches the bus a second time). */
    await plain(BUS, 'wamid.B9-r-yes', 'yes');
    await plain(BUS, 'wamid.B9-r-yes-2', 'yes');
    expect(await truth(bus.id)).toEqual(once);
    expect(await claims(bus.id, 'RecordSale')).toHaveLength(1);
  });

  it('a Chat purchase takes the bus by default; 0 books the same purchase, stock, bill and accounts', async () => {
    const bus = await seedMerchant(BUS);
    const direct = await seedMerchant(DIRECT);

    await say(BUS, 'wamid.B9-p-bus', PURCHASE, 'bought 10 cartons from Emeka 180k, paid 100k cash');
    await plain(BUS, 'wamid.B9-p-bus-yes', 'yes');
    await rolledBack('commandRecordPurchase', async () => {
      await say(
        DIRECT,
        'wamid.B9-p-dir',
        PURCHASE,
        'bought 10 cartons from Emeka 180k, paid 100k cash',
      );
      await plain(DIRECT, 'wamid.B9-p-dir-yes', 'yes');
    });

    const onBus = await truth(bus.id);
    /* G-61 unchanged: the paid part leaves Cash, the rest is owed. */
    expect(onBus.counts).toMatchObject({ purchases: 1, bills: 1, movements: 1 });
    expect(onBus.nets).toMatchObject({
      INVENTORY: 18_000_000,
      CASH: -10_000_000,
      ACCOUNTS_PAYABLE: -8_000_000,
    });
    expect(await truth(direct.id)).toEqual(onBus);
    expect(await claims(bus.id, 'RecordPurchase')).toHaveLength(1);
    expect(await claims(direct.id, 'RecordPurchase')).toHaveLength(0);
  });

  it('one command rolled back leaves every other command on the bus', async () => {
    const bus = await seedMerchant(BUS);
    await rolledBack('commandRecordSale', async () => {
      await say(BUS, 'wamid.B9-o-p', PURCHASE, 'bought 10 cartons from Emeka 180k, paid 100k cash');
      await plain(BUS, 'wamid.B9-o-p-yes', 'yes');
      await say(BUS, 'wamid.B9-o-s', SALE, 'Ada bought 3 wigs 150k, paid 100k transfer');
      await plain(BUS, 'wamid.B9-o-s-yes', 'yes');
    });
    expect(await claims(bus.id, 'RecordPurchase')).toHaveLength(1);
    expect(await claims(bus.id, 'RecordSale')).toHaveLength(0);
  });
});
