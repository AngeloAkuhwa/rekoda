/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: what the model understood and how Rekoda answers. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, events, identity, jobsRepo, quotaRepo, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, settleRepo, spendRepo } from '@rekoda/db';
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

describe('what the model understood', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('stores a draft for a message only the model could read', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DRAFT', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ intent: 'Unclear', state: 'pending' });
    // The command holds tokens, because tokens are all the model ever saw.
    expect(JSON.stringify(drafts[0]!.command)).not.toContain('08039998888');
  });

  it('does NOT call a model for a message the router already answered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.CHEAP', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // No request, no draft, no usage row, no naira spent.
    expect(stubTransport.requests).toHaveLength(0);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(0);
    // Scoped to anthropic: the outbound reply writes its own usage row, and
    // "no AI spend" is a different claim from "no cost at all".
    const spend = await withBusiness(db, business.id, (tx) =>
      quotaRepo.usageTotals(tx, 'anthropic'),
    );
    expect(spend.calls).toBe(0);
  });

  it('does not pay twice for one sentence when the job runs again', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'Ada bought 3 wigs'));

    // Captured before the run, because running it marks the event handled.
    const [event] = await events.unprocessedEvents(workerDb, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    /* TWO calls for one sentence is the escalation working, not a double
     * charge: the suite's default reply is Unclear, which buys one bounded
     * retry on the escalation model. The claim under test is that a RERUN
     * adds nothing to either. */
    expect(stubTransport.requests).toHaveLength(2);

    /**
     * Exactly what a reclaimed lock produces: the same event, queued again.
     * `recordInbound` reports `isNew: false` the second time, which is what
     * stops the model being paid for a sentence it has already read.
     */
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    expect(stubTransport.requests).toHaveLength(2);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
  });
});

describe('answering the merchant', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('answers a greeting without a model, a vault write, or a naira', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.HI', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.sent).toHaveLength(1);
    expect(stubSender.lastText).toMatch(/I keep your books/i);
    expect(stubTransport.requests).toHaveLength(0);

    // The reply is on record too, so an undelivered one is findable.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('tells a merchant plainly when there is nothing to say yes to', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Before the gates landed this was silence, because "yes" answers a
     * question and there was none to answer. Now that a draft can exist, a
     * "yes" with none pending is a real state worth naming — and the reply
     * says what WOULD produce something to confirm.
     */
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes/i);
    expect(stubSender.lastText).toMatch(/tell me a sale/i);
  });

  it('answers the debtor question from rows, never an invented figure', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWES', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // A book with no invoices has exactly one honest answer, and it carries
    // no figure at all. A bookkeeping assistant that makes up a debtor list
    // has destroyed the only thing it sells.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('passes the model`s clarifying question through as written', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ASK', 'Ada bought wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toBe('How many wigs?');
  });

  it('answers once when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.TWICE', 'good morning'));

    const [event] = await events.unprocessedEvents(workerDb, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);

    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    // One reply per retry is how a bug becomes a nuisance the merchant feels.
    expect(stubSender.sent).toHaveLength(1);
  });

  it('keeps the record when the reply cannot be delivered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DOWN', 'good morning'));
    stubSender.failWith();

    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Failing the job over an undelivered reply would roll the merchant's
     * message back and re-read it from scratch on the retry — paying for the
     * model twice to fix a delivery problem.
     */
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages).toHaveLength(2);
    // No provider id: a reply we owed and did not deliver, and findable as one.
    expect(messages[1]).toMatchObject({ direction: 'outbound', providerMessageId: null });
  });
});

/**
 * Asking the books a question (M3 conversational reporting).
 *
 * `Query` has been in the command contract since M0 with nothing handling
 * it, so the model could emit one and the merchant got "Recording that kind
 * of entry is not built yet" — the wrong sentence for a question, about a
 * thing they were not recording.
 *
 * A question is a READ, so it answers immediately: no draft, no preview, no
 * yes. And the model computes nothing — it decides which question was asked,
 * and every figure comes from SQL over a window core resolved.
 */
