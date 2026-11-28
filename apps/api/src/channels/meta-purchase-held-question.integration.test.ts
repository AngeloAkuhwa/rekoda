/**
 * A held purchase answers to its LATEST accepted identity question (OD-70 Option B, issue #439).
 *
 * "Is this the same purchase?" may be asked more than once: again after a "no", after doubt
 * ("yes?"), or after a "separate" that found another match. A WhatsApp `failed` receipt that
 * arrives late is about one particular reply. Only a failure of the question the member is now
 * answering withdraws the hold, as a send-time failure of that question would (OWN-102(4)): its
 * continuation closes and their "same" finds no question. A late failure of an EARLIER question
 * changes nothing: the live re-ask still stands and their "same" is answered. Either way nothing
 * is booked that the merchant did not confirm, and a duplicated receipt converges.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { db, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import {
  ALIGN,
  DELEGATE,
  MILO,
  RACE,
  QUESTION,
  SAME_DONE,
  REASK,
  seedMerchant,
  addDelegate,
  drain,
  say,
  reply,
  purchases,
  footprint,
  bookMilo,
} from './meta-purchase-truth.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';

useMetaWebhookHarness();

const OWNER_PHONE = '2348031234567';

/** Holds withdrawn because the question they asked was reported undelivered. */
const withdrawnUndelivered = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND withdrawn
         AND retired_reason = 'preview_not_delivered'`),
  ).then((rows) => [...rows][0]?.n ?? 0);

const latestQuestionState = (businessId: string, userId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
      SELECT state FROM conversation_continuations
       WHERE business_id = ${businessId}::uuid AND user_id = ${userId}::uuid
         AND expects = 'purchase_identity'
       ORDER BY insertion_seq DESC LIMIT 1`),
  ).then((rows) => [...rows][0]?.state);

/**
 * The delegate is asked about a purchase matching one already booked; with `newMatch` the owner
 * records another match and the delegate's "separate" asks again. Then `reask` asks again
 * ("no" or doubt). Returns the wamids of the first question and of the latest one.
 */
async function askTwice(businessId: string, tag: string, newMatch: boolean, reask: 'no' | 'doubt') {
  await bookMilo(businessId, tag);
  await say(`wamid.${tag}-first`, MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
  expect(stubSender.lastText).toContain(QUESTION);
  const initial = lastWamid();
  if (newMatch) {
    await say(`wamid.${tag}-new`, MILO, 'I bought 10 cartons of Milo for 100k cash');
    await reply(`wamid.${tag}-new-separate`, 'separate');
    await reply(`wamid.${tag}-new-yes`, 'yes');
    await reply(`wamid.${tag}-reask`, 'separate', DELEGATE);
    expect(stubSender.lastText).toContain(QUESTION);
  }
  await reply(`wamid.${tag}-again`, reask === 'no' ? 'no' : 'yes?', DELEGATE);
  expect(stubSender.lastText).toContain(REASK);
  const current = lastWamid();
  expect(current).not.toBe(initial);
  return { initial, current };
}

describe('a held purchase follows its latest identity question (#439)', () => {
  for (const reask of ['no', 'doubt'] as const) {
    it.each([
      ['initial', false],
      ['current', false],
      ['initial', true],
      ['current', true],
    ] as const)(
      `a late failure of the %s question (new match: %s), re-asked after ${reask}`,
      async (failed, newMatch) => {
        const business = await seedMerchant();
        const delegate = await addDelegate(business.id);
        const tag = `H-${reask}-${failed}-${newMatch ? 'm' : 'n'}`;
        const { initial, current } = await askTwice(business.id, tag, newMatch, reask);

        const failedWamid = failed === 'initial' ? initial : current;
        // Delivered twice, as a retried webhook would be: the second changes nothing more.
        await receipt(DELEGATE, failedWamid, 'failed');
        await receipt(DELEGATE, failedWamid, 'failed');
        await drain();

        expect(await latestQuestionState(business.id, delegate)).toBe(
          failed === 'initial' ? 'open' : 'superseded',
        );
        await reply(`wamid.${tag}-same`, 'same', DELEGATE);
        if (failed === 'initial') {
          // The live re-ask still stands: "same" is answered.
          expect(stubSender.lastText).toContain(SAME_DONE);
          expect(await withdrawnUndelivered(business.id)).toBe(0);
        } else {
          // The question they would be answering never arrived: the hold was withdrawn.
          expect(stubSender.lastText).not.toContain(SAME_DONE);
          expect(await withdrawnUndelivered(business.id)).toBe(1);
        }
        // Nothing is booked that the merchant did not confirm.
        expect(await purchases(business.id)).toBe(newMatch ? 2 : 1);
      },
    );
  }

  it('a hold with no recorded question (made before the link) keeps the earlier rule', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    const { initial } = await askTwice(business.id, 'H-legacy', false, 'no');
    // What a hold re-asked by the earlier release looks like: no link recorded.
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET held_question_message_id = NULL
                      WHERE business_id = ${business.id}::uuid AND state = 'held'`),
    );

    await receipt(DELEGATE, initial, 'failed');
    await drain();

    // The earlier rule (the drafting message) fails safe: withdrawn, nothing booked. A hold
    // re-asked after a "no" or doubt before 0249 keeps this rule (OD-80).
    expect(await withdrawnUndelivered(business.id)).toBe(1);
    await reply('wamid.H-legacy-same', 'same', DELEGATE);
    expect(stubSender.lastText).not.toContain(SAME_DONE);
    expect(await purchases(business.id)).toBe(1);
  });

  /*
   * A yes refused because a matching purchase was booked since its preview (G-81): the member is
   * asked "same or separate" in reply to the yes. That question is the hold's latest, so its late
   * failure withdraws the hold, as a late failure of any current question does (OD-80; at send
   * time the preview is put back instead). Nothing is booked.
   */
  it('a late failure of the question asked at a refused yes withdraws the hold (OD-80)', async () => {
    const business = await seedMerchant();
    await addDelegate(business.id);
    await say(
      'wamid.H-ry-o',
      { ...MILO, supplierReference: 'invoice 0101' },
      'Milo 100k, receipt EMK-0101',
    );
    await say(
      'wamid.H-ry-d',
      { ...MILO, amount: 100_001, reportedPayment: 100_001 },
      'Milo 100k, receipt EMK-0202',
      DELEGATE,
    );
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        UPDATE command_drafts SET command = (command - 'supplierReference') || ${ALIGN}::jsonb
         WHERE business_id = ${business.id}::uuid`),
    );
    await reply('wamid.H-ry-yes-1', 'yes');
    expect(await purchases(business.id)).toBe(1);
    await reply('wamid.H-ry-yes-2', 'yes');
    expect(stubSender.lastText).toContain(RACE);
    expect(stubSender.lastText).toContain(QUESTION);
    const before = await footprint(business.id);

    await receipt(OWNER_PHONE, lastWamid(), 'failed');
    await drain();

    expect(await withdrawnUndelivered(business.id)).toBe(1);
    await reply('wamid.H-ry-same', 'same');
    expect(stubSender.lastText).not.toContain(SAME_DONE);
    expect(await purchases(business.id)).toBe(1);
    expect(await footprint(business.id)).toEqual(before);
  });
});
