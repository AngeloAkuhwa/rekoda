/**
 * A receipt photo names a customer only from its own words (G-137; CodeRabbit on #437 at
 * 56c4140).
 *
 * The page's text and the caption are what the merchant sent, and both reach the interpreter as
 * one message. A customer name the model returns that is on neither is the model's, not the
 * merchant's: a recorded customer of that name is never put on the record or answered about,
 * exactly as for a typed message. A name that IS on the page keeps its path.
 */
import { describe, expect, it } from 'vitest';
import { issueRepo, withBusiness } from '@rekoda/db';
import {
  db,
  deps,
  messagePayload,
  photoPayload,
  post,
  stubOcr,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { arrangePhoto, drain } from './meta-receipt-photo.fixtures.js';
import { balanceOf, footprint, OWNER, sale, seedMerchant } from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

async function invoiceTo(businessId: string, token: string) {
  await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: token,
      items: [{ name: 'wig', quantity: 2, unitPriceK: 5_000_000 }],
      subtotalK: 10_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 10_000_000,
      paidK: 0,
      balanceDueK: 10_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${token}`,
      actor: 'system',
    }),
  );
}

async function photo(wamid: string, pageText: string, command: unknown) {
  arrangePhoto();
  stubOcr.answerWith({ text: pageText, confidence: 0.9 });
  stubTransport.replyWith(command);
  await post(photoPayload(OWNER, wamid));
  await drain();
}

describe('a receipt photo naming a customer', () => {
  it('a sale naming a recorded customer the page never shows is not drafted', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);
    const before = await footprint(business.id);

    await photo(
      'wamid.RP1',
      'TOTAL 100,000 2 wigs',
      sale({ kind: 'mention', mention: 'Bola Ige' }),
    );

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await footprint(business.id)).toEqual(before);
    await post(messagePayload(OWNER, 'wamid.RP1-yes', 'yes'));
    await drain();
    expect(await footprint(business.id)).toEqual(before);
  });

  it('a question about a recorded customer the page never shows is not answered with their balance', async () => {
    const business = await seedMerchant();
    const bola = await deps.gateway.resolveMention(business.id, 'Bola Ige');
    await invoiceTo(business.id, bola.token);

    await photo(
      'wamid.RP2',
      'TOTAL 100,000 2 wigs',
      balanceOf({ kind: 'mention', mention: 'Bola Ige' }),
    );

    expect(stubSender.lastText).toContain('do not have a customer by that name');
    expect(stubSender.lastText).not.toContain('100,000');
  });

  it('a sale naming a new customer the page shows is still drafted for them', async () => {
    const business = await seedMerchant();

    await photo(
      'wamid.RP3',
      'Sold to: Tunde Bakare\nTOTAL 100,000 2 wigs',
      sale({ kind: 'mention', mention: 'Tunde Bakare' }),
    );

    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect((await footprint(business.id)).drafts).toBe(1);
  });
});
