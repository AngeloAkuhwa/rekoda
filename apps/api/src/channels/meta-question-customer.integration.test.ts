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

  /** One ₦150,000 invoice to CUSTOMER_7K2, nothing paid. */
  async function seedTrading(businessId: string) {
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
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

    await ask(
      'wamid.Q5T',
      askAbout({ topic: 'customer_balance', customer: { kind: 'token', token } }),
      'how much does Bola Ige owe me',
    );

    expect(lastModelText()).toContain(token);
    expect(lastModelText()).not.toContain('Bola');
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
    await seedTrading(business.id);

    await ask(
      'wamid.Q5SK',
      askAbout({ topic: 'sales_summary', customer: { kind: 'token', token: 'CUSTOMER_7K2' } }),
      'how much did Ada buy this month',
    );

    expect(stubSender.lastText).toContain('do not keep sales, spending or other figures');
    expect(stubSender.lastText).not.toContain('₦150,000');
  });

  /**
   * G-136 (known limitation, predates #437, shared with the write path): the scrub
   * removes the words the model returned and no more. Pinned as it is today so a fix
   * flips this test; it is not the wanted behaviour.
   */
  it('scrubs only the words of the name the model returned (G-136)', async () => {
    const business = await seedMerchant('+2348031234567');

    await ask(
      'wamid.Q5P',
      askAbout({ topic: 'customer_balance', customer: { kind: 'mention', mention: 'Chiamaka' } }),
      'how much does Chiamaka Okafor owe me',
    );

    const body = await storedBody(business.id, 'wamid.Q5P');
    expect(body).not.toContain('Chiamaka');
    expect(body).toContain('[name] Okafor');
  });
});
