/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: two records for one person, and a storefront buyer named later. Split by
 * concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
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

useMetaWebhookHarness();

/**
 * One person, two records, and the question that joins them.
 *
 * A message naming somebody by phone AND email used to mint two customers
 * silently. Merging them automatically was never an option: "Ada 0803...,
 * send it to accounts@bigco.com" is the same shape to a regular expression,
 * and guessing would put one customer's address on another's invoice.
 *
 * So the merchant is asked, inside the preview they are already reading, and
 * one `yes` covers the sale and the link. What these tests pin is that the
 * question is really asked, that it is only asked where a `yes` would answer
 * it, and that nothing is joined without it.
 */
describe('two records for one person', () => {
  const A_SALE_TO_TOKEN = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_ONE' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

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

  /**
   * How many customers this pair of facets resolves to, asked the way the
   * product asks: by tokenising them again. Counting rows would prove the
   * same thing about the database; this proves it about the merchant, whose
   * complaint was seeing one person twice.
   */
  const distinctCustomers = async (businessId: string): Promise<number> => {
    const { text } = await deps.gateway.tokenise(
      businessId,
      'about 08031234567 and ada@example.com',
    );
    return new Set([...text.matchAll(/CUSTOMER_[0-9A-Z]{3}/g)].map((m) => m[0])).size;
  };

  it('asks in the preview, naming what the merchant actually typed', async () => {
    await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L1',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();

    /* Rehydrated on the way out, like every other reply that names a
     * customer: what they read is the number and the address they typed. */
    expect(stubSender.lastText).toContain('same customer');
    expect(stubSender.lastText).toContain('08031234567');
    expect(stubSender.lastText).toContain('ada@example.com');
    // And it is still a preview: nothing has been written.
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  it('joins them on yes, leaving ONE customer holding BOTH facets', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L2',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();
    expect(await distinctCustomers(business.id)).toBe(2);

    await post(messagePayload('2348031234567', 'wamid.L2-yes', 'yes'));
    await drain();

    // One person, one token, whichever way the merchant refers to them.
    expect(await distinctCustomers(business.id)).toBe(1);
    // And the sale the merchant actually asked for still happened.
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('joins nothing when the merchant says no', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L3',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();

    await post(messagePayload('2348031234567', 'wamid.L3-no', 'no'));
    await drain();

    // Two records, and no sale: `no` refuses the whole preview.
    expect(await distinctCustomers(business.id)).toBe(2);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('does not ask on an expense, where a yes would not be about a customer', async () => {
    await seedMerchant('+2348031234567');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'diesel',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L4',
        'paid 12k for diesel, tell 08031234567 and ada@example.com',
      ),
    );
    await drain();

    expect(stubSender.lastText).not.toContain('same customer');
  });

  it('forgets the question when the preview carrying it was never delivered', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_SALE_TO_TOKEN);
    stubSender.failWith();

    await post(
      messagePayload(
        '2348031234567',
        'wamid.L5',
        'Ada 08031234567 ada@example.com bought 3 wigs for 150k',
      ),
    );
    await drain();
    await post(messagePayload('2348031234567', 'wamid.L5-yes', 'yes'));
    await drain();

    /* Nobody was asked, so a later yes joins nothing (G-60 owner decision). */
    expect(await distinctCustomers(business.id)).toBe(2);
  });
});

/**
 * A buyer the merchant names in Chat after they checked out on the public
 * storefront (G-60 owner decision, 14 Oct 2026). The storefront name is
 * untrusted, so it never matches; the model's mention makes a NEW trusted
 * customer beside the phone one. The merchant is asked whether they are one
 * person, in the preview, and a yes leaves one customer whose one name is
 * the one the merchant gave.
 */
