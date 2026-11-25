/**
 * CodeRabbit on #437 (PRRT_kwDOT845J8676qPS): a preview withdrawn because an earlier message of
 * the merchant was lost keeps that fact when a failed receipt for the preview arrives later.
 *
 * Both are true and both are kept: the request was withdrawn (so a "yes" is told to send it
 * again, and books nothing) and its preview never reached the merchant (so it is no answer to
 * a refusal, `hasDraftsAfterBy`). Before, the receipt overwrote `inbound_message_failed` with
 * `preview_not_delivered` and the next "yes" lost the resend instruction.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { conversationsRepo, identity, sql, withBusiness } from '@rekoda/db';
import { db, post, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import { mediaMessage } from './meta-continuations.fixtures.js';
import {
  AN_EXPENSE,
  drain,
  draftStates,
  footprint,
  plain,
  say,
  seedMerchant,
} from './meta-preview-expiry.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
import { killInboundJob, queueOnly } from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';

describe('a failed receipt for a preview withdrawn behind a lost message', () => {
  it.each(['yes', 'no'] as const)(
    'keeps the resend guidance for a later "%s", books nothing, and a repeated receipt changes nothing',
    async (answer) => {
      const business = await seedMerchant();
      await say(`wamid.FI-${answer}-1`, AN_EXPENSE, 'bought fuel 20k cash');
      const preview = lastWamid();
      await queueOnly(`wamid.FI-${answer}-cancel`, 'cancel');
      await killInboundJob(business.id, 'markFailed');

      /* The lost message is reconciled first: the preview is withdrawn with the reason. */
      await plain(`wamid.FI-${answer}-2`, answer);
      const told =
        answer === 'yes' ? replies.earlierMessageLostYes() : replies.earlierMessageLostNo();
      expect(stubSender.lastText).toBe(told.text);

      /* WhatsApp then reports that preview undelivered, twice. */
      await receipt(OWNER, preview, 'failed');
      await receipt(OWNER, preview, 'failed');
      await drain();

      const states = await draftStates(business.id);
      expect(states).toEqual([{ state: 'superseded', reason: 'inbound_message_failed' }]);

      await plain(`wamid.FI-${answer}-3`, answer);
      expect(stubSender.lastText).toBe(told.text);
      await plain(`wamid.FI-${answer}-4`, 'yes');
      expect(stubSender.lastText).toBe(replies.earlierMessageLostYes().text);
      expect((await footprint(business.id)).expenses).toBe(0);
    },
  );

  /* The undelivered mark is what lets a refusal stay the member's last read: a withdrawn preview
   * that never arrived is not "recorded since" it (`hasDraftsAfterBy`). */
  it('still reads as undelivered by hasDraftsAfterBy once the receipt arrives', async () => {
    const business = await seedMerchant();
    await post(
      mediaMessage(
        'wamid.FI-ref',
        { type: 'sticker', sticker: { id: 's', mime_type: 'image/webp' } },
        OWNER,
      ),
    );
    await drain();
    await say('wamid.FI-ref-1', AN_EXPENSE, 'bought fuel 20k cash');
    const preview = lastWamid();
    await queueOnly('wamid.FI-ref-cancel', 'cancel');
    await killInboundJob(business.id, 'markFailed');
    await plain('wamid.FI-ref-yes', 'yes');

    const owner = (await identity.upsertUserByPhone(db, `+${OWNER}`)).id;
    const closes = () =>
      withBusiness(db, business.id, async (tx) => {
        const [refusal] = [
          ...(await tx.execute<{ id: string }>(sql`
            SELECT id FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND command->>'refused' = 'true'
             ORDER BY insertion_seq LIMIT 1`)),
        ];
        return conversationsRepo.hasDraftsAfterBy(tx, business.id, refusal!.id, owner);
      });
    /* Withdrawn but possibly read: it still stands after the refusal. */
    expect(await closes()).toBe(true);
    await receipt(OWNER, preview, 'failed');
    await drain();
    /* Reported undelivered: never read, so it no longer does. The reason is still the lost message. */
    expect(await closes()).toBe(false);
    expect(await draftStates(business.id)).toContainEqual({
      state: 'superseded',
      reason: 'inbound_message_failed',
    });
  });
});
