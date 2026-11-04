/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/ops/jobs.integration.test.ts` proves the queue's SQL. These suites
 * prove the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
// The job queue and its handlers, end to end. Split by concern across jobs*.integration.test.ts; the shared setup is in
// jobs.fixtures.ts.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDb, sql, withBusiness } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { storedEventId } from '@rekoda/db/testing';
import { buildRunner } from './jobs.module.js';
import { ProviderUnreachable } from '../ai/transport.js';
import { sealPayload } from '../privacy/payload-vault.js';
import {
  appDb,
  config,
  deps,
  enqueue,
  recordPinned,
  seedBusiness,
  stubSender,
  stubTransport,
  urls,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';
import { memberOf, saysOverChat, A_SALE, A_SALES_QUESTION } from './jobs-chat-roles.fixtures.js';

useJobsHarness();

describe('the chat surface enforces roles', () => {
  /**
   * What a refused message must leave untouched (G-57).
   *
   * Kept identical to the copy in jobs-chat-roles-1.integration.test.ts,
   * jobs-chat-roles-2.integration.test.ts. It uses the owner connection, which stays out of
   * shared fixture modules. Change them together.
   */
  async function footprint(businessId: string): Promise<Record<string, number>> {
    const [row] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          /* Every usage and provider-cost row but the reply's own send. */
          (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
            AND usage_type <> 'SERVICE_MESSAGE') AS usage_events,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings,
          (SELECT count(*) FROM inventory_movements
            WHERE business_id = ${businessId}::uuid) AS stock_moves`),
    );
    /* Provider cost is platform data the app role cannot read: as the owner. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      const [cost] = await ownerDb.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM platform_cost_events WHERE business_id = ${businessId}::uuid`);
      return {
        ...Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)])),
        cost_events: Number(cost!.n),
      };
    } finally {
      await close();
    }
  }

  /**
   * L, M: a job that fails after deciding is retried, and the retry must not
   * charge again. The reply's service-message row fails once, so attempt 1
   * rolls back after its decision; the retry runs with `retrying`.
   *
   * Kept identical to the copy in jobs-chat-roles-2.integration.test.ts. It uses the owner
   * connection, which stays out of shared fixture modules. Change them together.
   */
  async function withFirstReplyFailing(businessId: string, run: () => Promise<void>) {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' THEN
            IF nextval('g57_once') = 1 THEN
              RAISE EXCEPTION 'g57: first reply fails';
            END IF;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_fail_once()`);
      await run();
      /* The failed attempt was rescheduled; make it due and run it. */
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_once`);
      await close();
    }
  }

  /* Owner decision on G-57, with Codex: a unit taken just before midnight
   * at a month's end (Lagos time) and refused on a retry after it goes back
   * to THAT month, exactly once, and the new month is never touched. */
  it('refunds the original month once when a retry crosses the month boundary (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Month Ltd', '+2348140010047');
    /* A paid plan meters by calendar month, which is what this test is about. */
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE businesses SET plan = 'complete' WHERE id = ${businessId}::uuid`),
    );
    await memberOf(businessId, '+2348140010048', 'accountant');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    const used = async (period: string) => {
      const [row] = await ownerDb.execute<{ used: number }>(sql`
        SELECT COALESCE(sum(used), 0)::int AS used FROM usage_counters
         WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS' AND period = ${period}`);
      return Number(row?.used ?? 0);
    };
    try {
      /* Other messages already used units in both months. */
      await ownerDb.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${businessId}::uuid, '2026-09', 'AI_ACTIONS', 1),
               (${businessId}::uuid, '2026-10', 'AI_ACTIONS', 2)`);
      /* The first reply fails once, so the job really retries. */
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_month_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_month_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('g57_month_once') = 1 THEN
            RAISE EXCEPTION 'g57: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_month_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_month_fail_once()`);

      /* A question the model reads as a sale: refused after the model. */
      stubTransport.replyWith(A_SALE);
      const waId = '2348140010048';
      const externalId = `wamid.${randomBytes(8).toString('hex')}`;
      const body = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                  contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                  messages: [
                    {
                      id: externalId,
                      from: waId,
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: 'how much did we sell this month?' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const recorded = await recordPinned({
        provider: 'meta',
        eventType: 'message.text',
        externalId,
        payload: sealPayload(body, config.vaultKey, 'meta', externalId),
        businessId,
      });
      /* It arrived at 23:59:30 on 30 September, Lagos time (UTC+1). */
      await ownerDb.execute(sql`
        UPDATE external_events SET created_at = '2026-09-30T22:59:30Z'
         WHERE id = ${storedEventId(recorded)}::uuid`);
      await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });

      vi.useFakeTimers({ toFake: ['Date'] });
      /* Attempt 1, still September: takes the unit, then its reply fails. */
      vi.setSystemTime(new Date('2026-09-30T22:59:50Z'));
      await buildRunner(workerDb, appDb, deps).runOnce();
      expect(await used('2026-09')).toBe(2);
      /* The retry, after midnight: now October in Lagos. */
      vi.setSystemTime(new Date('2026-09-30T23:00:30Z'));
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();

      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
      expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.viewOnlyRole().text);
      /* September's unit back, once; October untouched. */
      expect({ september: await used('2026-09'), october: await used('2026-10') }).toEqual({
        september: 1,
        october: 2,
      });
    } finally {
      vi.useRealTimers();
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_month_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_month_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_month_once`);
      await close();
    }
  });

  /* Final review B on 5f98eec: the non-command refund was skipped on a
   * retry. A question whose first reply failed, and whose retry then finds
   * the provider down, delivered nothing, so it must cost nothing. */
  it('refunds a question whose retry finds the provider down (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Retry Down Ltd', '+2348140010045');
    await memberOf(businessId, '+2348140010046', 'accountant');
    stubTransport.script(
      {
        toolInput: { command: A_SALES_QUESTION },
        usage: { inputTokens: 1_800, outputTokens: 120 },
        stopReason: 'tool_use',
      },
      new ProviderUnreachable('stub provider down'),
    );

    await withFirstReplyFailing(businessId, async () => {
      await saysOverChat(businessId, '+2348140010046', 'how much did we sell this month?');
    });
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.busyRightNow().text);
    expect((await footprint(businessId)).ai_actions).toBe(0);
  });

  it('answers a QUESTION from that same accountant, because reads are theirs', async () => {
    const businessId = await seedBusiness('Role Gate Reads Ltd', '+2348140010003');
    await memberOf(businessId, '+2348140010004', 'accountant');

    // "who owes me" is deterministic: no model, no draft, just rows.
    const answer = await saysOverChat(businessId, '+2348140010004', 'who owes me');
    expect(answer).not.toContain('view only');
    expect(answer.length).toBeGreaterThan(0);
  });

  it('refuses an accountant yes, so they cannot confirm the owner draft either', async () => {
    const businessId = await seedBusiness('Role Gate Yes Ltd', '+2348140010005');
    await memberOf(businessId, '+2348140010006', 'accountant');

    const answer = await saysOverChat(businessId, '+2348140010006', 'yes');
    expect(answer).toContain('view only');
  });

  it('lets a delegate through the same gate', async () => {
    const businessId = await seedBusiness('Role Gate Delegate Ltd', '+2348140010007');
    await memberOf(businessId, '+2348140010008', 'delegate');

    // Nothing is pending, so the reply is about the missing draft, which
    // means the role gate did not fire.
    const answer = await saysOverChat(businessId, '+2348140010008', 'yes');
    expect(answer).not.toContain('view only');
  });
});
