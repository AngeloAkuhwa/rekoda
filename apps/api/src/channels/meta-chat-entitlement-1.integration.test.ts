/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: Chat entitlement on fixed commands (G-65) (part 1 of 3). Split by concern
 * from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, identity, jobsRepo, withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { truncateAll, setPlanForTest } from '@rekoda/db/testing';
import { buildRunner } from '../jobs/jobs.module.js';
import { billingRepo, customersRepo, issueRepo, paymentsHub } from '@rekoda/db';
import { encryptFacet, matchKeyFor } from '@rekoda/core/vault';
import {
  db,
  deps,
  invoiceCount,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  OWNER,
  REFUSED,
  FREE_FORM_REFUSED,
  YES_REFUSED,
  LAPSED,
  YES_LAPSED,
  A_SALE,
  AN_EXPENSE,
  DEBTORS_QUESTION,
  HOW_MUCH_DID_I_SELL,
  seedMerchant,
  drain,
  expectNoFailedJob,
  footprint,
  expectOnlyReplies,
  draftStates,
  sendMark,
  beyondTheMerchant,
  NOTHING_BEYOND,
  CHAT_COMMANDS,
} from './meta-chat-entitlement.fixtures.js';

useMetaWebhookHarness();

describe('Chat entitlement on fixed commands (G-65)', () => {
  // Kept identical to the copy in meta-chat-entitlement-2.integration.test.ts,
  // meta-chat-entitlement-3.integration.test.ts. It writes the plan, which the G-62 guard
  // allows only in test files. Change them together.
  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await setPlanForTest(db, { businessId, plan, expiresAt: null, actor: 'operator:g65' });
  }

  // Kept identical to the copy in meta-chat-entitlement-2.integration.test.ts,
  // meta-chat-entitlement-3.integration.test.ts. It writes the plan, which the G-62 guard
  // allows only in test files. Change them together.
  async function lapse(businessId: string) {
    await setPlanForTest(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:g65',
    });
  }

  let seq = 0;

  // Kept identical to the copy in meta-chat-entitlement-2.integration.test.ts,
  // meta-chat-entitlement-3.integration.test.ts. It advances this suite's own counter, so it
  // stays beside that counter. Change them together.
  async function send(text: string, command?: Record<string, unknown>) {
    if (command) stubTransport.replyWith(command);
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, text));
    await drain();
    await expectNoFailedJob();
    return stubSender.lastText ?? '';
  }

  /**
   * Everything a Chat command could have to show for itself: an open
   * ₦80,000 invoice whose customer has an email (so payment details can
   * mint), an active payment connection, and a stored document to resend.
   *
   * Kept identical to the copy in meta-chat-entitlement-2.integration.test.ts. It calls a
   * repository financial writer, which scripts/check-boundaries.mjs allows only in the command
   * layer and in test files, so it cannot move to a fixtures module. Change them together.
   */
  async function seedBooks(businessId: string): Promise<string> {
    const config = deps.config;
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey, `${businessId}:phone`),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
      {
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey, `${businessId}:email`),
        matchKey: null,
      },
    ]);
    return withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_g65',
      });
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'g65-seed',
        actor: 'system',
      });
      await issueRepo.recordDocument(tx, {
        businessId,
        kind: 'invoice_pdf',
        storageKey: 'test/g65-unguessable',
        refNumber: sale.invoiceNumber,
        bytes: 1234,
      });
      return sale.invoiceNumber;
    });
  }

  it.each(CHAT_COMMANDS)(
    'refuses "%s" to an Integrate-only plan, with no side effect at all',
    async (phrase) => {
      const business = await seedMerchant();
      const invoiceNumber = await seedBooks(business.id);
      await moveToPlan(business.id, 'integrate');
      const before = await footprint(business.id);
      const mark = sendMark();

      const said = await send(phrase.replace('{INV}', invoiceNumber));

      expect(said).toBe(REFUSED);
      // One message, the refusal, to the merchant who asked. Nothing else.
      expect(stubSender.sent.length - mark.sent).toBe(1);
      expect(beyondTheMerchant(mark)).toEqual(NOTHING_BEYOND);
      expect(stubTransport.requests).toHaveLength(0);
      await expectOnlyReplies(business.id, before, 1);
    },
  );

  it.each(['chat', 'complete'] as const)('runs every Chat command on the %s plan', async (plan) => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    await moveToPlan(business.id, plan);

    expect(await send('who owes me')).toContain('₦80,000');
    expect(await send('who dey owe me')).toContain('₦80,000');
    expect(await send('records')).toContain('Your books this month');
    expect(await send('wetin remain')).toContain('not counting any stock');
    expect(await send('payment details')).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
    expect(await send(`remind ${invoiceNumber}`)).toContain(`reminder for ${invoiceNumber}`);
    expect(await send('resend')).toContain(`Sending ${invoiceNumber} again`);
    // Free, as before: none of them reached the model.
    expect(stubTransport.requests).toHaveLength(0);
    expect((await footprint(business.id)).ai_actions).toBe('0');
  });

  it('meets the free-form question and its fixed phrase at the same boundary', async () => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);

    // The model path refuses before the model, as it always did...
    expect(await send('which of my customers still owe me money?', DEBTORS_QUESTION)).toBe(
      FREE_FORM_REFUSED,
    );
    // ...and the fixed phrase no longer walks round it.
    expect(await send('who owes me')).toBe(REFUSED);
    expect(stubTransport.requests).toHaveLength(0);
    await expectOnlyReplies(business.id, before, 2);

    // With Chat, both are answered, with the same debtor.
    await moveToPlan(business.id, 'chat');
    const freeForm = await send('which of my customers still owe me money?', DEBTORS_QUESTION);
    expect(freeForm).toContain('₦80,000');
    expect(freeForm).toMatch(/INV-\d{4}-000001/);
    const fixed = await send('who owes me');
    expect(fixed).toContain('₦80,000');
    expect(fixed).toMatch(/INV-\d{4}-000001/);
  });

  it('keeps consent, erasure, the dashboard, help and upgrade open without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    expect(await send('STOP')).toBe(replies.optedOut().text);
    expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await identity.optedOutAt(db, `+${OWNER}`)).toBeNull();

    expect(await send('dashboard')).toContain('Here are your books');
    expect(await send('help')).toBe(
      replies.helpWithoutChat(null, { owner: true, transacts: true }).text,
    );

    expect(await send('upgrade')).toBe(replies.upgradeRequested().text);
    const requests = await withBusiness(db, business.id, (tx) =>
      billingRepo.upgradeRequestsFor(tx, business.id),
    );
    expect(requests).toHaveLength(1);

    // The two-ask erasure ceremony runs to the end on a plan without Chat.
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('delete my data')).toContain('Done. Your customers');
    expect(stubTransport.requests).toHaveLength(0);
  });

  it.each(['integrate', 'lapsed'] as const)(
    'a natural opt-out is as universal as STOP when the plan is %s (G-80)',
    async (standing) => {
      const business = await seedMerchant();
      if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
      else await lapse(business.id);

      expect(await send('abeg stop')).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
      expect(await send('START')).toBe(replies.optedInWithoutChat().text);
      expect(await send('no send me again')).toBe(replies.optedOut().text);
      expect(await identity.optedOutAt(db, `+${OWNER}`)).not.toBeNull();
      expect(stubTransport.requests).toHaveLength(0);
    },
  );

  it('keeps consent and erasure open on a lapsed plan too', async () => {
    const business = await seedMerchant();
    await lapse(business.id);

    expect(await send('STOP')).toBe(replies.optedOut().text);
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await send('dashboard')).toContain('Here are your books');
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('delete my data')).toContain('Done. Your customers');
  });

  it('a yes between the two erasure asks still keeps the data without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    // Not refused for want of Chat: a yes is "anything else", and it keeps.
    expect(await send('yes')).toBe(replies.erasureKept().text);
    // The pair is broken, so this is a fresh first ask, not the confirmation.
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
  });

  it('a yes cannot confirm a Chat draft once the plan has no Chat', async () => {
    const business = await seedMerchant();
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const requests = stubTransport.requests.length;
    const mark = sendMark();

    expect(await send('yes')).toBe(YES_REFUSED);

    await expectOnlyReplies(business.id, before, 1);
    expect(beyondTheMerchant(mark)).toEqual(NOTHING_BEYOND);
    expect(stubTransport.requests).toHaveLength(requests);
    // Left pending, not claimed: the same yes works after an upgrade.
    expect(await draftStates(business.id)).toEqual(['pending']);
    await moveToPlan(business.id, 'chat');
    expect(await send('yes')).toContain('INV-');
    expect(await invoiceCount(business.id)).toBe(1);
  });

  it('a refused yes past a read changes nothing, not even the read', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await send('how much did I sell this month?', { ...HOW_MUCH_DID_I_SELL, period: 'month' });
    await moveToPlan(business.id, 'integrate');
    const states = await draftStates(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_REFUSED);

    // Build 6 would retire the read's draft to point back at the preview;
    // refused first, nothing moves.
    expect(await draftStates(business.id)).toEqual(states);
    await expectOnlyReplies(business.id, before, 1);
  });

  it('a no still cancels a Chat draft on a plan without Chat', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await moveToPlan(business.id, 'integrate');
    expect(await send('yes')).toBe(YES_REFUSED);

    expect(await send('no')).toBe(replies.cancelled().text);
    expect(await draftStates(business.id)).toEqual(['superseded']);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('a yes after the plan lapsed records no expense either', async () => {
    const business = await seedMerchant();
    expect(await send('fuel for generator 20k', AN_EXPENSE)).toContain('Reply *yes*');
    await lapse(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_LAPSED);

    await expectOnlyReplies(business.id, before, 1);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  it('a lapsed plan keeps the reads it is promised, and still resends a stored document', async () => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    await lapse(business.id);

    // What `trialEnded` promises still works.
    expect(LAPSED).toContain('*who owes me*, *records*, *payment details*');
    expect(await send('who owes me')).toContain('₦80,000');
    expect(await send('records')).toContain('Your books this month');
    expect(await send('payment details')).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
    expect(await send(`remind ${invoiceNumber}`)).toContain(`reminder for ${invoiceNumber}`);
    expect(await send('stock')).toContain('not counting any stock');

    // A resend retrieves a document that already exists, so a lapsed owner may
    // ask for it (N3): the invoice just seeded, not the lapse sentence.
    expect(await send('resend')).toContain(`Sending ${invoiceNumber} again`);
  });

  it('N3: a resend of a retained document works on an Integrate-only and on a lapsed plan, and creates no record', async () => {
    for (const standing of ['integrate', 'lapsed'] as const) {
      await truncateAll(urls);
      const business = await seedMerchant();
      await withBusiness(db, business.id, (tx) =>
        issueRepo.recordDocument(tx, {
          businessId: business.id,
          kind: 'invoice_pdf',
          storageKey: `test/n3-${standing}`,
          refNumber: 'INV-2026-000042',
          bytes: 1234,
        }),
      );
      if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
      else await lapse(business.id);
      const before = await footprint(business.id);

      expect(await send('resend'), standing).toContain('Sending INV-2026-000042 again');

      const queued = await withBusiness(db, business.id, (tx) =>
        jobsRepo.jobsForBusiness(tx, 'document.deliver'),
      );
      expect(queued, standing).toHaveLength(1);
      // Exactly one reply and one queued delivery; no sale, payment, receipt,
      // expense, order or ledger row.
      expect(await footprint(business.id), standing).toEqual({
        ...before,
        deliveries: String(Number(before['deliveries']) + 1),
        service_messages: String(Number(before['service_messages']) + 1),
      });
      expect(stubTransport.requests).toHaveLength(0);
    }
  });

  it('a short reply does not resume a read for a plan without Chat', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await moveToPlan(business.id, 'integrate');
    const requests = stubTransport.requests.length;
    const before = await footprint(business.id);

    // Not answered from the open question: the ordinary path, refused there.
    expect(await send('last month')).toBe(FREE_FORM_REFUSED);
    expect(stubTransport.requests).toHaveLength(requests);
    await expectOnlyReplies(business.id, before, 1);
  });

  /**
   * A paid plan that lapsed: the renewal path stores it as `expired` itself.
   *
   * Kept identical to the copy in meta-chat-entitlement-2.integration.test.ts. It writes the
   * plan, which the G-62 guard allows only in test files. Change them together.
   */
  async function lapsePaid(businessId: string) {
    await setPlanForTest(db, {
      businessId,
      plan: 'expired',
      expiresAt: null,
      actor: 'operator:g65',
    });
  }

  it('a lapsed paid plan is told its plan ended, never that a free trial did', async () => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    await lapsePaid(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(replies.notSavedPlanEnded('plan').text);
    expect(await send('Ada bought 4 wigs for 400k', A_SALE)).toBe(replies.planEnded().text);
    expect(stubSender.lastText).not.toContain('trial');
    await expectOnlyReplies(business.id, before, 2);
    // The reads the lapse keeps are kept here too.
    expect(await send('who owes me')).toContain('₦80,000');
  });

  it('a refused yes says first that nothing was saved, on each kind of refusal', async () => {
    for (const refused of [
      replies.notSavedNotInPlan(),
      replies.notSavedPlanEnded('trial'),
      replies.notSavedPlanEnded('plan'),
    ]) {
      expect(refused.text.startsWith('I did not save that.')).toBe(true);
    }
  });

  it('help, greeting and a failed dashboard link point only at what works on Integrate', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');

    const help = await send('help');
    expect(help).toBe(replies.helpWithoutChat(null, { owner: true, transacts: true }).text);
    expect(await send('hi')).toBe(replies.greetingWithoutChat(null).text);
    for (const refused of ['*records*', '*stock*', '*who owes me*', '*resend*', 'remind']) {
      expect(help).not.toContain(refused);
    }
    for (const works of ['*dashboard*', '*upgrade*', '*delete my data*', '*STOP*']) {
      expect(help).toContain(works);
    }

    // No web address configured: the link cannot be made.
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'dashboard'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    while (await runner.runOnce());
    expect(stubSender.lastText).toBe(replies.dashboardUnavailableWithoutChat().text);
    expect(stubSender.lastText).not.toContain('*records*');
  });

  it('a Chat plan keeps the ordinary help, greeting and dashboard sentence, byte for byte', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'chat');
    expect(await send('help')).toBe(replies.help().text);
    expect(await send('hi')).toBe(replies.greeting().text);

    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'dashboard'));
    const runner = buildRunner(workerDb, db, { ...deps, config: { ...deps.config, webUrl: null } });
    while (await runner.runOnce());
    expect(stubSender.lastText).toBe(replies.dashboardUnavailable().text);
  });

  it('a lapsed plan is told what still works, naming its kind of lapse', async () => {
    const business = await seedMerchant();
    await lapse(business.id);
    expect(await send('help')).toBe(
      replies.helpWithoutChat('trial', { owner: true, transacts: true }).text,
    );
    expect(await send('help')).toContain('*upgrade* and we will set you up to keep recording');
    expect(await send('hi')).toBe(replies.greetingWithoutChat('trial').text);
    await lapsePaid(business.id);
    expect(await send('help')).toBe(
      replies.helpWithoutChat('plan', { owner: true, transacts: true }).text,
    );
  });

  it('a retried yes that is refused gives back what its first attempt reserved', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);

    /* Attempt 1 meters the document unit (its own committed transaction),
     * then fails issuing: the job rolls back and the unit stays spent. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g65_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g65_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g65_once') = 1 THEN RAISE EXCEPTION 'g65: first attempt fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g65_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION g65_fail_once()`);

      await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'yes'));
      await buildRunner(workerDb, db, deps).runOnce();
      expect((await footprint(business.id)).document_credits).toBe('1');
      expect(await invoiceCount(business.id)).toBe(0);

      /* The plan loses Chat before the retry runs. */
      await moveToPlan(business.id, 'integrate');
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${business.id}::uuid
           AND state <> 'done'`);
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g65_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g65_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g65_once`);
      await close();
    }

    expect(stubSender.lastText).toBe(YES_REFUSED);
    expect((await footprint(business.id)).document_credits).toBe('0');
    expect(await invoiceCount(business.id)).toBe(0);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  it.each(['integrate', 'lapsed'] as const)(
    'cancel and no still drop a Chat draft on a %s plan',
    async (standing) => {
      for (const word of ['cancel', 'no']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        await send('Ada bought 3 wigs for 300k', A_SALE);
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);

        expect(await send(word)).toBe(replies.cancelled().text);
        expect(await draftStates(business.id)).toEqual(['superseded']);
        expect(await invoiceCount(business.id)).toBe(0);
      }
    },
  );

  it('a yes on the Complete plan confirms as on Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'complete');
    expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toContain('Reply *yes*');
    expect(await send('yes')).toContain('INV-');
    expect(await invoiceCount(business.id)).toBe(1);
  });
});
