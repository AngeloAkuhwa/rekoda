/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a receipt photo (part 3 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { createDb, identity, sql } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  db,
  photoPayload,
  post,
  stubOcr,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  A_PHOTOGRAPHED_EXPENSE,
  seedMerchant,
  drain,
  arrangePhoto,
  readsUsed,
  g57Footprint,
  NOTHING_TOUCHED,
} from './meta-receipt-photo.fixtures.js';

useMetaWebhookHarness();

/**
 * A photograph of a receipt (ADR 0024, decision C9).
 *
 * The pipeline is photo, self-hosted OCR, PII tokenisation, then a model, and
 * the property that matters most is the one that is hardest to see in a diff:
 * there is NO other route for the image. Every failure below must produce a
 * sentence rather than a second attempt somewhere a photograph could reach a
 * third party.
 */
describe('a receipt photo', () => {
  /* Final review B on a1e54e3: a member demoted while their photo was being
   * read is refused after the reading, and a refused request consumes
   * nothing (spec §4.3 rule 4), so the page's unit goes back. */
  /* Final review B on fdefa54: attempt 1 read the page AND took the message
   * unit, then failed; the member was demoted before the retry, which is
   * refused before the fetch. Both units go back: the message delivered
   * nothing. */
  it('gives back the page and the message unit when a demoted retry is refused (G-57)', async () => {
    const business = await seedMerchant('+2348031234591');
    const delegate = await identity.upsertUserByPhone(db, '+2348039990004');
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_two_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_two_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('g57_two_once') = 1 THEN
            RAISE EXCEPTION 'g57: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_two_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_two_fail_once()`);

      await post(photoPayload('2348039990004', 'wamid.P-G57-TWO'));
      await drain();
      const held = await g57Footprint(business.id);
      expect({ documents: held.documents, ai: held.ai_actions }).toEqual({ documents: 1, ai: 1 });

      await ownerDb.execute(sql`
        UPDATE memberships SET role = 'accountant'
         WHERE business_id = ${business.id}::uuid AND user_id = ${delegate.id}::uuid`);
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_two_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_two_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_two_once`);
      await close();
    }
    expect(stubSender.lastText).toBe(replies.viewOnlyPhoto().text);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  it('gives the page back when the member is demoted while it is read (G-57)', async () => {
    const business = await seedMerchant('+2348031234594');
    const delegate = await identity.upsertUserByPhone(db, '+2348039990003');
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    const read = stubOcr.extract.bind(stubOcr);
    stubOcr.extract = async (bytes, mimeType) => {
      await ownerDb.execute(sql`
        UPDATE memberships SET role = 'accountant'
         WHERE business_id = ${business.id}::uuid AND user_id = ${delegate.id}::uuid`);
      return read(bytes, mimeType);
    };
    try {
      await post(photoPayload('2348039990003', 'wamid.P-G57-DEMOTED'));
      await drain();
    } finally {
      stubOcr.extract = read;
      await close();
    }

    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
    /* The page's unit is back, no message unit was taken, nothing was
     * drafted, and the role is checked again before the paid document
     * classifier, so no model was called (Codex P2). */
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
    expect(stubTransport.requests).toHaveLength(0);
  });

  /* The same photograph from a delegate, who may record trade, is read and
   * previewed exactly as an owner's is: the refusal is the role's, not the
   * photo's. */
  it('reads the same photo from a delegate as before (G-57 control)', async () => {
    const business = await seedMerchant('+2348031234567');
    const delegate = await identity.upsertUserByPhone(db, '+2348039990002');
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348039990002', 'wamid.P-G57-D'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(await readsUsed(business.id)).toBe(1);
  });
});
