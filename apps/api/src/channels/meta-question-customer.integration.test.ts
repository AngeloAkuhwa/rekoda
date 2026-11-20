/**
 * Webhook ingress, end to end: questions to the books that name a customer (G-135,
 * BA-OD-3, owner review of #437). A question never creates a customer, names an
 * unknown one as unknown, and never answers with the business's totals as if they
 * were one customer's. Split from meta-understanding.integration.test.ts by concern;
 * the shared app, stubs and payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, issueRepo, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
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

describe('a question that names a customer', () => {
  const askAbout = (over: Record<string, unknown>) => ({
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: 'month',
    periodText: null,
    format: 'chat',
    ...over,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  async function ask(wamid: string, command: Record<string, unknown>, text: string) {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /** One ₦150,000 invoice to `customerToken`, nothing paid. */
  async function seedTrading(businessId: string, customerToken = 'CUSTOMER_7K2') {
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken,
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
        sourceId: 'draft-q',
        actor: 'system',
      }),
    );
  }

  /** Every customer row and every vaulted facet: a read must leave both as they were. */
  const customerRows = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const [row] = [
        ...(await tx.execute<{ customers: number; facets: number }>(sql`
          SELECT (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid)
                   AS customers,
                 (SELECT count(*)::int FROM customer_identities WHERE business_id = ${businessId}::uuid)
                   AS facets`)),
      ];
      return row!;
    });

  /** The stored copy of one inbound message, as the conversation history keeps it. */
  const storedBody = async (businessId: string, wamid: string) => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ body: string }>(
        sql`SELECT body FROM conversation_messages WHERE provider_message_id = ${wamid}`,
      ),
    );
    return [...rows].map((r) => r.body).join(' ');
  };
  const lastModelText = () => stubTransport.requests.at(-1)?.userText ?? '';

  /**
   * The documented exception (ADR 0005 Amendment 1, PROPOSED, awaiting the owner):
   * a question vaults nothing, so a name nobody recorded reaches the model again
   * each time a question repeats it. Pinned so the exception is never wider than
   * written: nothing is created on any ask, and no stored copy keeps the name.
   */
  it('a repeated question about an unknown name creates nothing on any ask', async () => {
    const business = await seedMerchant('+2348031234567');
    const before = await customerRows(business.id);
    const question = askAbout({
      topic: 'customer_balance',
      customer: { kind: 'mention', mention: 'Bola Ige' },
    });

    await ask('wamid.Q5R1', question, 'how much does Bola Ige owe me');
    await ask('wamid.Q5R2', question, 'how much does Bola Ige owe me');

    expect(await customerRows(business.id)).toEqual(before);
    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(await storedBody(business.id, 'wamid.Q5R1')).not.toContain('Bola');
    expect(await storedBody(business.id, 'wamid.Q5R2')).not.toContain('Bola');
    /* The exception itself: the second ask carried the name to the model. */
    expect(lastModelText()).toContain('Bola Ige');
  });

  it('a known name never reaches the model: the question carries its token', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    const before = await customerRows(business.id);

    await ask(
      'wamid.Q5T',
      askAbout({ topic: 'customer_balance', customer: { kind: 'token', token } }),
      'how much does Bola Ige owe me',
    );

    expect(lastModelText()).toContain(token);
    expect(lastModelText()).not.toContain('Bola');
    expect(await customerRows(business.id)).toEqual(before);
  });

  it('a name another business holds is unknown here, and neither business gains a customer', async () => {
    const business = await seedMerchant('+2348031234567');
    const otherOwner = await identity.upsertUserByPhone(db, '+2348039990000');
    const other = await identity.createBusinessWithOwner(db, {
      name: 'Obi Stores',
      businessType: null,
      ownerUserId: otherOwner.id,
    });
    await deps.gateway.resolveMention(other.id, 'Bola Ige');
    const mine = await customerRows(business.id);
    const theirs = await customerRows(other.id);

    await ask(
      'wamid.Q5X',
      askAbout({ topic: 'customer_balance', customer: { kind: 'mention', mention: 'Bola Ige' } }),
      'how much does Bola Ige owe me',
    );

    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(await customerRows(business.id)).toEqual(mine);
    expect(await customerRows(other.id)).toEqual(theirs);
  });

  /**
   * Only a balance is kept per customer. A sales question naming somebody must not
   * be answered with the whole business's sales as if they were that person's
   * (owner review of #437), whether the name is known or not.
   */
  it('a sales question naming an unknown customer is not answered with the business totals', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);
    const before = await customerRows(business.id);

    await ask(
      'wamid.Q5S',
      askAbout({ topic: 'sales_summary', customer: { kind: 'mention', mention: 'Bola Ige' } }),
      'how much did Bola Ige buy this month',
    );

    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(stubSender.lastText).not.toContain('₦150,000');
    expect(await customerRows(business.id)).toEqual(before);
  });

  it('a sales question naming a known customer says those figures are not kept per customer', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await seedTrading(business.id, token);

    await ask(
      'wamid.Q5SK',
      askAbout({ topic: 'sales_summary', customer: { kind: 'token', token } }),
      'how much did Ada Obi buy this month',
    );
    expect(lastModelText()).toContain(token);

    expect(stubSender.lastText).toContain('do not keep sales, spending or other figures');
    expect(stubSender.lastText).not.toContain('₦150,000');
  });

  /**
   * A short follow-up must not resume the refused question into the business's totals
   * (independent review of #437): "last month" after "how much did Ada buy this month"
   * is read afresh by the model, never answered from the sales ledger as Ada's.
   */
  it.each([
    ['a known customer', true],
    ['an unknown name', false],
  ])('"last month" after a sales question naming %s resumes nothing', async (_, known) => {
    const business = await seedMerchant('+2348031234567');
    const customer = known
      ? { kind: 'token', token: (await deps.gateway.resolveMention(business.id, 'Ada Obi')).token }
      : { kind: 'mention', mention: 'Bola Ige' };
    await seedTrading(business.id, known ? (customer as { token: string }).token : 'CUSTOMER_7K2');
    /* An older open read, which the refusal must supersede. */
    await ask('wamid.Q5L0', askAbout({ topic: 'sales_summary' }), 'what did I sell this month');

    await ask(
      'wamid.Q5L1',
      askAbout({ topic: 'sales_summary', customer }),
      known ? 'how much did Ada Obi buy this month' : 'how much did Bola Ige buy this month',
    );
    if (known) expect(lastModelText()).not.toContain('Ada Obi');

    await ask(
      'wamid.Q5L2',
      { intent: 'Unclear', clarification: 'Which customer do you mean?' },
      'last month',
    );

    /* Read afresh: the model was asked about "last month" (`replyWith` clears the
     * request log, so any request here is this message's), and no sales figure came back. */
    expect(stubTransport.requests.map((r) => r.userText)).toContain('last month');
    expect(stubSender.lastText).toContain('Which customer do you mean?');
    expect(stubSender.lastText).not.toMatch(/sales|invoiced|₦/i);
  });

  it('a debtors question naming a known customer is answered as their balance', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await seedTrading(business.id, token);

    await ask(
      'wamid.Q5D',
      askAbout({ topic: 'debtors', customer: { kind: 'token', token } }),
      'who owes me, Ada Obi?',
    );

    expect(stubSender.lastText).toContain('₦150,000');
    expect(stubSender.lastText).toContain('INV-');
    expect(stubSender.lastText).not.toContain('Ada');
  });

  /**
   * The total is every open invoice's, from SQL, not the sum of the lines listed
   * (CodeRabbit on #437): the reply lists at most 20, and a customer with 21 open
   * invoices of ₦1,000 owes ₦21,000, never ₦20,000.
   */
  it('a balance over more open invoices than it lists still totals all of them', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    for (let n = 0; n < 21; n += 1) {
      await withBusiness(db, business.id, (tx) =>
        issueRepo.issueSale(tx, {
          businessId: business.id,
          customerId: null,
          customerToken: token,
          items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
          subtotalK: 100_000,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: 100_000,
          paidK: 0,
          balanceDueK: 100_000,
          method: 'transfer',
          sourceType: 'chat',
          sourceId: `draft-q${n}`,
          actor: 'system',
        }),
      );
    }

    await ask(
      'wamid.Q5M',
      askAbout({ topic: 'customer_balance', customer: { kind: 'token', token } }),
      'how much does Ada Obi owe me',
    );

    expect(stubSender.lastText).toContain('₦21,000 in total');
    expect(stubSender.lastText).toContain(
      '1 additional outstanding invoice, included in the total',
    );
    expect(stubSender.lastText).not.toContain('Ada');
  });

  /**
   * A token is opaque to the model and only ever issued for this message. One the
   * message never carried (the model invented it, or reused one from elsewhere)
   * names nobody here, so it is answered as unknown: never "nothing outstanding",
   * which is a confirmed zero about somebody this message never named.
   */
  it('a balance question with a token this message was never issued is answered as unknown', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    const before = await customerRows(business.id);

    await ask(
      'wamid.Q5F1',
      askAbout({ topic: 'customer_balance', customer: { kind: 'token', token: 'CUSTOMER_ZZ9' } }),
      'how much does Bola Ige owe me',
    );
    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(stubSender.lastText).not.toContain('nothing outstanding');

    /* A real customer's token the message did not carry is not theirs to answer either. */
    await ask(
      'wamid.Q5F2',
      askAbout({ topic: 'customer_balance', customer: { kind: 'token', token } }),
      'how much does Bola Ige owe me',
    );
    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(stubSender.lastText).not.toContain('nothing outstanding');
    expect(await customerRows(business.id)).toEqual(before);
  });

  /**
   * G-136 (owner directive on #437): this pinned "[name] Okafor" while the stored copy
   * was the text with the model's words taken out. The history now keeps a placeholder,
   * so no word of the typed name survives, whichever words the model returned.
   */
  it('keeps no word of the name, whichever words the model returned (G-136)', async () => {
    const business = await seedMerchant('+2348031234567');

    await ask(
      'wamid.Q5P',
      askAbout({ topic: 'customer_balance', customer: { kind: 'mention', mention: 'Chiamaka' } }),
      'how much does Chiamaka Okafor owe me',
    );

    const body = await storedBody(business.id, 'wamid.Q5P');
    expect(body).toBe(STORED_BODY.text);
    expect(body).not.toMatch(/Chiamaka|Okafor/);
  });
});
