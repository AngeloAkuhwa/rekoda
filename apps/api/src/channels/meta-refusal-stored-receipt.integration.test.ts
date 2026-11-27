/**
 * CodeRabbit on #437 at c5392f0 (conversations.ts `hasDraftsAfterBy`): a clarification whose failed
 * delivery receipt is stored but not yet applied was never read, so it never makes the member's
 * refusal stale.
 *
 * The receipt's `delivery.status` job marks the clarification undelivered when it runs. Until then
 * the clarification carries no mark, and a yes read in that window would count it as something the
 * member read since their refusal, so the yes would no longer answer the refusal and could book
 * another member's newer preview. A receipt stored and not yet applied, its job pending, running or
 * dead, counts as applied for this purpose.
 */
import { expect, it } from 'vitest';
import { identity, sql, withBusiness } from '@rekoda/db';
import {
  db,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { answered, mediaMessage } from './meta-continuations.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
import {
  DELEGATE,
  OWNER,
  footprint,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

const STICKER = { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } };

/** Each refusal's state, by the member who made it. */
async function refusalStates(businessId: string): Promise<string[]> {
  const owner = await identity.findUserByPhone(db, `+${OWNER}`);
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string; by: string | null }>(sql`
      SELECT state, requested_by::text AS by FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND command->>'refused' = 'true'
       ORDER BY insertion_seq`),
  );
  return [...rows].map((r) => `${r.by === owner?.id ? 'owner' : 'other'}:${r.state}`);
}

it("a clarification's failed receipt stored after the yes was queued: the yes books nothing", async () => {
  const business = await seedMerchant();
  const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
  await identity.addMembership(db, business.id, delegate.id, 'delegate');
  await post(mediaMessage('wamid.SR1', STICKER, OWNER));
  await drain();
  await say(
    'wamid.SR2',
    { intent: 'Unclear', clarification: 'Which customer was that for?' },
    'sold 2 wigs',
  );
  const clarification = lastWamid();
  stubTransport.replyWith(sale({ kind: 'none' }));
  await post(messagePayload(DELEGATE, 'wamid.SR3', 'sold 3 wigs for 150k'));
  await drain();
  const before = await footprint(business.id);
  const sent = stubSender.sent.length;
  /* CodeRabbit on #437 at ddba9a7: the owner's refusal is waiting, and the held yes answers it. */
  expect(await refusalStates(business.id)).toEqual(['owner:pending']);

  /* The yes is queued first, so the receipt's job, queued after it, does not hold it up
   * (`hasEarlierLiveJob`), and the yes is read while the receipt is stored and not yet applied. */
  await post(messagePayload(OWNER, 'wamid.SR4', 'yes'));
  await receipt(OWNER, clarification, 'failed');
  await drain();

  expect(stubSender.sent.length).toBeGreaterThan(sent);
  expect(await footprint(business.id)).toEqual(before);
  expect(await refusalStates(business.id)).toEqual(['owner:superseded']);
  const { replies, unfinished } = await answered(business.id, 'SR4');
  expect(replies[0]).toHaveLength(1);
  expect(replies[0]?.[0]).not.toBe('unsent');
  expect(unfinished).toBe(0);
});
