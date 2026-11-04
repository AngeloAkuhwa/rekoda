/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a receipt photo (part 1 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { allowanceFor, replies, usagePeriod } from '@rekoda/core';
import { billingRepo } from '@rekoda/db';
import { TextExtractionUnavailable } from '../ai/ocr.js';
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
import {
  A_PHOTOGRAPHED_EXPENSE,
  seedMerchant,
  drain,
  arrangePhoto,
  readsUsed,
  drainWithDailyLimit,
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
  /** Move a business onto a plan, through the repository that owns the write. */
  async function movePhotoMerchantToPlan(
    businessId: string,
    plan: 'chat' | 'integrate' | 'complete',
  ) {
    await billingRepo.setPlan(db, {
      businessId,
      plan,
      expiresAt: null,
      actor: 'operator:test-plan',
    });
  }

  /** Spec §4.3 rule 2: reading a receipt is a Chat capability, and a bill. */
  it('never reaches the OCR engine for a merchant whose plan has no Chat', async () => {
    const business = await seedMerchant('+2348031234567');
    await movePhotoMerchantToPlan(business.id, 'integrate');
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P20'));
    await drain();

    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(0);
    expect(stubSender.lastText).toContain('part of the Chat plan');
  });

  /**
   * Spec §4.3 rule 3, the case that used to leak: charging after the engine
   * had already read the page meant an exhausted merchant could spend
   * Rekoda's OCR budget one photograph at a time.
   */
  it('never reaches the OCR engine once the document allowance is gone', async () => {
    const business = await seedMerchant('+2348031234567');
    const allowance = allowanceFor('trial', 'DOCUMENTS_UNDERSTOOD');
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'DOCUMENTS_UNDERSTOOD',
        allowance,
        allowance,
      ),
    );
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P21'));
    await drain();

    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(allowance);
    expect(stubSender.lastText).toContain('document scans');
  });

  /**
   * Taking the unit first only moves the order, never the price: a page
   * nobody could read is still a page nobody pays for.
   */
  it('gives the unit back when the engine cannot be reached', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith();

    await post(photoPayload('2348031234567', 'wamid.P22'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    expect(await readsUsed(business.id)).toBe(0);
  });

  /* G-07, Codex on #273: a page the gateway refuses was read and is never
   * recorded, so its document unit goes back. */
  it('gives the page back when its text holds a protected detail', async () => {
    const business = await seedMerchant('+2348031234567');
    const { token } = await deps.gateway.resolveMention(business.id, 'Adaeze Obiageli Okonkwo');
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE customers SET token = 'CUSTOMER_X1A' WHERE token = ${token}`),
    );
    arrangePhoto();
    stubOcr.answerWith({
      text: 'send to Adaeze Obiageli Okonkwo 0123456789 for the wigs',
      confidence: 0.9,
    });

    await post(photoPayload('2348031234567', 'wamid.P23'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    expect(stubTransport.requests).toHaveLength(0);
    /* A page cannot be resent without the number: type it instead. */
    expect(stubSender.lastText).toContain('type what it says instead');
    expect(await readsUsed(business.id)).toBe(0);
  });

  it('takes the SAME path a typed sentence takes, gates included', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.88 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P1'));
    await drain();

    // A photograph is an input method, not a second product with its own rules.
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(stubSender.lastText).toContain('₦12,000');
  });

  it('keeps the extracted text and NEVER the image', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto(Buffer.from('JFIF-secret-photo-of-adas-shop'));
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P2'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id, 20),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('JFIF');
    expect(dump).not.toContain('secret-photo');
    // The bytes went to the configured reader and nowhere else.
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubOcr.calls[0]?.mimeType).toBe('image/jpeg');
  });

  it('reaches no model at all when OCR fails, and costs the merchant nothing', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith();
    const modelCallsBefore = stubTransport.requests.length;

    await post(photoPayload('2348031234567', 'wamid.P3'));
    await drain();

    expect(stubSender.lastText).toContain('could not read that photo');
    /* THE point of ADR 0024's no-fallback clause. A failed extraction must
     * not become a photograph sent to a model provider, so the model is not
     * called at all. */
    expect(stubTransport.requests.length).toBe(modelCallsBefore);

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);
  });

  it('answers honestly when the image cannot be fetched, and reads nothing', async () => {
    await seedMerchant('+2348031234567');
    // No media arranged: the provider has nothing for this id.
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P4'));
    await drain();

    expect(stubSender.lastText).toContain('could not read that photo');
    expect(stubOcr.calls).toHaveLength(0);
  });

  it('meters one documents_understood unit per photograph read', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P5'));
    await drain();

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  /* G-78: what a photograph SAYS is document text, not something the
   * merchant typed. A sign, a screenshot or a receipt that happens to read
   * "STOP" or "YES" must neither opt the merchant out nor confirm the waiting
   * preview: only a message the merchant typed (or spoke) is a command. */
  it('a photograph that reads STOP does not opt the merchant out (G-78)', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'STOP', confidence: 0.99 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.G78.STOP'));
    await drain();

    expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
    expect(stubSender.lastText).not.toBe(replies.optedOut().text);
  });

  it('a photograph that reads YES does not confirm the waiting preview (G-78)', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    await post(messagePayload('2348031234567', 'wamid.G78.SAY', 'paid 12000 cash for diesel'));
    await drain();

    const books = async () => {
      const [row] = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ expenses: number; postings: number }>(sql`
            SELECT
              (SELECT count(*)::int FROM expenses WHERE business_id = ${business.id}::uuid) AS expenses,
              (SELECT count(*)::int FROM ledger_transactions WHERE business_id = ${business.id}::uuid) AS postings
          `),
        )),
      ];
      return row!;
    };
    expect(await books()).toEqual({ expenses: 0, postings: 0 });

    arrangePhoto();
    stubOcr.answerWith({ text: 'YES', confidence: 0.99 });
    await post(photoPayload('2348031234567', 'wamid.G78.YES'));
    await drain();

    /* Nothing was posted: a preview is confirmed by a typed yes only. */
    expect(await books()).toEqual({ expenses: 0, postings: 0 });
  });

  /* G-78 (review): words on a photograph are not a correction either. A
   * receipt that says "not returnable" must not silently drop the preview the
   * merchant is about to confirm. */
  it('a photograph whose text reads like a correction leaves the waiting preview alone (G-78)', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    await post(messagePayload('2348031234567', 'wamid.G78.C1', 'paid 12000 cash for diesel'));
    await drain();

    const states = async () =>
      [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ state: string }>(sql`
            SELECT state FROM command_drafts WHERE business_id = ${business.id}::uuid
             ORDER BY insertion_seq`),
        )),
      ].map((r) => r.state);
    expect(await states()).toEqual(['pending']);

    arrangePhoto();
    stubOcr.answerWith({ text: 'Goods sold are not returnable. TOTAL 12,000', confidence: 0.9 });
    await post(photoPayload('2348031234567', 'wamid.G78.C2'));
    await drain();

    expect((await states())[0]).toBe('pending');
  });

  it('a photograph that reads no leaves the waiting preview for a typed yes (G-78)', async () => {
    const business = await seedMerchant('+2348031234567');
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    await post(messagePayload('2348031234567', 'wamid.G78.N1', 'paid 12000 cash for diesel'));
    await drain();

    arrangePhoto();
    stubOcr.answerWith({ text: 'no', confidence: 0.99 });
    await post(photoPayload('2348031234567', 'wamid.G78.N2'));
    await drain();

    await post(messagePayload('2348031234567', 'wamid.G78.N3', 'yes'));
    await drain();
    const [row] = [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM expenses WHERE business_id = ${business.id}::uuid`,
        ),
      )),
    ];
    expect(row!.n).toBe(1);
  });

  it('puts the caption in front of the page, because it says what the page is for', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P6', { caption: 'this is my diesel receipt' }));
    await drain();

    const sentToModel = JSON.stringify(stubTransport.requests.at(-1));
    expect(sentToModel).toContain('this is my diesel receipt');
    expect(sentToModel).toContain('TOTAL 12,000');
  });

  it('does not read, meter or answer twice for a redelivered webhook', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P7'));
    await drain();
    await post(photoPayload('2348031234567', 'wamid.P7'));
    await drain();

    expect(stubOcr.calls).toHaveLength(1);
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  /**
   * Item 7 of the AI hardening plan: a HOSTED read is provider money, and
   * provider money appears in usage_events — costed from the engine's own
   * token counts, tagged with the role the margin view groups by.
   */
  it('puts a hosted read on the books: one ocr_vision row, priced and role-tagged', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({
      text: 'TOTAL 12,000 diesel',
      confidence: null,
      usage: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        tokens: { inputTokens: 1_500, outputTokens: 80 },
      },
    });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P8'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{
        provider: string;
        provider_cost_micros: number;
        meta: Record<string, unknown>;
      }>(sql`
        SELECT provider, provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(row.provider).toBe('anthropic');
    // 1,500 in at $2/MTok + 80 out at $10/MTok = 3,000 + 800 micros.
    expect(Number(row.provider_cost_micros)).toBe(3_800);
    expect(row.meta).toMatchObject({
      role: 'vision',
      model: 'claude-sonnet-5',
      priced: true,
      inputTokens: 1_500,
      outputTokens: 80,
    });
  });

  it('writes no ocr_vision cost row when the reader reports no usage', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    // No usage envelope: nothing to price, so no cost row.
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P9'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    expect([...rows]).toHaveLength(0);
  });

  it('leaves a priced:false trail when a hosted read times out mid-flight', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(new TextExtractionUnavailable('extraction timed out', { maybeBilled: true }));

    await post(photoPayload('2348031234567', 'wamid.P10'));
    await drain();

    /* The merchant's unit went back — Rekoda's timeout, Rekoda's cost — */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);

    /* — and the maybe-billed call is on the books at zero, admitting it. */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(Number(row.provider_cost_micros)).toBe(0);
    expect(row.meta).toMatchObject({ role: 'vision', priced: false });
  });

  /**
   * AI hardening item 4: `AI_DOC_EXTRACTIONS_PER_BUSINESS`, enforced. The
   * daily ceiling is operational, not commercial — the merchant may have
   * monthly scans left, and the refusal must say "today", not "upgrade".
   */
  it('refuses the photograph past the daily ceiling, before any engine is called', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348031234567', 'wamid.P11'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(1);

    await post(photoPayload('2348031234567', 'wamid.P12'));
    await drainWithDailyLimit(1);

    /* The second photograph reached no engine and consumed no monthly unit
     * — the day is full, and the merchant is told when it reopens. */
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many as I can read in one day');
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used).toBe(1);
  });

  it('returns the daily slot when the engine was never reached', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(); // connection refused: nothing spent, nothing billed

    await post(photoPayload('2348031234567', 'wamid.P13'));
    await drainWithDailyLimit(1);
    expect(stubSender.lastText).toContain('could not read that photo');

    /* The slot went back, so the retry fits under the same limit of one. */
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    await post(photoPayload('2348031234567', 'wamid.P14'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(2);
  });
});
