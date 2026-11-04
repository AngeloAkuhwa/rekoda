/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a voice note (part 2 of 2). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { usageRepo, withBusiness, sql } from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { TranscriptionUnavailable } from '../ai/stt.js';
import { registerTranscriptionPrice } from '@rekoda/core';
import {
  db,
  deps,
  post,
  stubSender,
  stubStt,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_SPOKEN_SALE,
  voicePayload,
  seedMerchant,
  drain,
  arrangeAudio,
  voiceUsed,
  g57Footprint,
  NOTHING_TOUCHED,
  accountantOn,
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
  /**
   * Item 7 of the AI hardening plan: a HOSTED transcription is provider
   * money, and provider money appears in usage_events — priced per minute,
   * role-tagged, carrying BOTH durations: the local probe's (what the
   * allowance reserved on) and the provider's (what the bill runs on).
   */
  it('puts a hosted transcription on the books with both durations', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(17);
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    stubStt.answerWith({
      text: 'Ada bought 3 wigs for 150k',
      seconds: 18, // The provider's own count, one second apart from the probe's.
      confidence: null,
      usage: { provider: 'openai', model: 'whisper-test' },
    });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V30'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{
        provider: string;
        quantity: number;
        provider_cost_micros: number;
        meta: Record<string, unknown>;
      }>(sql`
        SELECT provider, quantity, provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(row.provider).toBe('openai');
    expect(Number(row.quantity)).toBe(18);
    // 18 seconds at $0.006/min: 18 × 6,000 / 60 = 1,800 micros.
    expect(Number(row.provider_cost_micros)).toBe(1_800);
    expect(row.meta).toMatchObject({
      role: 'transcriber',
      model: 'whisper-test',
      priced: true,
      localSeconds: 17,
      providerSeconds: 18,
    });
  });

  it('writes no transcription cost row when the engine reports no usage', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(5);
    // No usage envelope: nothing to price, so no cost row.
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 5, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V31'));
    await drain();

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    expect([...rows]).toHaveLength(0);
  });

  it('leaves a priced:false trail when a hosted transcription times out mid-flight', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(9);
    stubStt.failWith(
      new TranscriptionUnavailable('transcription timed out', { maybeBilled: true }),
    );

    await post(voicePayload('2348031234567', 'wamid.V32'));
    await drain();

    /* The merchant's seconds went back — Rekoda's timeout, Rekoda's cost — */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'VOICE_MINUTES')?.used ?? 0).toBe(0);

    /* — and the maybe-billed call is on the books at zero, admitting it,
     * so reconciliation against the invoice has a row to tie to. */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    expect(Number(row.provider_cost_micros)).toBe(0);
    expect(row.meta).toMatchObject({ role: 'transcriber', priced: false, localSeconds: 9 });
  });

  /**
   * The DAILY voice ceilings (remediation A4): reserved race-safe before
   * the transcriber, distinct from the monthly allowance.
   */
  it('refuses a note past the business voice day, before any transcriber call', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(8);
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 8, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    const runnerWith = (perDay: number) =>
      buildRunner(workerDb, db, {
        ...deps,
        config: { ...deps.config, voiceSecondsPerBusinessPerDay: perDay },
      });

    // 8 seconds fit a 10-second day once.
    await post(voicePayload('2348031234567', 'wamid.V50'));
    let runner = runnerWith(10);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
    expect(stubStt.calls).toHaveLength(1);

    // The second 8-second note does not fit the remaining 2 seconds.
    await post(voicePayload('2348031234567', 'wamid.V51'));
    runner = runnerWith(10);
    worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubStt.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many voice minutes today');
    // And the monthly meter was never touched for the refused note.
    expect(await voiceUsed(business.id)).toBe(8);
  });

  it('answers a platform-full voice day as busy, not as the merchant`s limit', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio(8);
    stubStt.answerWith({ text: 'should never be reached', seconds: 8, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V52'));
    const runner = buildRunner(workerDb, db, {
      ...deps,
      config: { ...deps.config, voiceSecondsGlobalPerDay: 5 },
    });
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).not.toContain('midnight');
  });

  /**
   * The limit's exact edge (AI hardening item 6). A boundary nobody tested
   * drifts: "at most two minutes" and "under two minutes" differ by one
   * voice note, and the merchant sent that note.
   */
  it('accepts a note exactly AT the duration limit', async () => {
    await seedMerchant('+2348031234567');
    arrangeAudio(120); // VOICE_NOTE_MAX_DURATION_SECONDS defaults to 120
    stubStt.answerWith({ text: 'Ada bought 3 wigs for 150k', seconds: 120, confidence: 0.9 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V40'));
    await drain();

    expect(stubStt.calls).toHaveLength(1);
  });

  it('rejects a note ONE second over the limit, reaching no transcriber', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(121);
    stubStt.answerWith({ text: 'should never be reached', seconds: 121, confidence: 1 });

    await post(voicePayload('2348031234567', 'wamid.V41'));
    await drain();

    expect(stubStt.calls).toHaveLength(0);
    expect(stubSender.lastText).toContain('shorter parts');
    expect(await voiceUsed(business.id)).toBe(0);
  });

  it('flags a duration disagreement on the cost row without touching the meter', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangeAudio(10);
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    /* The provider claims triple the container's reading. Neither number is
     * silently preferred: the allowance stays charged on the local one, the
     * cost runs on the provider's, and the row says they disagreed. */
    stubStt.answerWith({
      text: 'Ada bought 3 wigs for 150k',
      seconds: 30,
      confidence: null,
      usage: { provider: 'openai', model: 'whisper-test' },
    });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348031234567', 'wamid.V42'));
    await drain();

    expect(await voiceUsed(business.id)).toBe(10);
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ quantity: number; meta: Record<string, unknown> }>(sql`
        SELECT quantity, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'transcription'
      `),
    );
    const row = [...rows][0]!;
    expect(Number(row.quantity)).toBe(30);
    expect(row.meta).toMatchObject({
      durationMismatch: true,
      localSeconds: 10,
      providerSeconds: 30,
    });
  });

  /* A photo with no media id is not a receipt anybody can read. */
  it('answers an image with no media id with the honest capability line', async () => {
    await seedMerchant('+2348031234567');
    await post({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID' },
                messages: [
                  { id: 'wamid.V8', from: '2348031234567', timestamp: '1', type: 'image' },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();

    expect(stubSender.lastText).toContain('read photos of receipts');
    expect(stubStt.calls).toHaveLength(0);
  });

  /* G-57, OWN-25: a voice note cannot be judged before it is heard, so it is
   * transcribed under the voice policy as before (VOICE_MINUTES, the
   * transcriber). What it then asks decides the rest: a record is refused
   * before any unit of AI_ACTIONS or any model call. */
  it('transcribes a view-only member`s spoken sale, then refuses it before the model (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({ text: 'Record a sale of 50k cash', seconds: 4, confidence: 0.95 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348039990001', 'wamid.V-G57-W'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyRole().text);
    expect(stubStt.calls).toHaveLength(1);
    expect(await voiceUsed(business.id)).toBeGreaterThan(0);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  it('asks a view-only member for a question when the transcript could be either (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({ text: 'Ada 20k', seconds: 2, confidence: 0.95 });
    stubTransport.replyWith(A_SPOKEN_SALE);

    await post(voicePayload('2348039990001', 'wamid.V-G57-U'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubStt.calls).toHaveLength(1);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });

  it('answers a view-only member`s spoken question through the model as before (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    await accountantOn(business.id);
    arrangeAudio();
    stubStt.answerWith({
      text: 'How much did we sell this month?',
      seconds: 3,
      confidence: 0.95,
    });
    stubTransport.replyWith({
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'month',
      periodText: null,
      format: 'chat',
    });

    await post(voicePayload('2348039990001', 'wamid.V-G57-R'));
    await drain();

    expect(stubSender.lastText).not.toBe(replies.viewOnlyRole().text);
    expect(stubSender.lastText).not.toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubTransport.requests.length).toBeGreaterThan(0);
    expect((await g57Footprint(business.id)).ai_actions).toBe(1);
  });
});