describe('a storefront buyer named later in Chat', () => {
  const PHONE = '08035551234';
  const SALE_TO_CHIDI = {
    intent: 'RecordSale',
    customer: { kind: 'mention', mention: 'Chidi Okafor' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  async function seedMerchant() {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
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

  /** Customers, and each name facet with whether it is a known name. */
  const ledger = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const customers = [
        ...(await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM customers WHERE business_id = ${businessId}::uuid`,
        )),
      ][0]!.n;
      const names = [
        ...(await tx.execute<{ customer_id: string; trusted: boolean }>(sql`
          SELECT customer_id, match_key IS NOT NULL AS trusted FROM customer_identities
           WHERE business_id = ${businessId}::uuid AND facet = 'name'`)),
      ];
      return { customers, names };
    });

  const tokenOf = async (businessId: string, text: string) =>
    (await deps.gateway.tokenise(businessId, text)).text.match(/CUSTOMER_[0-9A-Z]+/)?.[0];

  it('asks, joins on yes, and keeps the merchant-given name as the one name', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload('2348031234567', 'wamid.SF1', `Chidi Okafor ${PHONE} bought 3 wigs for 150k`),
    );
    await drain();

    expect(stubSender.lastText).toContain('same customer');
    expect(stubSender.lastText).toContain('Reply *yes*');
    // Asked, not done: two records until the merchant says yes.
    expect((await ledger(business.id)).customers).toBe(2);

    await post(messagePayload('2348031234567', 'wamid.SF1-yes', 'yes'));
    await drain();

    const after = await ledger(business.id);
    expect(after.customers).toBe(1);
    // One name, the trusted one, on the customer that kept the phone.
    expect(after.names).toHaveLength(1);
    expect(after.names[0]!.trusted).toBe(true);
    const byPhone = await tokenOf(business.id, `call ${PHONE}`);
    expect(byPhone).toBeDefined();
    expect(await tokenOf(business.id, 'Chidi Okafor paid')).toBe(byPhone);
    expect(await invoiceCount(business.id)).toBe(1);
    /* The sale is on the customer that survived, by id and by token, never
     * on the record the yes just absorbed. */
    const [invoice] = await withBusiness(db, business.id, async (tx) => [
      ...(await tx.execute<{ customer_id: string | null; token: string | null }>(sql`
        SELECT i.customer_id, i.snapshot_json->>'customerToken' AS token
          FROM invoices i WHERE i.business_id = ${business.id}::uuid`)),
    ]);
    const [survivor] = await withBusiness(db, business.id, async (tx) => [
      ...(await tx.execute<{ id: string; token: string }>(
        sql`SELECT id, token FROM customers WHERE business_id = ${business.id}::uuid`,
      )),
    ]);
    expect(invoice!.customer_id).toBe(survivor!.id);
    expect(invoice!.token).toBe(survivor!.token);
  });

  /* Codex on #271: a preview long enough to be cut loses the question at
   * its end; a yes to what the merchant saw never joins the customers. */
  it('joins nothing when the question was cut from a long preview', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    const items = Array.from({ length: 30 }, (_, i) => ({
      name: `long description wig number ${i + 1}`,
      quantity: 1,
      unitPrice: 5_000,
    }));
    stubTransport.replyWith({ ...SALE_TO_CHIDI, items, statedTotal: 150_000 });

    await post(
      messagePayload('2348031234567', 'wamid.SF8', `Chidi Okafor ${PHONE} bought 30 wigs for 150k`),
    );
    await drain();
    expect(stubSender.lastText).not.toContain('same customer');

    await post(messagePayload('2348031234567', 'wamid.SF8-yes', 'yes'));
    await drain();
    expect((await ledger(business.id)).customers).toBe(2);
  });

  /* Codex on #271: a message the known-name pass could not finish reaches
   * no model, and the merchant is asked to send it in parts. */
  it('sends no model a message too crafted to read, and asks for shorter parts', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveMention(business.id, 'Chidi Okafor');
    const marks = '!"#$%&()*+,./:;<=>?@[\\]^_`{|}~';
    const run = (k: number) =>
      Array.from({ length: 39 }, (_, i) => marks[(i * 7 + k * 13 + i * k) % 31]).join('');
    const crafted = Array.from({ length: 48 }, (_, k) => `${run(k)}a${run(k + 100)}`).join(' ');
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload('2348031234567', 'wamid.SF9', `Chidi Okafor bought 3 wigs ${crafted}`),
    );
    await drain();

    expect(stubTransport.requests).toHaveLength(0);
    expect(stubSender.lastText).toContain('shorter parts');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  /* G-07: text the interpreter refuses for raw protected fields (here an
   * account number that only reads as one once a long name became a short
   * token) is answered, and the message unit it took goes back. */
  it('answers a message the interpreter refuses as raw, and gives its unit back', async () => {
    const business = await seedMerchant();
    const { token } = await deps.gateway.resolveMention(business.id, 'Adaeze Obiageli Okonkwo');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE customers SET token = 'CUSTOMER_QQQ' WHERE token = ${token}`),
    );
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.RAW1',
        'send to Adaeze Obiageli Okonkwo 0123456789 for the wigs',
      ),
    );
    await drain();

    expect(stubTransport.requests).toHaveLength(0);
    expect(stubSender.lastText).toContain('could not read that safely');
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
    /* Nothing of it is kept: the history holds the placeholder. */
    const stored = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ body: string }>(
        sql`SELECT body FROM conversation_messages WHERE provider_message_id = 'wamid.RAW1'`,
      ),
    );
    expect([...stored].map((r) => r.body)).toEqual([
      '[message withheld: it held a protected detail]',
    ]);
  });

  /* Final review on #273: a NEW name the model resolves becomes a short
   * token in the stored body, which puts the account number beside it in
   * reach of "send to": the stored history keeps it out. */
  it('stores no account number that the mention scrub brings within reach', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith({
      ...SALE_TO_CHIDI,
      customer: { kind: 'mention', mention: 'Adaeze Obiageli Okonkwo' },
    });

    await post(
      messagePayload(
        '2348031234567',
        'wamid.RAW2',
        'Adaeze Obiageli Okonkwo bought 3 wigs for 150k, send to Adaeze Obiageli Okonkwo 0123456789',
      ),
    );
    await drain();

    const stored = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ body: string }>(
        sql`SELECT body FROM conversation_messages WHERE provider_message_id = 'wamid.RAW2'`,
      ),
    );
    const body = [...stored][0]?.body ?? '';
    expect(body).not.toContain('Adaeze');
    expect(body).not.toContain('0123456789');
  });

  it('keeps them apart when the merchant says no', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload('2348031234567', 'wamid.SF2', `Chidi Okafor ${PHONE} bought 3 wigs for 150k`),
    );
    await drain();
    await post(messagePayload('2348031234567', 'wamid.SF2-no', 'no'));
    await drain();

    expect((await ledger(business.id)).customers).toBe(2);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('asks nothing when the name is already a known customer', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    await deps.gateway.resolveMention(business.id, 'Chidi Okafor');
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload('2348031234567', 'wamid.SF3', `Chidi Okafor ${PHONE} bought 3 wigs for 150k`),
    );
    await drain();

    expect(stubSender.lastText).not.toContain('same customer');
  });

  it('asks nothing when the phone customer already has a known name of their own', async () => {
    const business = await seedMerchant();
    /* A merchant-named customer with this phone: a second trusted name would
     * compete with the first, so no link is offered. */
    const { token } = await deps.gateway.resolveMention(business.id, 'Emeka Obi');
    const storefront = await deps.gateway.resolveStorefrontCustomer(business.id, '', PHONE);
    const customerId = storefront!.customerId;
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE customer_identities SET customer_id = (SELECT id FROM customers WHERE token = ${token})
         WHERE business_id = ${business.id}::uuid AND customer_id = ${customerId}::uuid`),
    );
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`DELETE FROM customers WHERE id = ${customerId}::uuid`),
    );
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload('2348031234567', 'wamid.SF4', `Chidi Okafor ${PHONE} bought 3 wigs for 150k`),
    );
    await drain();

    expect(stubSender.lastText).not.toContain('same customer');
  });

  it('asks nothing when the message names three customers', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Bisi Ade', '08035559999');
    stubTransport.replyWith(SALE_TO_CHIDI);

    await post(
      messagePayload(
        '2348031234567',
        'wamid.SF5',
        `Chidi Okafor ${PHONE} and 08035559999 bought 3 wigs for 150k`,
      ),
    );
    await drain();

    expect(stubSender.lastText).not.toContain('same customer');
  });

  it('asks nothing on a question to the books, and a later yes joins nothing', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'customer_balance',
      customer: { kind: 'mention', mention: 'Chidi Okafor' },
      period: null,
      periodText: null,
      format: null,
    });

    await post(
      messagePayload('2348031234567', 'wamid.SF6', `how much does Chidi Okafor ${PHONE} owe`),
    );
    await drain();
    expect(stubSender.lastText).not.toContain('same customer');

    await post(messagePayload('2348031234567', 'wamid.SF6-yes', 'yes'));
    await drain();
    expect((await ledger(business.id)).customers).toBe(2);
  });

  it('forgets the question when the preview carrying it was never delivered', async () => {
    const business = await seedMerchant();
    await deps.gateway.resolveStorefrontCustomer(business.id, 'Chidi Okafor', PHONE);
    stubTransport.replyWith(SALE_TO_CHIDI);
    stubSender.failWith();

    await post(
      messagePayload('2348031234567', 'wamid.SF7', `Chidi Okafor ${PHONE} bought 3 wigs for 150k`),
    );
    await drain();
    await post(messagePayload('2348031234567', 'wamid.SF7-yes', 'yes'));
    await drain();

    expect((await ledger(business.id)).customers).toBe(2);
  });
});
