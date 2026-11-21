/**
 * A yes, a no or a questioned yes after a refusal (owner review of #437): split from
 * meta-refusal-yes.integration.test.ts, which is at the layout limit.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { identity, sql, withBusiness } from '@rekoda/db';
import { db, deps, post, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { mediaMessage } from './meta-continuations.fixtures.js';
import {
  DELEGATE,
  OWNER,
  footprint,
  plain,
  sale,
  say,
  seedMerchant,
} from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

const STICKER = { type: 'sticker', sticker: { id: 'sticker-1', mime_type: 'image/webp' } };
const QUESTION = {
  intent: 'Query',
  topic: 'sales_summary',
  customer: null,
  period: 'today',
  periodText: 'today',
  format: 'chat',
};

/**
 * After a preview, a question and the member's own refusal, the reply to their yes or no says
 * "reply yes to save it": the next yes must save it, never retire the question first (CodeRabbit
 * on #437 at 96b1b52).
 */
describe('the yes the refusal reply promises saves the preview behind it', () => {
  it.each(['yes', 'no'])('after "%s" to the refusal, one more yes saves it', async (answer) => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RP1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await say('wamid.RP2', QUESTION, 'how much did I sell today');
    await post(mediaMessage(`wamid.RP3-${answer}`, STICKER, OWNER));
    await drain();
    const before = await footprint(business.id);

    await plain(`wamid.RP4-${answer}`, answer);
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    await plain(`wamid.RP5-${answer}`, 'yes');
    expect((await footprint(business.id)).invoices).toBe(before.invoices + 1);
  });
});

/** A questioned yes ("na so?") is member-aware and read-only, as a yes is (CodeRabbit at 96b1b52). */
describe("a questioned yes looks past another member's refusal", () => {
  it("points the owner at their preview and leaves the delegate's refusal theirs", async () => {
    const business = await seedMerchant();
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    await say(
      'wamid.RQ1',
      sale({ kind: 'token', token: ada.token }),
      'sold Ada Obi 2 wigs for 100k',
    );
    await post(mediaMessage('wamid.RQ2', STICKER, DELEGATE));
    await drain();
    const before = await footprint(business.id);

    await plain('wamid.RQ3', 'na so?');
    expect(stubSender.lastText).toBe(replies.plainYesNeeded().text);
    const refusals = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ state: string }>(
        sql`SELECT state FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'`,
      ),
    );
    expect([...refusals].map((r) => r.state)).toEqual(['pending']);
    expect(await footprint(business.id)).toEqual(before);
  });
});
