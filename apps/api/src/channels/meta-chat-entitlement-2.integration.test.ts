/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: Chat entitlement on fixed commands (G-65) (part 2 of 3). Split by concern
 * from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { continuationsRepo, conversationsRepo, identity, withBusiness } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { truncateAll, setPlanForTest } from '@rekoda/db/testing';
import { customersRepo, issueRepo, paymentsHub } from '@rekoda/db';
import { encryptFacet, matchKeyFor } from '@rekoda/core/vault';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubStt,
  stubTransport,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  OWNER,
  REFUSED,
  FREE_FORM_REFUSED,
  YES_REFUSED,
  LAPSED,
  YES_LAPSED,
  A_SALE,
  HOW_MUCH_DID_I_SELL,
  seedMerchant,
  drain,
  expectNoFailedJob,
  footprint,
  expectOnlyReplies,
  draftStates,
  sendMark,
  beyondTheMerchant,
  mediaPayload,
  A_POS_PURCHASE,
  POS_QUESTION,
  continuationRows,
  expireDrafts,
} from './meta-chat-entitlement.fixtures.js';

useMetaWebhookHarness();

describe('Chat entitlement on fixed commands (G-65)', () => {
  // Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts,
  // meta-chat-entitlement-3.integration.test.ts. It writes the plan, which the G-62 guard
  // allows only in test files. Change them together.
  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await setPlanForTest(db, { businessId, plan, expiresAt: null, actor: 'operator:g65' });
  }

  // Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts,
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

  // Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts,
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
   * Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts. It calls a
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

  /**
   * A paid plan that lapsed: the renewal path stores it as `expired` itself.
   *
   * Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts. It writes the
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

  async function sendFrom(from: string, text: string) {
    await post(messagePayload(from, `wamid.G65-${++seq}`, text));
    await drain();
    await expectNoFailedJob();
    return stubSender.lastText ?? '';
  }

  it('a lapsed plan keeps a resumed read, as it keeps records', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await lapse(business.id);
    const requests = stubTransport.requests.length;
    const before = await footprint(business.id);

    const said = await send('last month');
    expect(said).not.toBe(LAPSED);
    expect(said).not.toBe(FREE_FORM_REFUSED);
    expect(said).toMatch(/sales/i);
    expect(stubTransport.requests).toHaveLength(requests);
    expect((await footprint(business.id)).ai_actions).toBe(before.ai_actions);
  });

  it('a view-only member on Integrate meets the plan before the role', async () => {
    const business = await seedMerchant();
    const invoiceNumber = await seedBooks(business.id);
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const mark = sendMark();

    expect(await sendFrom('2348039990001', `remind ${invoiceNumber}`)).toBe(REFUSED);
    expect(await sendFrom('2348039990001', 'payment details')).toBe(REFUSED);
    expect(beyondTheMerchant(mark)).toMatchObject({ documents: 0, customerTexts: 0, mints: 0 });
    await expectOnlyReplies(business.id, before, 2);

    // On a Chat plan the same member is refused by role, as before.
    await moveToPlan(business.id, 'chat');
    expect(await sendFrom('2348039990001', 'payment details')).toBe(replies.viewOnlyRole().text);
  });

  /**
   * Pinned: a yes after the plan lapsed, with a resumed read since the
   * preview, is refused before Build 6's read pointer runs. Nothing moves:
   * not the read, not the preview, not a meter.
   */
  it('a lapsed yes after a resumed read is refused and changes nothing', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await send('how much did I sell?', HOW_MUCH_DID_I_SELL);
    await send('last month');
    await lapse(business.id);
    const states = await draftStates(business.id);
    const before = await footprint(business.id);

    expect(await send('yes')).toBe(YES_LAPSED);

    expect(await draftStates(business.id)).toEqual(states);
    await expectOnlyReplies(business.id, before, 1);
  });

  it.each([
    ['trial', replies.trialEnded().text],
    ['paid', replies.planEnded().text],
  ] as const)(
    'a %s lapse hears the true sentence on the model path, voice and photo',
    async (kind, expected) => {
      const business = await seedMerchant();
      if (kind === 'trial') await lapse(business.id);
      else await lapsePaid(business.id);

      // The model path: refused before the model, as always; only the copy.
      expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toBe(expected);
      for (const media of ['audio', 'image'] as const) {
        await post(mediaPayload(media, `wamid.G65-${++seq}`));
        await drain();
        await expectNoFailedJob();
        expect(stubSender.lastText, media).toBe(expected);
      }
      expect(stubTransport.requests).toHaveLength(0);
      expect(stubStt.calls).toHaveLength(0);
      if (kind === 'paid') expect(stubSender.lastText).not.toContain('trial');
    },
  );

  it('START, a stray number and a yes with nothing waiting point at what works without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('START')).toBe(replies.optedInWithoutChat().text);
    expect(await send('7')).toBe(replies.strayNumberWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
    for (const said of [
      replies.optedInWithoutChat().text,
      replies.strayNumberWithoutChat().text,
      replies.nothingToConfirmWithoutChat().text,
    ]) {
      expect(said).not.toMatch(/sale|record/i);
    }

    await lapse(business.id);
    expect(await send('7')).toBe(replies.strayNumberWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
  });

  it('a Chat plan keeps the ordinary START, stray-number and nothing-to-confirm copy', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'chat');
    expect(await send('START')).toBe(replies.optedIn().text);
    expect(await send('7')).toBe(replies.strayNumber().text);
    expect(await send('yes')).toBe(replies.nothingToConfirm().text);
  });

  it('help names delete my data only to the owner, the one member it works for', async () => {
    const business = await seedMerchant();
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    await moveToPlan(business.id, 'integrate');

    const forMember = await sendFrom('2348039990001', 'help');
    expect(forMember).toBe(replies.helpWithoutChat(null, { owner: false, transacts: false }).text);
    expect(forMember).not.toContain('delete my data');
    expect(await send('help')).toContain('*delete my data*');
  });

  /**
   * Codex, PR #261: help named *payment details* to an accountant on a lapsed
   * plan, which then refused them by role. The rule, asserted generically:
   * every command `help` names is one THIS member can run, on THIS plan.
   */
  it.each([
    ['the owner', 'lapsed'],
    ['an accountant', 'lapsed'],
    ['the owner', 'integrate'],
    ['an accountant', 'integrate'],
  ] as const)('help names only what %s can run on a %s plan', async (who, standing) => {
    const business = await seedMerchant();
    await seedBooks(business.id);
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    if (standing === 'lapsed') await lapse(business.id);
    else await moveToPlan(business.id, 'integrate');
    const from = who === 'the owner' ? OWNER : '2348039990001';

    const help = await sendFrom(from, 'help');
    const named = [...help.matchAll(/\*([^*]+)\*/g)]
      .map((m) => m[1]!)
      // STOP works for everyone by law; sending it here would opt them out.
      .filter((command) => command !== 'STOP');
    expect(named.length).toBeGreaterThan(0);
    if (who === 'an accountant') {
      expect(named).not.toContain('payment details');
      expect(named).not.toContain('delete my data');
    }

    const REFUSALS = [
      replies.viewOnlyRole().text,
      replies.erasureNotYours().text,
      replies.chatCommandNotInPlan().text,
      replies.chatNotInPlan().text,
      replies.trialEnded().text,
      replies.planEnded().text,
    ];
    for (const command of named) {
      const said = await sendFrom(from, command);
      expect(REFUSALS, `${who} sent *${command}*`).not.toContain(said);
    }
    expect(stubTransport.requests).toHaveLength(0);
  });

  /**
   * Codex, PR #261 (second pass): the lapse sentence told an accountant that
   * *payment details* still works, which refuses them by role. Asserted on
   * both kinds of lapse, from a refused command and from the model path, by
   * sending every command the sentence names as that member.
   */
  it.each([
    ['trial', replies.trialEnded(false).text],
    ['paid', replies.planEnded(false).text],
  ] as const)(
    'a %s lapse names to a view-only member only what they can run',
    async (kind, expected) => {
      const business = await seedMerchant();
      await seedBooks(business.id);
      const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
      await identity.addMembership(db, business.id, accountant.id, 'accountant');
      if (kind === 'trial') await lapse(business.id);
      else await lapsePaid(business.id);
      const ACCOUNTANT = '2348039990001';

      // A view-only member sends no document on any plan (N3 keeps the role guard).
      expect(await sendFrom(ACCOUNTANT, 'resend')).toBe(replies.viewOnlyRole().text);
      stubTransport.replyWith(A_SALE);
      expect(await sendFrom(ACCOUNTANT, 'Ada bought 3 wigs for 300k')).toBe(expected);
      expect(expected).not.toContain('payment details');

      const named = [...expected.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]!);
      expect(named.length).toBeGreaterThan(0);
      for (const command of named) {
        const said = await sendFrom(ACCOUNTANT, command);
        expect(
          [
            replies.viewOnlyRole().text,
            replies.trialEnded(false).text,
            replies.planEnded(false).text,
          ],
          `the accountant sent *${command}*`,
        ).not.toContain(said);
      }
      // The owner still reads the sentence every owner always has.
      expect(await send('Ada bought 3 wigs for 300k', A_SALE)).toBe(
        kind === 'trial' ? replies.trialEnded().text : replies.planEnded().text,
      );
      expect(stubTransport.requests).toHaveLength(0);
    },
  );

  async function askFunding() {
    expect(
      await send('I bought 10 cartons for 180k from Emeka with POS', A_POS_PURCHASE),
    ).toContain(POS_QUESTION);
  }

  it('a questioned yes points a plan without Chat at no yes it would refuse', async () => {
    const business = await seedMerchant();
    // Nothing waiting: what works, not "tell me a sale".
    await moveToPlan(business.id, 'integrate');
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);

    // A preview waiting from before the switch: nothing was saved, never "reply yes".
    await moveToPlan(business.id, 'chat');
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    const states = await draftStates(business.id);
    expect(await send('yes?')).toBe(YES_REFUSED);
    expect(await send('na so?')).toBe(YES_REFUSED);
    await expectOnlyReplies(business.id, before, 2);
    expect(await draftStates(business.id)).toEqual(states);

    // On a lapsed plan, the lapse is named.
    await lapse(business.id);
    expect(await send('yes?')).toBe(YES_LAPSED);
  });

  it('a questioned yes still keeps the data between two erasure asks without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
    expect(await send('yes?')).toBe(replies.erasureKept().text);
    expect(await send('delete my data')).toBe(replies.confirmErasure().text);
  });

  it('a "bank" answer on a plan without Chat is refused before the question is claimed', async () => {
    const business = await seedMerchant();
    await askFunding();
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);

    // Build 7's sentence, unchanged; the question stays open, nothing is rebuilt.
    expect(await send('bank')).toBe(replies.chatNotInPlan().text);
    expect(await continuationRows(business.id)).toEqual(['funding_source:open']);
    await expectOnlyReplies(business.id, before, 1);

    // The same "bank" works the moment Chat is back.
    await moveToPlan(business.id, 'chat');
    expect(await send('bank')).toContain('Reply *yes*');
  });

  it('a "cash" answer after a PAID lapse is told the plan ended, never a free trial', async () => {
    const business = await seedMerchant();
    await askFunding();
    await lapsePaid(business.id);
    expect(await send('cash')).toBe(replies.planEnded().text);
    expect(await continuationRows(business.id)).toEqual(['funding_source:open']);
  });

  it('a yes to the funding question re-opens nothing on a plan without Chat', async () => {
    const business = await seedMerchant();
    await askFunding();
    await moveToPlan(business.id, 'integrate');
    const rows = await continuationRows(business.id);

    // Not "Reply bank or cash": a "bank" would be refused.
    const said = await send('yes');
    expect(said).toBe(YES_REFUSED);
    expect(said).not.toContain('*bank*');
    expect(await continuationRows(business.id)).toEqual(rows);
  });

  it('a "no" with nothing waiting invites no sale on a plan without Chat', async () => {
    const business = await seedMerchant();
    await moveToPlan(business.id, 'integrate');
    expect(await send('no')).toBe(replies.nothingToDeclineWithoutChat().text);
    expect(await send('cancel')).toBe(replies.nothingToCancel().text);
    await moveToPlan(business.id, 'chat');
    expect(await send('no')).toBe(replies.nothingToDecline().text);
  });

  it('a chosen option does not suggest *remind* to a plan without Chat', async () => {
    const business = await seedMerchant();
    const openList = async () => {
      const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
      await withBusiness(db, business.id, async (tx) => {
        const thread = await conversationsRepo.recordInbound(
          tx,
          {
            businessId: business.id,
            channel: 'meta',
            kind: 'text',
            body: '[list]',
            providerMessageId: `wamid.G65-list-${++seq}`,
          },
          { kind: 'MERCHANT', businessId: business.id, channel: 'meta' },
        );
        await continuationsRepo.openContinuation(tx, {
          businessId: business.id,
          userId: user.id,
          sourceMessageId: thread.id,
          state: {
            kind: 'clarification',
            expects: 'choice',
            topic: 'debtors',
            options: [
              { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
              { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000002' } },
            ],
          },
        });
      });
    };
    await moveToPlan(business.id, 'integrate');
    await openList();
    const said = await send('2');
    expect(said).toBe(replies.optionChosenWithoutChat('INV-2026-000002').text);
    expect(said).not.toContain('*remind');

    await moveToPlan(business.id, 'chat');
    await openList();
    expect(await send('2')).toBe(replies.optionChosen('INV-2026-000002').text);
  });

  it.each(['integrate', 'lapsed'] as const)(
    'an expired erasure ask is "Kept" to a yes and a yes? alike on a %s plan',
    async (standing) => {
      for (const word of ['yes', 'yes?']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);
        expect(await send('delete my data')).toBe(replies.confirmErasure().text);
        await expireDrafts(business.id);
        expect(await send(word), word).toBe(replies.erasureKept().text);
      }
    },
  );

  it.each([
    ['integrate', replies.draftExpiredWithoutChat(null).text],
    ['lapsed', replies.draftExpiredWithoutChat('trial').text],
  ] as const)(
    'an expired preview invites no resend to a yes or a yes? on a %s plan',
    async (standing, expected) => {
      for (const word of ['yes', 'yes?']) {
        await truncateAll(urls);
        const business = await seedMerchant();
        await send('Ada bought 3 wigs for 300k', A_SALE);
        if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
        else await lapse(business.id);
        await expireDrafts(business.id);
        const before = await footprint(business.id);
        const said = await send(word);
        expect(said, word).toBe(expected);
        expect(said).not.toMatch(/send it again/i);
        await expectOnlyReplies(business.id, before, 1);
      }
    },
  );

  it('an expired preview on a Chat plan keeps the ordinary sentence', async () => {
    const business = await seedMerchant();
    await send('Ada bought 3 wigs for 300k', A_SALE);
    await expireDrafts(business.id);
    expect(await send('yes')).toBe(replies.draftExpired().text);
  });

  it('an expired question that was never a preview is "nothing waiting" without Chat', async () => {
    const business = await seedMerchant();
    // The model asks a question: a draft, never a preview.
    expect(
      await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' }),
    ).toContain('How many wigs?');
    await moveToPlan(business.id, 'integrate');
    await expireDrafts(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
    expect(await send('yes')).toBe(replies.nothingToConfirmWithoutChat().text);
  });
});
