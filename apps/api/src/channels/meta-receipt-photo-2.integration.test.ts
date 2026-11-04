/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: a receipt photo (part 2 of 3). Split by concern from
 * meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { conversationsRepo, createDb, identity, usageRepo, withBusiness, sql } from '@rekoda/db';
import { replies, usagePeriod } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { TextExtractionUnavailable } from '../ai/ocr.js';
import {
  db,
  deps,
  photoPayload,
  post,
  stubOcr,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  A_PHOTOGRAPHED_EXPENSE,
  seedMerchant,
  drain,
  arrangePhoto,
  readsUsed,
  drainWithDailyLimit,
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
  it('keeps the daily slot when the engine billed us for an unreadable page', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.failWith(
      new TextExtractionUnavailable('the page had no legible text', {
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          tokens: { inputTokens: 1_500, outputTokens: 5 },
        },
      }),
    );

    await post(photoPayload('2348031234567', 'wamid.P15'));
    await drainWithDailyLimit(1);
    expect(stubSender.lastText).toContain('could not read that photo');

    /* Provider money was spent reading nothing: a PRICED row exists — */
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ provider_cost_micros: number; meta: Record<string, unknown> }>(sql`
        SELECT provider_cost_micros, meta FROM usage_events
        WHERE business_id = ${business.id}::uuid AND usage_type = 'ocr_vision'
      `),
    );
    const row = [...rows][0]!;
    expect(row).toBeDefined();
    // 1,500 in at $2/MTok + 5 out at $10/MTok = 3,000 + 50 micros.
    expect(Number(row.provider_cost_micros)).toBe(3_050);
    expect(row.meta).toMatchObject({ role: 'vision', priced: true });

    /* — and the day of one stays spent: the ceiling bounds spend, not
     * success, so the next photograph is refused without an engine call. */
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    await post(photoPayload('2348031234567', 'wamid.P16'));
    await drainWithDailyLimit(1);
    expect(stubOcr.calls).toHaveLength(1);
    expect(stubSender.lastText).toContain('as many as I can read in one day');

    /* The merchant's own monthly unit went back both times: Rekoda's
     * engine trouble is never their bill. */
    const period = usagePeriod(new Date());
    const usage = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENTS_UNDERSTOOD')?.used ?? 0).toBe(0);
  });

  it('does not double-charge the daily ceiling for a redelivered webhook', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    /* The same wamid twice: idempotency stops the duplicate before any
     * meter, so a limit of one still has room for nothing — but the FIRST
     * delivery went through and the duplicate consumed no second slot. */
    await post(photoPayload('2348031234567', 'wamid.P17'));
    await drainWithDailyLimit(2);
    await post(photoPayload('2348031234567', 'wamid.P17'));
    await drainWithDailyLimit(2);
    expect(stubOcr.calls).toHaveLength(1);

    /* Room for exactly one more under the limit of two proves the
     * duplicate never reserved. */
    await post(photoPayload('2348031234567', 'wamid.P18'));
    await drainWithDailyLimit(2);
    expect(stubOcr.calls).toHaveLength(2);
  });

  it('answers a platform-full document day as busy, not as the merchant`s limit', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'should never be reached', confidence: 1 });

    await post(photoPayload('2348031234567', 'wamid.P40'));
    const runner = buildRunner(workerDb, db, {
      ...deps,
      config: { ...deps.config, aiDocExtractionsGlobalPerDay: 0 },
    });
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubOcr.calls).toHaveLength(0);
    /* Rekoda's busy day, not the merchant's ceiling: no "midnight". */
    expect(stubSender.lastText).not.toContain('as many as I can read in one day');
  });

  /**
   * The classifier gate (AI hardening item 1): the ONE place a cheap read
   * avoids expensive ones. Confident junk skips the interpreter entirely;
   * anything less proceeds as if no classifier existed.
   */
  it('lets the classifier stop a junk page before the interpreter is paid for', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'when the beat drops and nobody is ready', confidence: 0.9 });
    stubTransport.script({
      toolInput: { type: 'junk' },
      usage: { inputTokens: 400, outputTokens: 12 },
      stopReason: 'tool_use',
    });

    await post(photoPayload('2348031234567', 'wamid.P20'));
    await drain();

    /* ONE model call — the classifier — and the honest sentence. */
    expect(stubTransport.requests).toHaveLength(1);
    expect(stubTransport.requests[0]!.toolName).toBe('classify_document');
    expect(stubSender.lastText).toContain('does not look like a receipt');

    /* The merchant's monthly message unit was never consumed: being told a
     * poster is a poster is not a bookkeeping action they paid for. */
    const period = usagePeriod(new Date());
    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(rows.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  /**
   * Dual extraction end to end (AI hardening item 9): a photographed
   * document worth ₦750,000 is read twice, and when the readers disagree
   * on money the merchant gets the review sentence and NO draft exists to
   * say yes to.
   */
  it('blocks a high-value extraction disagreement from ever becoming a draft', async () => {
    const business = await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'INVOICE generator diesel 750,000', confidence: 0.9 });
    const bigExpense = { ...A_PHOTOGRAPHED_EXPENSE, amount: 750_000 };
    stubTransport.script(
      // The classifier's turn: not junk, proceed.
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      // The interpreter's reading.
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );
    // The INDEPENDENT reader disagrees on the amount by ₦90,000.
    const verifierTransport = new StubTransport([
      {
        toolInput: { command: { ...bigExpense, amount: 660_000 } },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    ]);
    const dualConfig = { ...deps.config, aiModelVisionVerifier: 'gpt-test-verifier' };
    const dualDeps = {
      ...deps,
      config: dualConfig,
      interpreter: new Interpreter(db, dualConfig, stubTransport, verifierTransport),
    };

    await post(photoPayload('2348031234567', 'wamid.P30'));
    const runner = buildRunner(workerDb, db, dualDeps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(verifierTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).toContain('do not agree about the amount');
    expect(stubSender.lastText).toContain('not recorded anything');
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(0);
  });

  it('previews normally when both high-value readings agree', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'INVOICE generator diesel 750,000', confidence: 0.9 });
    const bigExpense = { ...A_PHOTOGRAPHED_EXPENSE, amount: 750_000 };
    stubTransport.script(
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );
    const verifierTransport = new StubTransport([
      {
        toolInput: { command: bigExpense },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    ]);
    const dualConfig = { ...deps.config, aiModelVisionVerifier: 'gpt-test-verifier' };
    const dualDeps = {
      ...deps,
      config: dualConfig,
      interpreter: new Interpreter(db, dualConfig, stubTransport, verifierTransport),
    };

    await post(photoPayload('2348031234567', 'wamid.P31'));
    const runner = buildRunner(workerDb, db, dualDeps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(verifierTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  it('proceeds to the interpreter when the classifier is anything but sure', async () => {
    await seedMerchant('+2348031234567');
    arrangePhoto();
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.script(
      {
        toolInput: { type: 'unsure' },
        usage: { inputTokens: 400, outputTokens: 12 },
        stopReason: 'tool_use',
      },
      {
        toolInput: { command: A_PHOTOGRAPHED_EXPENSE },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
    );

    await post(photoPayload('2348031234567', 'wamid.P21'));
    await drain();

    /* Classifier first, interpreter second — fail open, never a blocker. */
    expect(stubTransport.requests).toHaveLength(2);
    expect(stubTransport.requests[0]!.toolName).toBe('classify_document');
    expect(stubTransport.requests[1]!.toolName).toBe('record_business_command');
    expect(stubSender.lastText).toContain('Reply *yes*');
  });

  /**
   * A2, the probe the fix queue gated R5 on: does a retried media job buy a
   * second AI call and a second billed unit?
   *
   * The mechanism worth checking is specific. The runner makes the handler
   * and `markDone` ONE transaction, so a throw rolls back everything the
   * handler wrote — including the row that records the message as seen. But
   * the meter deliberately runs on its OWN connection, because a counter must
   * not be held open across a network call. If those two facts combine badly,
   * a job that fails after the engine has read the page would leave the unit
   * spent and the guard gone, and the retry would read and bill again.
   */
  describe('a retry must not buy a second reading (A2)', () => {
    it('reads once and bills once, however many passes the runner makes', async () => {
      const business = await seedMerchant('+2348031234599');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });

      await post(photoPayload('2348031234599', 'wamid.A2.ONCE'));

      const runner = buildRunner(workerDb, db, deps);
      for (let pass = 0; pass < 5; pass += 1) await runner.runOnce();

      expect(stubOcr.calls).toHaveLength(1);
      expect(await readsUsed(business.id)).toBe(1);
    });

    it('does not read or bill twice when Meta redelivers the same message', async () => {
      const business = await seedMerchant('+2348031234598');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });

      /* Same wamid, twice on the wire, as a provider retry looks. */
      await post(photoPayload('2348031234598', 'wamid.A2.REDELIVERED'));
      await post(photoPayload('2348031234598', 'wamid.A2.REDELIVERED'));
      await drain();

      expect(stubOcr.calls).toHaveLength(1);
      expect(await readsUsed(business.id)).toBe(1);
    });

    it('does not read or bill twice when the job fails AFTER the engine answered', async () => {
      const business = await seedMerchant('+2348031234597');
      arrangePhoto();
      stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
      /* The send is the last thing the handler does, so failing it fails the
       * job with the reading already paid for. This is the shape the audit
       * suspected, and the only one where the meter's own connection could
       * outlive the rolled-back guard. */
      stubSender.failWith();

      await post(photoPayload('2348031234597', 'wamid.A2.LATE_FAILURE'));
      await drain();

      /* The first pass read the page and billed for it, then failed on the
       * send. The job is not done; it is pending again behind a backoff. */
      expect({ reads: stubOcr.calls.length, billed: await readsUsed(business.id) }).toEqual({
        reads: 1,
        billed: 1,
      });

      /* Bring the retry forward, which is the whole point. `drain` alone
       * never reaches it, and a probe that stops at the line above proves
       * nothing about retries at all. */
      await db.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state = 'pending'`,
      );
      stubSender.reset();
      await drain();

      /* The retry may legitimately re-send the reply. It must not re-read the
       * photograph or bill a second unit: the engine is what costs money. */
      expect({ reads: stubOcr.calls.length, billed: await readsUsed(business.id) }).toEqual({
        reads: 1,
        billed: 1,
      });
    });
  });

  /* Final review B on a1e54e3: a failed WhatsApp send is swallowed and
   * retries nothing, so the A2 probe above never re-ran the job. A real
   * retry (the reply's usage row failing once) must still bill the page
   * once. */
  /* Final review B on 8816a40: a photo refused at the allowance and then
   * retried is metered again, not read for free. */
  it('does not read a photo for free on the retry of an allowance refusal', async () => {
    const business = await seedMerchant('+2348031234592');
    arrangePhoto();
    stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS photo_full_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION photo_full_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('photo_full_once') = 1 THEN
            RAISE EXCEPTION 'photo_full: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER photo_full_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION photo_full_fail_once()`);

      await ownerDb.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${business.id}::uuid, ${usageRepo.TRIAL_PERIOD}, 'DOCUMENTS_UNDERSTOOD', 100000)`);
      await post(photoPayload('2348031234592', 'wamid.P.FULL_RETRY'));
      await drain();
      await ownerDb.execute(
        sql`UPDATE jobs SET run_at = now() - interval '1 minute'
             WHERE business_id = ${business.id}::uuid AND state <> 'done'`,
      );
      await drain();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS photo_full_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS photo_full_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS photo_full_once`);
      await close();
    }
    expect(stubOcr.calls).toHaveLength(0);
    expect(await readsUsed(business.id)).toBe(100000);
  });

  it('bills a photo once across a real job retry (G-57 final review B)', async () => {
    const business = await seedMerchant('+2348031234595');
    arrangePhoto();
    stubOcr.answerWith({ text: 'DIESEL 12,000', confidence: 0.95 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS photo_retry_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION photo_retry_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('photo_retry_once') = 1 THEN
            RAISE EXCEPTION 'photo retry: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER photo_retry_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION photo_retry_fail_once()`);

      await post(photoPayload('2348031234595', 'wamid.P.LATE_FAILURE'));
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
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS photo_retry_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS photo_retry_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS photo_retry_once`);
      await close();
    }
    expect(await readsUsed(business.id)).toBe(1);
  });

  /* G-57, OWN-25: a photograph only ever becomes a write today, so a member
   * who may not write is refused before the image is fetched, read,
   * classified or metered. No media is arranged: had the handler fetched,
   * the reply would be the could-not-read one. */
  it('refuses a view-only member`s photo before fetching, reading or metering it (G-57)', async () => {
    const business = await seedMerchant('+2348031234567');
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    stubOcr.answerWith({ text: 'TOTAL 12,000 diesel', confidence: 0.9 });
    stubTransport.replyWith(A_PHOTOGRAPHED_EXPENSE);

    await post(photoPayload('2348039990001', 'wamid.P-G57'));
    await drain();

    expect(stubSender.lastText).toBe(replies.viewOnlyPhoto().text);
    expect(stubOcr.calls).toHaveLength(0);
    expect(stubTransport.requests).toHaveLength(0);
    expect(await g57Footprint(business.id)).toEqual(NOTHING_TOUCHED);
  });
});
