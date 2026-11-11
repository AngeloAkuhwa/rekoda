/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: the away assistant and a customer's own STOP. Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  identity,
  catalogueRepo,
  usageRepo,
  stockRepo,
  wabaRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { encryptFacet } from '@rekoda/core/vault';
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
import { setPlanForTest, requireUrls, settlementDb } from '@rekoda/db/testing';

useMetaWebhookHarness();

describe('the away assistant (spec Appendix D; W4, PR-090)', () => {
  const CUSTOMER_WA = '2349097778888';

  async function seedAssistantMerchant(
    phoneNumberId: string,
    opts: { enabled?: boolean; limit?: number } = {},
  ) {
    const user = await identity.upsertUserByPhone(db, '+2348030002240');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await setPlanForTest(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      await catalogueRepo.createProduct(tx, businessId, { name: 'wig', unitPriceK: 150_000 });
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 4,
        costK: 100_000,
        sourceType: 'chat',
      });
      /* Pack units are credited only by settlement (OD-37). */
      await withBusiness(settlementDb(), businessId, (s) =>
        usageRepo.creditBonus(s, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 5),
      );
      await wabaRepo.setAssistantSettings(tx, businessId, {
        enabled: opts.enabled ?? true,
        dailyReplyLimit: opts.limit ?? 3,
      });
    });
    return businessId;
  }

  const ask = (phoneNumberId: string, wamid: string, text: string) =>
    post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId));

  it('answers price and availability off the merchant’s own rows, inside the window', async () => {
    const businessId = await seedAssistantMerchant('PN-AWAY-1');

    expect((await ask('PN-AWAY-1', 'wamid.AWAY.1', 'How much is the wig?')).statusCode).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-AWAY-1',
      text: 'wig: ₦1,500. In stock.',
    });
    /* Metered like every customer send, and counted against the ceiling. */
    const used = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COALESCE(SUM(replies), 0) AS n FROM away_assistant_replies WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...used][0]!.n).toBe('1');
    /* Text only: the assistant transacted nothing (Appendix D, absolute). */
    const ledger = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM ledger_entries WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...ledger][0]!.n).toBe('0');
  });

  it('an assistant nobody enabled answers nobody', async () => {
    await seedAssistantMerchant('PN-AWAY-2', { enabled: false });

    await ask('PN-AWAY-2', 'wamid.AWAY.2', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(0);
  });

  it('past the ceiling the assistant hands off rather than going silent', async () => {
    await seedAssistantMerchant('PN-AWAY-3', { limit: 1 });

    await ask('PN-AWAY-3', 'wamid.AWAY.3A', 'wig price?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await ask('PN-AWAY-3', 'wamid.AWAY.3B', 'and the wig again?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The answer, then the handoff: beyond the merchant's own line a
     * human takes over, and the customer is TOLD so (PR-091). */
    expect(stubSender.connectionTexts).toHaveLength(2);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
    expect(stubSender.connectionTexts[1]!.text).toContain('reply to you personally');
  });

  it('hands off what the shelf cannot answer, and says it is doing so, once (PR-091)', async () => {
    await seedAssistantMerchant('PN-AWAY-4');

    await ask('PN-AWAY-4', 'wamid.AWAY.4A', 'when do you open tomorrow?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The customer hears a person will reply — no guess, no filler — on
     * the merchant's own number. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-AWAY-4',
      text: 'Thanks for your message. Someone from the shop will reply to you personally.',
    });
    /* And the merchant hears a customer is waiting, in their own thread,
     * with no customer identity riding the notice (F.3). */
    const notice = stubSender.sent.find((m) => m.text.includes('could not answer'));
    expect(notice?.to).toBe('+2348030002240');
    expect(notice?.text).toContain('waiting on your business WhatsApp');
    expect(notice?.text).not.toMatch(/234909/);

    /* A second unanswerable message the same day repeats NOTHING: the
     * promise was made, and a machine restating it is a machine stalling. */
    await ask('PN-AWAY-4', 'wamid.AWAY.4B', 'hello? are you there?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it('an assistant nobody enabled hands off nothing either', async () => {
    await seedAssistantMerchant('PN-AWAY-5', { enabled: false });

    await ask('PN-AWAY-5', 'wamid.AWAY.5', 'when do you open tomorrow?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The merchant handles their own WhatsApp; Rekoda adds no noise. */
    expect(stubSender.connectionTexts).toHaveLength(0);
    expect(stubSender.sent.find((m) => m.text.includes('could not answer'))).toBeUndefined();
  });
});

describe("a customer's own STOP (PR-135)", () => {
  /* The customer side of consent, kept deliberately apart from the merchant
   * side tested above. The same words, a different fact, a different table
   * and a different person: here it is somebody's CUSTOMER asking a shop to
   * stop, not a merchant asking Rekoda to stop. */
  const CUSTOMER_WA = '2349097771234';
  const OWNER = '+2348030002270';

  async function seedShop(phoneNumberId: string) {
    const user = await identity.upsertUserByPhone(db, OWNER);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    const businessId = business.id;
    await setPlanForTest(db, {
      businessId,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test',
    });
    await withBusiness(db, businessId, async (tx) => {
      await wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: encryptFacet(
          'EAAG-merchant-token',
          deps.config.connectionKey,
          `${businessId}:waba_token`,
        ),
        tokenTail: '4821',
      });
      await catalogueRepo.createProduct(tx, businessId, { name: 'wig', unitPriceK: 150_000 });
      const wig = (await stockRepo.productByName(tx, businessId, 'wig'))!;
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: wig,
        quantity: 4,
        costK: 100_000,
        sourceType: 'chat',
      });
      /* Pack units are credited only by settlement (OD-37). */
      await withBusiness(settlementDb(), businessId, (s) =>
        usageRepo.creditBonus(s, businessId, usagePeriod(new Date()), 'SERVICE_MESSAGE', 20),
      );
      /* The assistant ON, so "silent afterwards" means the suppression did
       * it and not the absence of anything to say. */
      await wabaRepo.setAssistantSettings(tx, businessId, { enabled: true, dailyReplyLimit: 10 });
    });
    return businessId;
  }

  const say = (phoneNumberId: string, wamid: string, text: string) =>
    post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId));

  const refusals = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string; opted_out_at: Date | null }>(sql`
        SELECT count(*)::text AS n, max(opted_out_at) AS opted_out_at
          FROM customer_message_optouts
         WHERE business_id = ${businessId}::uuid
      `),
    );

  it('STOP is acknowledged, recorded, and silences the shop afterwards', async () => {
    const businessId = await seedShop('PN-STOP-1');

    expect((await say('PN-STOP-1', 'wamid.STOP.C1', 'STOP')).statusCode).toBe(200);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* One acknowledgement, in the customer's own words: they are not a
     * Rekoda user and the sentence must not pretend they are. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]).toMatchObject({
      to: `+${CUSTOMER_WA}`,
      phoneNumberId: 'PN-STOP-1',
    });
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');

    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();

    /* And the shop is quiet. The assistant would have answered this one
     * happily a moment ago; now nothing leaves at all. */
    await say('PN-STOP-1', 'wamid.STOP.C2', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it.each([
    ['*STOP*', 'PN-STOP-DEC-1'],
    ['🛑STOP🛑', 'PN-STOP-DEC-2'],
  ])('a decorated %j from a customer silences the shop (G-24)', async (text, pnid) => {
    const businessId = await seedShop(pnid);
    await say(pnid, `wamid.STOP.DEC.${pnid}`, text);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
  });

  it.each([
    ['abeg stop', 'PN-STOP-G80-1'],
    ['no send me again', 'PN-STOP-G80-2'],
    ['make una stop', 'PN-STOP-G80-3'],
  ])('a natural %j from a customer silences the shop as STOP does (G-80)', async (text, pnid) => {
    const businessId = await seedShop(pnid);
    await say(pnid, `wamid.STOP.G80.${pnid}`, text);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).not.toBeNull();
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
    // No model reads a consent message, and none is metered.
    expect(stubTransport.requests).toHaveLength(0);
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);

    /* And the shop is quiet afterwards. */
    await say(pnid, `wamid.STOP.G80.${pnid}.after`, 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
    // The merchant's own consent is untouched.
    expect(await identity.optedOutAt(db, OWNER)).toBeNull();
  });

  it('a customer sentence that merely contains a natural form is still a question (G-80)', async () => {
    const businessId = await seedShop('PN-STOP-G80-4');
    await say(
      'PN-STOP-G80-4',
      'wamid.STOP.G80.C4',
      'abeg stop the wig order, I go buy am tomorrow',
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect([...(await refusals(businessId))][0]!.n).toBe('0');
  });

  it('does not opt the MERCHANT out of anything', async () => {
    const businessId = await seedShop('PN-STOP-2');

    await say('PN-STOP-2', 'wamid.STOP.C3', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The merchant's own consent flag is a different column about a
     * different person, and a customer must not be able to reach it. */
    expect(await identity.optedOutAt(db, OWNER)).toBeNull();
    expect([...(await refusals(businessId))][0]!.n).toBe('1');
  });

  it('a merchant telling REKODA to stop leaves their customers reachable', async () => {
    /* The mirror of the test above, and the reason the two facts are two
     * tables: a merchant who stops their own notifications has not asked
     * their shop to stop serving anybody. */
    const businessId = await seedShop('PN-STOP-3');

    await post(messagePayload(OWNER.slice(1), 'wamid.STOP.M1', 'stop'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(await identity.optedOutAt(db, OWNER)).not.toBeNull();
    expect([...(await refusals(businessId))][0]!.n).toBe('0');

    /* The customer still gets served. */
    await say('PN-STOP-3', 'wamid.STOP.C4', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
  });

  it('repeating STOP changes nothing and says nothing more', async () => {
    const businessId = await seedShop('PN-STOP-4');

    await say('PN-STOP-4', 'wamid.STOP.C5', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const first = [...(await refusals(businessId))][0]!.opted_out_at;

    await say('PN-STOP-4', 'wamid.STOP.C6', 'unsubscribe');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* The second acknowledgement is refused by the very rule the first one
     * created: somebody who asked to be left alone is left alone, and that
     * includes being left alone about having asked. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(new Date(row!.opted_out_at!).toISOString()).toBe(new Date(first!).toISOString());
  });

  it('START opens the shop back up, and is acknowledged', async () => {
    const businessId = await seedShop('PN-STOP-5');

    await say('PN-STOP-5', 'wamid.STOP.C7', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);

    await say('PN-STOP-5', 'wamid.STOP.C8', 'START');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Recorded BEFORE the acknowledgement, which is why the acknowledgement
     * can be sent at all: the opposite order would need a hole in the
     * suppression check. */
    expect(stubSender.connectionTexts).toHaveLength(2);
    expect(stubSender.connectionTexts[1]!.text).toContain('this shop');

    const [row] = [...(await refusals(businessId))];
    /* The row stays: that they once asked is itself worth keeping. */
    expect(row!.n).toBe('1');
    expect(row!.opted_out_at).toBeNull();

    await say('PN-STOP-5', 'wamid.STOP.C9', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(3);
    expect(stubSender.connectionTexts[2]!.text).toContain('wig');
  });

  it('a question that merely contains the word is still a question', async () => {
    await seedShop('PN-STOP-6');

    await say('PN-STOP-6', 'wamid.STOP.C10', 'do you stop selling wig soon?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Over-matching here would silence a shop's paying customer for good.
     * The handler asks the same tight recogniser the merchant path uses. */
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('wig');
  });

  /* ── a tap is a message too (remediation R11) ───────────────────────────
   * WhatsApp delivers a pressed button with no `text` at all, so before
   * this the opt-out gate never saw it and the tap fell through to the
   * assistant, which answered a person who had just asked to be left
   * alone. */
  const tapPayload = (phoneNumberId: string, wamid: string, message: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: wamid, from: CUSTOMER_WA, timestamp: '1700000000', ...message }],
            },
          },
        ],
      },
    ],
  });

  it('a tapped template button is heard as STOP', async () => {
    const businessId = await seedShop('PN-STOP-7');

    await post(
      tapPayload('PN-STOP-7', 'wamid.STOP.C11', {
        type: 'button',
        button: { payload: 'stop', text: 'Stop messages' },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('messages from this shop');
    expect([...(await refusals(businessId))][0]!.opted_out_at).not.toBeNull();

    /* And the shop is quiet, which is the whole point of hearing it. */
    await say('PN-STOP-7', 'wamid.STOP.C12', 'How much is the wig?');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.connectionTexts).toHaveLength(1);
  });

  it('an interactive reply is heard, and tapping it twice changes nothing', async () => {
    const businessId = await seedShop('PN-STOP-8');

    await post(
      tapPayload('PN-STOP-8', 'wamid.STOP.C13', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'UNSUBSCRIBE' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    const first = [...(await refusals(businessId))][0]!.opted_out_at;
    expect(first).not.toBeNull();

    await post(
      tapPayload('PN-STOP-8', 'wamid.STOP.C14', {
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'y', title: 'stop' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(1);
    const [row] = [...(await refusals(businessId))];
    expect(row!.n).toBe('1');
    expect(new Date(row!.opted_out_at!).toISOString()).toBe(new Date(first!).toISOString());
  });

  it('a tapped START opens the shop back up', async () => {
    const businessId = await seedShop('PN-STOP-9');

    await say('PN-STOP-9', 'wamid.STOP.C15', 'stop');
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    await post(
      tapPayload('PN-STOP-9', 'wamid.STOP.C16', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'start', title: 'Yes please' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.connectionTexts).toHaveLength(2);
    expect([...(await refusals(businessId))][0]!.opted_out_at).toBeNull();
  });

  it('an ordinary button is an ordinary message', async () => {
    const businessId = await seedShop('PN-STOP-10');

    await post(
      tapPayload('PN-STOP-10', 'wamid.STOP.C17', {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'see', title: 'See prices' } },
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Nobody is silenced by pressing a button that did not say so. Reading
     * the id as well as the title is what makes this worth asserting: a
     * looser matcher would have found 'see' or 'prices' interesting. */
    expect([...(await refusals(businessId))][0]!.n).toBe('0');
  });
});