describe('asking the books a question', () => {
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

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  async function ask(wamid: string, command: Record<string, unknown>, text = 'how am I doing') {
    stubTransport.replyWith(command);
    await post(messagePayload('2348031234567', wamid, text));
    await drain();
  }

  /** One ₦150,000 invoice with ₦60,000 paid, and ₦12,000 of fuel. */
  async function seedTrading(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
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
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'pay-q',
        actor: 'system',
      });
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-q2',
      });
    });
  }

  it('answers a sales question from the ledger, with no yes to give', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q1', askAbout({ topic: 'sales_summary' }), 'what did I sell this month');

    expect(stubSender.lastText).toContain('₦150,000');
    expect(stubSender.lastText).toContain('₦60,000');
    /* A question is a read. Asking "shall I tell you?" would be absurd. */
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('answers a spending question', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q2', askAbout({ topic: 'expenses_summary' }), 'how much did I spend');

    expect(stubSender.lastText).toContain('₦12,000');
    expect(stubSender.lastText).toContain('one entry');
  });

  it('names the window it counted, so a merchant can see what was asked', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q3', askAbout({ topic: 'sales_summary', period: 'today' }), 'sales today');

    expect(stubSender.lastText).toContain('oday');
  });

  it('says plainly when there is nothing in the window', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q4', askAbout({ topic: 'sales_summary' }), 'what did I sell');

    expect(stubSender.lastText).toContain('not recorded any sales');
  });

  /**
   * A balance is reported by INVOICE, never by name. This text crosses
   * WhatsApp in the clear, and the merchant already knows who they asked
   * about; anybody reading over their shoulder does not.
   */
  it('answers a customer balance by invoice number, never by name', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask(
      'wamid.Q5',
      askAbout({
        topic: 'customer_balance',
        customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      }),
      'how much does Ada owe me',
    );

    expect(stubSender.lastText).toContain('₦90,000');
    expect(stubSender.lastText).toContain('INV-');
    expect(stubSender.lastText).not.toContain('CUSTOMER_');
    expect(stubSender.lastText).not.toContain('Ada');
  });

  it('answers the debtors question the same way the free command does', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q6', askAbout({ topic: 'debtors' }), 'who has not paid me');

    expect(stubSender.lastText).toContain('₦90,000');
    expect(stubSender.lastText).toContain('INV-');
  });

  it('answers a supplier question, and an exceptions question', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);

    await ask('wamid.Q7', askAbout({ topic: 'supplier_balances' }), 'who do I owe');
    expect(stubSender.lastText).toContain('do not owe any supplier');

    await ask('wamid.Q8', askAbout({ topic: 'unreconciled' }), 'anything strange');
    expect(stubSender.lastText).toContain('Nothing needs your attention');
  });

  /* Points at the dashboard rather than promising a file: the statement PDF
   * is not built, and a bookkeeper that says "sending it now" and sends
   * nothing is worse than one that says where to look. */
  it('points at the dashboard for a document, rather than promising one', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q9', askAbout({ topic: 'report_request' }), 'send me my accounts');

    expect(stubSender.lastText).toContain('dashboard');
    expect(stubSender.lastText).not.toContain('sending');
  });

  it('names the PDF now that it exists, without promising to send it here', async () => {
    await seedMerchant('+2348031234567');

    await ask('wamid.Q9B', askAbout({ topic: 'report_request' }), 'send me my accounts');

    expect(stubSender.lastText).toContain('PDF');
    expect(stubSender.lastText).not.toContain('attached');
  });

  it('never writes anything: a question leaves the books untouched', async () => {
    const business = await seedMerchant('+2348031234567');
    await seedTrading(business.id);
    const before = await invoiceCount(business.id);

    await ask('wamid.QA', askAbout({ topic: 'sales_summary' }), 'what did I sell');

    expect(await invoiceCount(business.id)).toBe(before);
  });
});

/**
 * The one thing Rekoda says that links anywhere.
 *
 * Until this existed a merchant who wanted their statements had to leave the
 * thread, recall an address, type their number and wait for a code that
 * arrived back in the thread they had just left.
 */
describe('asking for the dashboard in chat', () => {
  async function seedMerchant(phone: string, name = 'Ada Fashion') {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  it('sends a tappable link, not an address to remember', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH1', 'dashboard'));
    await drain();

    const sent = stubSender.sent.map((m) => m.text);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('https://books.example.test/enter?t=');
    // The merchant is told what they are holding: it dies, and it dies fast.
    expect(sent[0]).toContain('works once');
    expect(sent[0]).toContain('15 minutes');
  });

  it('mints a fresh link each time, never reuses one', async () => {
    await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH2', 'my books'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.DASH3', 'open my books'));
    await drain();

    const links = stubSender.sent.map((m) => /\/enter\?t=([^\s]+)/.exec(m.text)?.[1]);
    expect(links).toHaveLength(2);
    expect(links[0]).toBeTruthy();
    /* A reused link would be a credential with two lives, and the second tap
     * would find the first had already burned it. */
    expect(links[0]).not.toBe(links[1]);
  });

  /**
   * Free, like `stock` and `records`. A merchant reaching for their own books
   * should not be paying for a model call to be handed a URL.
   */
  it('costs no model call, because it is a deterministic command', async () => {
    const business = await seedMerchant('+2348031234567');

    await post(messagePayload('2348031234567', 'wamid.DASH4', 'sign in'));
    await drain();

    const spend = await withBusiness(db, business.id, (tx) =>
      quotaRepo.usageTotals(tx, 'anthropic'),
    );
    expect(spend.calls).toBe(0);
  });
});
