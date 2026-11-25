/**
 * CodeRabbit on #437 (PRRT_kwDOT845J8676qPZ): "cancel" dismisses a refusal for good; a bare "no"
 * only closes it and is put back when its acknowledgement never reached the merchant.
 *
 * A cancel's acknowledgement that fails (at once, or accepted and reported failed later) must not
 * reopen the refusal the merchant explicitly cancelled. A bare "no" keeps its recovery (OD-62(o)).
 * Draft states and the financial footprint are asserted, never only the reply.
 */
import { describe, expect, it } from 'vitest';
import { identity, sql, withBusiness } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';
import { mediaMessage } from './meta-continuations.fixtures.js';
import { lastWamid, receipt } from './meta-preview-expiry.fixtures.js';
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

/** A sale preview, then the member's own refusal on top of it. */
async function saleThenRefusal(tag: string) {
  const business = await seedMerchant();
  const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
  await say(
    `wamid.${tag}1`,
    sale({ kind: 'token', token: ada.token }),
    'sold Ada Obi 2 wigs for 100k',
  );
  await post(mediaMessage(`wamid.${tag}2`, STICKER, OWNER));
  await drain();
  return business;
}

const refusals = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ state: string; phone: string | null }>(sql`
        SELECT d.state, u.phone AS phone FROM command_drafts d
          LEFT JOIN users u ON u.id = d.requested_by
         WHERE d.business_id = ${businessId}::uuid AND d.command->>'refused' = 'true'
         ORDER BY d.insertion_seq`),
    )),
  ].map((r) => `${r.phone ?? 'nobody'}:${r.state}`);

describe('"cancel" against a bare "no" when the acknowledgement does not arrive (CodeRabbit on #437)', () => {
  it.each([
    ['is delivered', 'delivered'],
    ['fails at once', 'at once'],
    ['is accepted and later reported failed', 'later'],
    ['is reported failed twice', 'twice'],
  ] as const)(
    'a cancel that %s leaves the refusal cancelled; a yes books nothing',
    async (_name, how) => {
      const business = await saleThenRefusal(`CX${how}`);
      const before = await footprint(business.id);

      if (how === 'at once') stubSender.failWith();
      await plain(`wamid.CX${how}3`, 'cancel');
      if (how === 'later' || how === 'twice') {
        await receipt(OWNER, lastWamid(), 'failed');
        if (how === 'twice') await receipt(OWNER, lastWamid(), 'failed');
        await drain();
      }

      expect(await refusals(business.id)).toEqual([`+${OWNER}:superseded`]);
      await plain(`wamid.CX${how}4`, 'yes');
      await plain(`wamid.CX${how}5`, 'yes');
      expect(await footprint(business.id)).toEqual(before);
      expect(await refusals(business.id)).toEqual([`+${OWNER}:superseded`]);
    },
  );

  it('a bare "no" that fails late still puts the refusal back (recovery is kept)', async () => {
    const business = await saleThenRefusal('CXno');
    const before = await footprint(business.id);

    await plain('wamid.CXno3', 'no');
    await receipt(OWNER, lastWamid(), 'failed');
    await receipt(OWNER, lastWamid(), 'failed');
    await drain();

    expect(await refusals(business.id)).toEqual([`+${OWNER}:pending`]);
    await plain('wamid.CXno4', 'yes');
    expect(await footprint(business.id)).toEqual(before);
  });

  it("another member's refusal is untouched by a cancel and by its failed receipt", async () => {
    const business = await saleThenRefusal('CXdl');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    await post(mediaMessage('wamid.CXdl-d', STICKER, DELEGATE));
    await drain();

    await plain('wamid.CXdl3', 'cancel');
    await receipt(OWNER, lastWamid(), 'failed');
    await drain();

    expect(await refusals(business.id)).toEqual([`+${OWNER}:superseded`, `+${DELEGATE}:pending`]);
    await post(messagePayload(OWNER, 'wamid.CXdl4', 'yes'));
    await drain();
    expect((await footprint(business.id)).invoices).toBe(0);
  });
});
