/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: Chat entitlement on fixed commands (G-65) (part 3 of 3). Split by concern
 * from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { truncateAll, setPlanForTest } from '@rekoda/db/testing';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
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
  FREE_FORM_REFUSED,
  YES_REFUSED,
  A_SALE,
  AN_EXPENSE,
  HOW_MUCH_DID_I_SELL,
  seedMerchant,
  drain,
  expectNoFailedJob,
  footprint,
  expectOnlyReplies,
  draftStates,
} from './meta-chat-entitlement.fixtures.js';

useMetaWebhookHarness();

describe('Chat entitlement on fixed commands (G-65)', () => {
  // Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts,
  // meta-chat-entitlement-2.integration.test.ts. It writes the plan, which the G-62 guard
  // allows only in test files. Change them together.
  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await setPlanForTest(db, { businessId, plan, expiresAt: null, actor: 'operator:g65' });
  }

  // Kept identical to the copy in meta-chat-entitlement-1.integration.test.ts,
  // meta-chat-entitlement-2.integration.test.ts. It writes the plan, which the G-62 guard
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
  // meta-chat-entitlement-2.integration.test.ts. It advances this suite's own counter, so it
  // stays beside that counter. Change them together.
  async function send(text: string, command?: Record<string, unknown>) {
    if (command) stubTransport.replyWith(command);
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, text));
    await drain();
    await expectNoFailedJob();
    return stubSender.lastText ?? '';
  }

  it('a period Rekoda cannot count keeps no question open for a plan without Chat', async () => {
    const business = await seedMerchant();
    expect(await send('how much did I sell?', HOW_MUCH_DID_I_SELL)).toBe(
      replies.whichPeriod('sales').text,
    );
    await moveToPlan(business.id, 'integrate');
    // Not "I can count these windows": the ordinary path, refused there.
    expect(await send('yesterday')).toBe(FREE_FORM_REFUSED);
  });

  /**
   * A yes that reached Rekoda before the preview it would confirm (CG2) is
   * told "a preview is waiting, reply yes". On a plan that has lost Chat
   * since, that invites a yes it would refuse: it is told nothing was saved.
   */
  it('a yes that arrived before its preview invites no refused yes without Chat', async () => {
    const business = await seedMerchant();
    stubTransport.replyWith(AN_EXPENSE);
    // Both arrive before either is handled.
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'bought fuel 20k cash'));
    await post(messagePayload(OWNER, `wamid.G65-${++seq}`, 'yes'));
    // The preview is written while the plan still holds Chat...
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *yes*');
    // ...and the yes is handled after the switch.
    await moveToPlan(business.id, 'integrate');
    const before = await footprint(business.id);
    await drain();
    await expectNoFailedJob();

    expect(stubSender.lastText).toBe(YES_REFUSED);
    await expectOnlyReplies(business.id, before, 1);
    expect(await draftStates(business.id)).toEqual(['pending']);
  });

  /**
   * Codex, PR #261 (final head): a live question Rekoda asked, never a
   * preview, is not something a "yes?" could have saved. Without Chat it is
   * "nothing waiting", as the Chat-plan path says, never "I did not save that".
   */
  it('a yes? to a live question that was never a preview is "nothing waiting" without Chat', async () => {
    const business = await seedMerchant();
    expect(
      await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' }),
    ).toContain('How many wigs?');
    await moveToPlan(business.id, 'integrate');
    const states = await draftStates(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
    expect(await draftStates(business.id)).toEqual(states);
    await lapse(business.id);
    expect(await send('yes?')).toBe(replies.nothingToConfirmWithoutChat().text);
  });

  /**
   * "yes" and "yes?" agree on a draft the merchant was never shown as a
   * preview (final-head review): a live question Rekoda asked, and a preview
   * whose send failed (marked unseen). Both are "nothing waiting" on a plan
   * without Chat; neither is told a save was refused.
   */
  it.each([
    ['integrate', 'a live question'],
    ['lapsed', 'a live question'],
    ['integrate', 'an unseen preview'],
    ['lapsed', 'an unseen preview'],
  ] as const)('on a %s plan, yes and yes? agree on %s', async (standing, kind) => {
    const answers: string[] = [];
    for (const word of ['yes', 'yes?']) {
      await truncateAll(urls);
      const business = await seedMerchant();
      if (kind === 'a live question') {
        await send('sold some things', { intent: 'Unclear', clarification: 'How many wigs?' });
      } else {
        await send('Ada bought 3 wigs for 300k', A_SALE);
        // The preview's send failed: the draft is marked as never seen.
        await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`
            UPDATE command_drafts SET previewed = false
             WHERE business_id = ${business.id}::uuid AND state = 'pending'`),
        );
      }
      if (standing === 'integrate') await moveToPlan(business.id, 'integrate');
      else await lapse(business.id);
      const states = await draftStates(business.id);
      answers.push(await send(word));
      expect(await draftStates(business.id), word).toEqual(states);
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toBe(replies.nothingToConfirmWithoutChat().text);
  });
});
