/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a voice note (part 1 of 2). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, createDb, identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { allowanceFor, replies, usagePeriod } from '@rekoda/core';
import { billingRepo } from '@rekoda/db';
import {
  db,
  invoiceCount,
  messagePayload,
  post,
  stubSender,
  stubStt,
  stubTransport,
  urls,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import {
  A_SPOKEN_SALE,
  voicePayload,
  seedMerchant,
  drain,
  arrangeAudio,
  voiceUsed,
  unitUsed,
} from './meta-voice-note.fixtures.js';

useMetaWebhookHarness();

/**
 * A voice note, end to end (ADR 0032).
 *
 * The claim that matters most here is a NEGATIVE one: the audio is fetched,
 * handed to the ONE configured transcriber, and dropped. "Rekoda does not
 * keep the audio" is a promise made out loud on the privacy page, and the
 * only way it stays true is if there is nowhere for the audio to persist.
 */
describe('a voice note', () => {
  /** Move a business onto a plan, through the repository that owns the write. */
  async function moveToPlan(businessId: string, plan: 'chat' | 'integrate' | 'complete') {
    await billingRepo.setPlan(db, {
      businessId,
      plan,
      expiresAt: null,
      actor: 'operator:test-plan',
    });
  }

  it('a voice note that says a natural opt-out opts out as a typed STOP does, with no model (G-80)', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'abeg stop', seconds: 2, confidence: 0.95 });

    await post(voicePayload('2348031234567', 'wamid.V-G80'));
    await drain();

    expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();
    expect(stubSender.lastText).toBe(replies.optedOut().text);
    expect(stubTransport.requests).toHaveLength(0);
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  /**
   * Spec §4.3 rule 2: nothing that costs money at a provider is dispatched
   * before authorisation. An Integrate-only merchant holds the customer-side
   * half of the product and not this one, and the transcriber is a bill.
   */
  it('never reaches the transcriber for a merchant whose plan has no Chat', async () => {
    const business = await seedMerchant('+2348031234567');
    await moveToPlan(business.id, 'integrate');
    arrangeAudio();
    stubStt.answerWith({ text: 'should never be reached', seconds: 9, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V20'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(await voiceUsed(business.id)).toBe(0);
    expect(stubSender.lastText).toContain('part of the Chat plan');
  });

  /**
   * Spec §4.3 rule 3, the case that used to leak: metering after the work
   * meant an exhausted merchant could send Rekoda's transcription budget a
   * voice note at a time and only be refused afterwards.
   */
  it('never reaches the transcriber once the voice allowance is gone', async () => {
    const business = await seedMerchant('+2348031234567');
    const allowance = allowanceFor('trial', 'VOICE_MINUTES');
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'VOICE_MINUTES',
        allowance,
        allowance,
      ),
    );
    arrangeAudio();
    stubStt.answerWith({ text: 'should never be reached', seconds: 9, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V21'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(await voiceUsed(business.id)).toBe(allowance);
    expect(stubSender.lastText).toContain('seconds of voice notes');
  });

  it('turns speech into the same preview a typed sentence would get', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.94 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V1'));
    await drain();

    /* The SAME conversation gate a typed message hits. Voice is an input
     * method, not a second product with its own rules. */
    expect(stubSender.lastText).toContain('Reply *yes*');
    expect(stubSender.lastText).toContain('₦150,000');
  });

  it('confirms into a real invoice, through the ordinary yes', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V2'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.V2-yes', 'yes'));
    await drain();

    expect(await invoiceCount(business.id)).toBe(1);
  });

  /**
   * The promise, asserted. The transcript is kept because it is what the
   * merchant said and the books are built from it; the audio is not, because
   * a recording of somebody's voice is the most identifying thing they can
   * send and we said it would not be kept.
   */
  it('keeps the transcript and never the audio', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(9);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V3'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id, 20),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('OggS');
    expect(dump).not.toContain('secret-voice');
    // The audio went to the configured transcriber and nowhere else.
    expect(stubStt.calls).toHaveLength(1);
    expect(stubStt.calls[0]?.mimeType).toBe('audio/ogg');
  });

  /**
   * The AUDIO is the source of truth for the length, not the transcriber.
   *
   * It used to be the transcriber's number, which meant the merchant could only
   * be charged after the spend. Reading it from the container first is what
   * lets the charge happen before the provider is called, and the number is
   * the same number either way: the audio says seventeen seconds and
   * seventeen is what is taken.
   */
  it('meters the seconds the AUDIO says, before the transcriber is called', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(17);
    /* Deliberately disagrees with the audio. The container wins. */
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 900, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V4'));
    await drain();

    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(17);
  });

  /**
   * The commercial limit, enforced where it protects money.
   *
   * `VOICE_NOTE_MAX_DURATION_SECONDS` is a rejection limit, not a budget: a
   * note past it never reaches a transcription provider at all. That is the
   * whole reason it exists, and the reason it is checked here rather than
   * after a bill has been incurred.
   */
  it('refuses a note past the limit without calling the transcriber', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(300);
    stubStt.answerWith({ text: 'should never be reached', seconds: 300, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V30'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('shorter parts');
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  /* Exactly at the limit is inside it, which is what a limit means. */
  it('accepts a note exactly at the limit', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(120);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 120, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V31'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(120);
  });

  /**
   * Unreadable is not zero and not "send it anyway". Nothing was measured, so
   * nothing is metered and no provider is called; the merchant is asked to
   * send it again, which is a real recovery rather than a polite refusal.
   */
  it('asks for the note again when the audio cannot be measured', async () => {
    const business = await seedMerchant('+2348031234567');
    stubSender.media.set('media-1', {
      bytes: Buffer.from('this is not an ogg stream'),
      mimeType: 'audio/ogg',
    });
    stubStt.answerWith({ text: 'should never be reached', seconds: 4, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V32'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('record it again');
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  /* Our failure, so it costs the merchant nothing and says what to do. */
  it('answers honestly when the transcriber cannot be reached', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.failWith();

    await post(voicePayload('2348031234567', 'wamid.V5'));
    await drain();

    expect(stubSender.lastText).toContain('could not listen to that voice note');
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);
  });

  it('answers honestly when the audio cannot be fetched', async () => {
    await seedMerchant('+2348031234567');
    // No media arranged: the provider has nothing for this id.
    stubStt.answerWith({ text: 'should never be reached', seconds: 3, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V6'));
    await drain();

    expect(stubSender.lastText).toContain('could not listen to that voice note');
    expect(stubStt.calls).toHaveLength(0);
  });

  it('does not transcribe, meter or answer twice for a redelivered webhook', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V7'));
    await drain();
    await post(voicePayload('2348031234567', 'wamid.V7'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'VOICE_MINUTES')?.used).toBe(5);
  });

  /* Final review B on a1e54e3: the photo path already reads and bills
   * once across a job retry (A2); a voice note must too, or a reply that
   * fails after the transcriber answered charges the seconds again. */
  it('does not transcribe or meter twice when the job fails AFTER the transcriber answered', async () => {
    const business = await seedMerchant('+2348031234596');
    arrangeAudio();
    stubStt.answerWith({ text: 'how much did we sell this month', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });

    /* A failed WhatsApp send is swallowed and retries nothing, so the job is
     * made to fail where a real retry comes from: the reply's own usage row,
     * once, after the transcriber has answered. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS voice_retry_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION voice_retry_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('voice_retry_once') = 1 THEN
            RAISE EXCEPTION 'voice retry: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER voice_retry_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION voice_retry_fail_once()`);

      await post(voicePayload('2348031234596', 'wamid.V.LATE_FAILURE'));
      await drain();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();

      const [job] = await ownerDb.execute<{ attempts: number; state: string }>(sql`
        SELECT attempts, state FROM jobs
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect({ attempts: Number(job?.attempts), state: job?.state }).toEqual({
        attempts: 2,
        state: 'done',
      });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS voice_retry_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS voice_retry_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS voice_retry_once`);
      await close();
    }
    /* The note's seconds are taken once, however many passes the job makes. */
    expect(await voiceUsed(business.id)).toBe(5);
  });

  /* Final review B on 8816a40: the seconds a note holds go back when a
   * retry finds the transcriber down, whichever attempt took them. */
  it('gives the seconds back when a retry finds the transcriber down', async () => {
    const business = await seedMerchant('+2348031234593');
    arrangeAudio();
    stubStt.answerWith({ text: 'how much did we sell this month', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS voice_down_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION voice_down_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('voice_down_once') = 1 THEN
            RAISE EXCEPTION 'voice_down: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER voice_down_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION voice_down_fail_once()`);

      await post(voicePayload('2348031234593', 'wamid.V.RETRY_DOWN'));
      await drain();
      expect(await voiceUsed(business.id)).toBe(5);
      stubStt.failWith();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS voice_down_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS voice_down_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS voice_down_once`);
      await close();
    }
    /* The note was never answered: its seconds are back. */
    expect(await voiceUsed(business.id)).toBe(0);
  });

  /* Final exact-head review: a job reclaimed after it answered and committed
   * runs again and finds the note already recorded. That note delivered, so
   * what it holds stays charged; only "nothing delivered" gives units back. */
  it('a second run of a note already answered keeps its seconds and its message unit', async () => {
    const business = await seedMerchant('+2348031234594');
    arrangeAudio();
    stubStt.answerWith({ text: 'how much did we sell this month', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });
    await post(voicePayload('2348031234594', 'wamid.V.RERUN'));
    await drain();
    expect(await voiceUsed(business.id)).toBe(5);
    expect(await unitUsed(business.id, 'AI_ACTIONS')).toBe(1);

    /* The runner reclaims the finished job, as a stalled-lock sweep can. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`
        UPDATE jobs SET state = 'pending', run_at = now() - interval '1 minute'
         WHERE business_id = ${business.id}::uuid AND kind = 'inbound.message'`);
    } finally {
      await close();
    }
    await drain();

    expect(stubStt.calls).toHaveLength(1);
    expect(await voiceUsed(business.id)).toBe(5);
    expect(await unitUsed(business.id, 'AI_ACTIONS')).toBe(1);
  });

  /* Codex P2 on 5804882: a spoken "yes" reserves its document unit on
   * attempt 1; if that attempt rolls back and the retry cannot hear the note,
   * nothing was confirmed, so the unit goes back with the seconds. */
  it('a spoken yes whose retry cannot be transcribed gives back the document unit too', async () => {
    const business = await seedMerchant('+2348031234592');
    stubTransport.replyWith(A_SPOKEN_SALE);
    await post(messagePayload('2348031234592', 'wamid.V.YES-SALE', 'sold Ada 3 wigs for 150k'));
    await drain();

    arrangeAudio(1);
    stubStt.answerWith({ text: 'yes', seconds: 1, confidence: 0.95 });
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS voice_yes_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION voice_yes_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('voice_yes_once') = 1 THEN RAISE EXCEPTION 'voice yes: first issue fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER voice_yes_fail_once BEFORE INSERT ON invoices
          FOR EACH ROW EXECUTE FUNCTION voice_yes_fail_once()`);

      await post(voicePayload('2348031234592', 'wamid.V.YES'));
      await drain();
      expect(await unitUsed(business.id, 'DOCUMENT_GENERATION')).toBe(1);

      stubStt.failWith();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS voice_yes_fail_once ON invoices`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS voice_yes_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS voice_yes_once`);
      await close();
    }

    const [row] = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM invoices WHERE business_id = ${business.id}::uuid`,
      ),
    );
    expect(Number(row?.n)).toBe(0);
    expect(await unitUsed(business.id, 'DOCUMENT_GENERATION')).toBe(0);
    expect(await voiceUsed(business.id)).toBe(0);
  });
});
