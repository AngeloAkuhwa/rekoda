/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a receipt photo (part 3 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, createDb, identity, sql, withBusiness } from '@rekoda/db';
import { replies } from '@rekoda/core';
import {
  db,
  knownCustomer,
  messagePayload,
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

  /**
   * CodeRabbit and Codex on 1404dfb: attempt 1 passed the classifier, took
   * the message unit (committed on its own, so it survives the rollback) and
   * failed on its reply; the retry's classifier then ends the message. A
   * refusal delivers nothing, so everything the message holds goes back
   * (OWN-98, spec §4.3 rule 4). Junk keeps the page it understood (J7), but
   * telling the merchant a page is not a business document never costs a
   * message, on any attempt.
   */
  async function retryEndsAtTheClassifier(phone: string, wamid: string, ending: unknown) {
    const business = await seedMerchant(`+${phone}`);
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    const usage = { inputTokens: 400, outputTokens: 12 };
    stubTransport.script(
      { toolInput: { type: 'unsure' }, usage, stopReason: 'tool_use' },
      { toolInput: { command: A_PHOTOGRAPHED_EXPENSE }, usage, stopReason: 'tool_use' },
      ending as Parameters<typeof stubTransport.script>[0],
    );
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS gate_retry_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION gate_retry_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('gate_retry_once') = 1 THEN
            RAISE EXCEPTION 'gate retry: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER gate_retry_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION gate_retry_fail_once()`);

      await post(photoPayload(phone, wamid));
      await drain();
      const held = await g57Footprint(business.id);
      expect({ documents: held.documents, ai: held.ai_actions }).toEqual({ documents: 1, ai: 1 });

      await ownerDb.execute(sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`);
      await drain();
      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'`);
      expect([Number(job?.attempts), job?.state]).toEqual([2, 'done']);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS gate_retry_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS gate_retry_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS gate_retry_once`);
      await close();
      // The stub's last reply outlives reset(): leave it answering as the file expects.
      stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    }
    const left = await g57Footprint(business.id);
    const reply = stubSender.lastText;
    /* The one draft is the refusal, holding the sentence only: no confirmable expense is left
     * behind, and a yes after it saves nothing (independent review of #437 at ebeeadb). After the
     * yes every draft left is a refusal, and nothing else moved (CodeRabbit on #437 at b2703e7). */
    const refusals = async () =>
      [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute(sql`SELECT intent, command FROM command_drafts
                          WHERE business_id = ${business.id}::uuid`),
        )),
      ].map((d) => conversationsRepo.isRefusalDraft(d as { intent: string; command: unknown }));
    expect(await refusals()).toEqual([true]);
    await post(messagePayload(phone, `${wamid}-YES`, 'yes'));
    await drain();
    expect(stubSender.lastText).not.toContain('Saved');
    const after = await refusals();
    expect(after.every(Boolean)).toBe(true);
    const footprint = await g57Footprint(business.id);
    expect({ ...footprint, drafts: left.drafts }).toEqual(left);
    expect(footprint.drafts).toBe(after.length);
    return { left, reply };
  }

  it('gives back the message unit an earlier attempt took when the classifier refuses', async () => {
    const refusal = { toolInput: null, usage: { inputTokens: 400, outputTokens: 3 } };
    const { left, reply } = await retryEndsAtTheClassifier(
      '2348031234589',
      'wamid.P-GATE-REFUSED',
      {
        ...refusal,
        stopReason: 'refusal',
      },
    );
    expect(reply).toBe(replies.couldNotRead().text);
    /* The one draft is the refusal (owner review of #437), and a yes after it saves nothing
     * (`retryEndsAtTheClassifier`). Nothing else is touched. */
    expect(left).toEqual({ ...NOTHING_TOUCHED, drafts: 1 });
  });

  it('gives back the message unit an earlier attempt took when the page is junk', async () => {
    const { left, reply } = await retryEndsAtTheClassifier('2348031234588', 'wamid.P-GATE-JUNK', {
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    });
    expect(reply).toBe(replies.notABusinessDocument().text);
    expect(left).toEqual({ ...NOTHING_TOUCHED, documents: 1, drafts: 1 });
  });
});

/* A junk page's refusal is recorded before its reply is sent: a failure recording it rolls back
 * before anything is sent, and the retry answers once (independent review of #437 at 4480bc2). */
describe('a junk page whose refusal fails to record', () => {
  it('is answered once across the retry', async () => {
    const business = await seedMerchant('+2348031234587');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    const junk = {
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    };
    stubTransport.script(junk, junk);
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS junk_refusal_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION junk_refusal_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.command->>'refused' = 'true' AND nextval('junk_refusal_once') = 1 THEN
            RAISE EXCEPTION 'junk refusal: first record fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER junk_refusal_fail_once BEFORE INSERT ON command_drafts
          FOR EACH ROW EXECUTE FUNCTION junk_refusal_fail_once()`);
      await post(photoPayload('2348031234587', 'wamid.P-JUNK-ONCE'));
      await drain();
      await ownerDb.execute(sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`);
      await drain();
      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'`);
      expect([Number(job?.attempts), job?.state]).toEqual([2, 'done']);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS junk_refusal_fail_once ON command_drafts`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS junk_refusal_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS junk_refusal_once`);
      await close();
      stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    }
    const sent = stubSender.sent.filter((m) => m.text === replies.notABusinessDocument().text);
    expect(sent).toHaveLength(1);
    const drafts = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ intent: string; command: unknown }>(
        sql`SELECT intent, command FROM command_drafts WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect([...drafts].map((d) => conversationsRepo.isRefusalDraft(d))).toEqual([true]);
  });
});

/* G-137 on a photographed page (CodeRabbit on #437 at 56c4140): a buyer the model names that is
 * nowhere on the page or in the caption is the model's, not the receipt's. It creates nobody and
 * drafts nothing, exactly as an untyped name in a text message. A buyer the page does name is
 * previewed as before. */
describe('a receipt photo whose buyer the model names', () => {
  const SALE_TO = (mention: string) => ({
    intent: 'RecordSale',
    customer: { kind: 'mention', mention },
    items: [{ name: 'wig', quantity: 2, unitPrice: 50_000 }],
    statedTotal: 100_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  });
  const customersOf = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM customers WHERE business_id = ${businessId}::uuid`,
      ),
    ).then((r) => r[0]!.n);
  const salesDrafts = (businessId: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM command_drafts
             WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'`,
      ),
    ).then((r) => r[0]!.n);

  it('creates nobody and drafts nothing when the page names no buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'RECEIPT 2 wigs TOTAL 100,000', confidence: 0.9 });
    stubTransport.replyWith(SALE_TO('Bola Ige'));

    await post(photoPayload('2348031234567', 'wamid.PB1'));
    await drain();

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await customersOf(business.id)).toBe(0);
    expect(await salesDrafts(business.id)).toBe(0);
    await post(messagePayload('2348031234567', 'wamid.PB1-yes', 'yes'));
    await drain();
    const invoices = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    ).then((r) => r[0]!.n);
    expect(invoices).toBe(0);
  });

  it('previews the buyer the page names', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'RECEIPT Bill to: Bola Ige 2 wigs TOTAL 100,000', confidence: 0.9 });
    stubTransport.replyWith(SALE_TO('Bola Ige'));

    await post(photoPayload('2348031234567', 'wamid.PB2'));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
  });

  /* Owner ruling 22 Nov 2026 (photo-extracted customer names): a name on the page is not the buyer
   * unless the page labels it as the buyer or the caption types it. The merchant's own header, a
   * delivery contact and a name in passing are asked about: nobody is created, nothing drafted. */
  it.each([
    ['the merchant’s own header', 'ADA FASHION RECEIPT 2 wigs TOTAL 100,000', 'Ada Fashion'],
    ['a delivery contact', 'RECEIPT Deliver to: Bola Ige 2 wigs TOTAL 100,000', 'Bola Ige'],
    ['a name in passing', 'RECEIPT 2 wigs from Bola Ige TOTAL 100,000', 'Bola Ige'],
    /* An address is no name: the seller Ada is not the buyer "ada@…" (CodeRabbit, #437 b2703e7). */
    ['a name inside the buyer address', 'Seller: Ada\nBuyer: ada@example.test\n2 wigs', 'Ada'],
  ])('a buyer named only as %s creates nobody and drafts nothing', async (_, page, mention) => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: page, confidence: 0.9 });
    stubTransport.replyWith(SALE_TO(mention));

    await post(photoPayload('2348031234567', 'wamid.PB3'));
    await drain();

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await customersOf(business.id)).toBe(0);
    expect(await salesDrafts(business.id)).toBe(0);
  });

  /* The labelled field holds the buyer's complete name: "Ada" is not "Ada Obi", so a seller
   * called Ada is never taken for the labelled buyer (CodeRabbit on #437 at aff3f63). */
  it('a name that only begins the labelled buyer is not the buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'RECEIPT Seller: Ada Buyer: Ada Obi 2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith(SALE_TO('Ada'));

    await post(photoPayload('2348031234567', 'wamid.PB9'));
    await drain();

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await customersOf(business.id)).toBe(0);
    expect(await salesDrafts(business.id)).toBe(0);
    await post(messagePayload('2348031234567', 'wamid.PB9-yes', 'yes'));
    await drain();
    const invoices = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    ).then((r) => r[0]!.n);
    expect(invoices).toBe(0);
  });

  /* The field is its own line: an address on the next line, or a name under its label, still
   * names the buyer. */
  it.each([
    [
      'with the address on the next line',
      'RECEIPT\nBill to: Bola Ige\nLagos Island\n2 wigs TOTAL 100,000',
    ],
    ['under its label', 'RECEIPT\nBill to:\nBola Ige\n2 wigs TOTAL 100,000'],
    /* The next field's label ends the name (CodeRabbit on #437 at 88258dc). */
    ['with a phone field after it', 'RECEIPT\nBill to: Bola Ige Tel: 08035551234\n2 wigs'],
    /* A whole address stands as the message's provisional token. */
    ['by a whole address', 'Seller: Ada\nBuyer: bola@example.test\n2 wigs', 'CUSTOMER_U01'],
  ])('previews the labelled buyer %s', async (_, page, token?: string) => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: page, confidence: 0.9 });
    stubTransport.replyWith(
      token ? { ...SALE_TO('x'), customer: { kind: 'token', token } } : SALE_TO('Bola Ige'),
    );

    await post(photoPayload('2348031234567', 'wamid.PB10'));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
  });

  /* A phone printed on the page beside a labelled buyer (the seller's own, a delivery contact's)
   * is nobody's: never asked about as the buyer's, never created (independent review at ccdcc8e). */
  it('creates no customer from an unlabelled phone beside the labelled buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'RECEIPT Tel 08035551234 Bill to: Bola Ige 2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith(SALE_TO('Bola Ige'));

    await post(photoPayload('2348031234567', 'wamid.PB6'));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
    expect(await customersOf(business.id)).toBe(1);
    const phones = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM customer_identities
             WHERE business_id = ${business.id}::uuid AND facet = 'phone'`,
      ),
    ).then((r) => r[0]!.n);
    expect(phones).toBe(0);
  });

  /* A single-word label counts only with its colon or dash: a heading names nobody (CodeRabbit on
   * #437 at ccdcc8e). */
  it('a heading such as "Customer Support Ltd" labels nobody as the buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'Customer Support Ltd RECEIPT 2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith(SALE_TO('Support Ltd'));

    await post(photoPayload('2348031234567', 'wamid.PB7'));
    await drain();

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await customersOf(business.id)).toBe(0);
    expect(await salesDrafts(business.id)).toBe(0);
  });

  it('"Customer: Support Ltd" labels the buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'RECEIPT Customer: Support Ltd 2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith(SALE_TO('Support Ltd'));

    await post(photoPayload('2348031234567', 'wamid.PB8'));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
  });

  /* An email the caption types names its buyer as a whole address (Codex and CodeRabbit on #437
   * at ccdcc8e); the page names nobody. */
  it('previews a buyer whose email the caption types', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'RECEIPT 2 wigs TOTAL 100,000', confidence: 0.9 });
    stubTransport.replyWith({
      ...SALE_TO('x'),
      customer: { kind: 'token', token: 'CUSTOMER_U01' },
    });

    await post(photoPayload('2348031234567', 'wamid.PB9', { caption: 'sold to ada@example.test' }));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
    expect(await customersOf(business.id)).toBe(1);
  });

  /* An address in a buyer field is the whole address: the seller's "sales@example.test" printed
   * elsewhere is not the buyer "sales@example.test.ng" (CodeRabbit on #437 at cacc734). */
  it('a seller address that prefixes the labelled buyer address is not the buyer', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'RECEIPT Buyer: sales@example.test.ng Seller sales@example.test 2 wigs TOTAL 100,000',
      confidence: 0.9,
    });
    stubTransport.replyWith({
      ...SALE_TO('x'),
      customer: { kind: 'token', token: 'CUSTOMER_U02' },
    });

    await post(photoPayload('2348031234567', 'wamid.PB10'));
    await drain();

    expect(stubSender.lastText).toContain('could not tell which customer');
    expect(await customersOf(business.id)).toBe(0);
    expect(await salesDrafts(business.id)).toBe(0);
  });

  it('previews a buyer the caption types, though the page does not label them', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'RECEIPT 2 wigs TOTAL 100,000', confidence: 0.9 });
    stubTransport.replyWith(SALE_TO('Bola Ige'));

    await post(photoPayload('2348031234567', 'wamid.PB4', { caption: 'sold to Bola Ige' }));
    await drain();

    expect(stubSender.lastText).not.toContain('could not tell which customer');
    expect(await salesDrafts(business.id)).toBe(1);
  });

  it.each([
    ['in the page header', 'ADA OBI STORES RECEIPT 2 wigs TOTAL 100,000', 0],
    ['under the buyer label', 'RECEIPT Customer: Ada Obi 2 wigs TOTAL 100,000', 1],
  ])('a recorded customer named %s is the buyer only when labelled', async (_, page, drafted) => {
    const business = await seedMerchant('+2348031234567');
    const ada = await knownCustomer(business.id, 'Ada Obi', 'CUSTOMER_7K2');
    arrangePhoto();
    stubOcr.answerWith({ text: page, confidence: 0.9 });
    stubTransport.replyWith({ ...SALE_TO('x'), customer: { kind: 'token', token: ada.token } });

    await post(photoPayload('2348031234567', 'wamid.PB5'));
    await drain();

    /* The draft carries the labelled customer's own token (CodeRabbit on #437 at 88258dc). */
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`SELECT command->'customer' AS c FROM command_drafts
                      WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale'`),
    );
    expect([...customers].map((r) => r.c)).toEqual(
      drafted ? [{ kind: 'token', token: ada.token }] : [],
    );
    if (drafted === 0) expect(stubSender.lastText).toContain('could not tell which customer');
  });
});
