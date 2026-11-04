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
import { describe, expect, it } from 'vitest';
import { createDb, sql, usageRepo, withBusiness } from '@rekoda/db';
import { replies } from '@rekoda/core';
import { buildRunner } from './jobs.module.js';
import {
  appDb,
  deps,
  seedBusiness,
  stubSender,
  stubTransport,
  urls,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';
import {
  memberOf,
  saysOverChat,
  ZERO,
  A_SALE,
  A_SALES_QUESTION,
} from './jobs-chat-roles.fixtures.js';

useJobsHarness();

describe('the chat surface enforces roles', () => {
  /**
   * What a refused message must leave untouched (G-57).
   *
   * Kept identical to the copy in jobs-chat-roles-1.integration.test.ts,
   * jobs-chat-roles-3.integration.test.ts. It uses the owner connection, which stays out of
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

  // Kept identical to the copy in jobs-chat-roles-1.integration.test.ts. It calls footprint, which uses
  // the owner connection, so it stays beside it. Change them together.
  const seen = async (businessId: string) => ({
    modelCalls: stubTransport.requests.length,
    ...(await footprint(businessId)),
  });

  /**
   * L, M: a job that fails after deciding is retried, and the retry must not
   * charge again. The reply's service-message row fails once, so attempt 1
   * rolls back after its decision; the retry runs with `retrying`.
   *
   * Kept identical to the copy in jobs-chat-roles-3.integration.test.ts. It uses the owner
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

  it('charges nothing on the retry of an early refusal (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Retry Ltd', '+2348140010039');
    await memberOf(businessId, '+2348140010040', 'accountant');
    stubTransport.replyWith(A_SALE);

    await withFirstReplyFailing(businessId, async () => {
      await saysOverChat(businessId, '+2348140010040', 'record a sale of 50k cash');
    });
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.viewOnlyRole().text);
    expect(await seen(businessId)).toEqual(ZERO);
  });

  /* G-79: the yes refuses a view-only member; the no and the cancel must too.
   * Otherwise an accountant's "no" supersedes the owner's pending preview and
   * the owner's later yes confirms nothing. */
  it.each(['no', 'cancel'])(
    'a view-only member`s "%s" leaves the owner`s pending preview alone (G-79)',
    async (word) => {
      const businessId = await seedBusiness(`Role Deny ${word} Ltd`, '+2348140010051');
      const accountant = word === 'no' ? '+2348140010052' : '+2348140010053';
      await memberOf(businessId, accountant, 'accountant');
      stubTransport.replyWith(A_SALE);
      await saysOverChat(businessId, '+2348140010051', 'sold rice 20k cash');
      const pending = () =>
        withBusiness(appDb, businessId, async (tx) => {
          const [row] = await tx.execute<{ n: string }>(sql`
            SELECT count(*) AS n FROM command_drafts
            WHERE business_id = ${businessId}::uuid AND state = 'pending'`);
          return Number(row!.n);
        });
      expect(await pending()).toBe(1);

      expect(await saysOverChat(businessId, accountant, word)).toBe(replies.viewOnlyRole().text);
      expect(await pending()).toBe(1);
    },
  );

  /* G-79: the correction path (CG5) also supersedes the pending draft, so a
   * view-only member's question that merely opens like a correction must not
   * reach it. */
  it('a view-only member`s question that opens like a correction leaves the owner`s preview (G-79)', async () => {
    const businessId = await seedBusiness('Role Correction Ltd', '+2348140010061');
    await memberOf(businessId, '+2348140010062', 'accountant');
    stubTransport.replyWith(A_SALE);
    await saysOverChat(businessId, '+2348140010061', 'sold rice 20k cash');
    const pending = () =>
      withBusiness(appDb, businessId, async (tx) => {
        const [row] = await tx.execute<{ n: string }>(sql`
          SELECT count(*) AS n FROM command_drafts
          WHERE business_id = ${businessId}::uuid AND state = 'pending'`);
        return Number(row!.n);
      });
    expect(await pending()).toBe(1);

    stubTransport.replyWith(A_SALES_QUESTION);
    await saysOverChat(businessId, '+2348140010062', 'no wait, how much did we sell this month?');
    /* The owner's own draft, not a count: a question may store a draft of its
     * own, which would hide a superseded sale behind a count of one. */
    const [owners] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ superseded: string }>(sql`
        SELECT count(*) AS superseded FROM command_drafts
        WHERE business_id = ${businessId}::uuid AND state = 'superseded'`),
    );
    expect(Number(owners!.superseded)).toBe(0);
  });

  it('does not charge twice for a question whose reply failed once (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Retry Read Ltd', '+2348140010041');
    await memberOf(businessId, '+2348140010042', 'accountant');
    stubTransport.replyWith(A_SALES_QUESTION);

    await withFirstReplyFailing(businessId, async () => {
      await saysOverChat(businessId, '+2348140010042', 'how much did we sell this month?');
    });
    expect((await footprint(businessId)).ai_actions).toBe(1);
    /* And the retry delivered the answer, not a refusal. */
    const last = stubSender.sent[stubSender.sent.length - 1]?.text ?? '';
    expect(last).not.toBe(replies.viewOnlyRole().text);
    expect(last.length).toBeGreaterThan(0);
  });

  /* Codex P2 on 04a8c8f: the post-model refund runs in its own
   * transaction; if it fails once, the retry must still give the unit back
   * rather than assume attempt 1's refund committed. */
  it('refunds a refused record on the retry when the first refund failed (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Refund Retry Ltd', '+2348140010043');
    await memberOf(businessId, '+2348140010044', 'accountant');
    stubTransport.replyWith(A_SALES_QUESTION);
    await saysOverChat(businessId, '+2348140010043', 'how much did we sell this month?');
    const before = await footprint(businessId);
    expect(before.ai_actions).toBe(1);
    stubTransport.replyWith(A_SALE);

    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_refund_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_refund_fails_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.unit = 'AI_ACTIONS' AND NEW.used < OLD.used THEN
            IF nextval('g57_refund_once') = 1 THEN
              RAISE EXCEPTION 'g57: first refund fails';
            END IF;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_refund_fails_once BEFORE UPDATE ON usage_counters
          FOR EACH ROW EXECUTE FUNCTION g57_refund_fails_once()`);
      await saysOverChat(businessId, '+2348140010044', 'how much did we sell this month?');
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_refund_fails_once ON usage_counters`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_refund_fails_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_refund_once`);
      await close();
    }
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.viewOnlyRole().text);
    const after = await footprint(businessId);
    for (const key of ['ai_actions', 'drafts', 'invoices', 'payments', 'postings', 'stock_moves']) {
      expect(after[key], key).toBe(before[key]);
    }
  });

  /* Final review B on 8816a40: a message refused at the allowance whose
   * reply then failed is metered again on the retry, never sent to the
   * model for free. */
  it('does not call the model for free on the retry of an allowance refusal (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Full Ltd', '+2348140010049');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_full_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_full_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('g57_full_once') = 1 THEN
            RAISE EXCEPTION 'g57_full: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_full_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_full_fail_once()`);

      await ownerDb.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${businessId}::uuid, ${usageRepo.TRIAL_PERIOD}, 'AI_ACTIONS', 100000)`);
      stubTransport.replyWith(A_SALES_QUESTION);
      await saysOverChat(businessId, '+2348140010049', 'how much did we sell this month?');
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_full_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_full_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_full_once`);
      await close();
    }
    expect(stubTransport.requests).toHaveLength(0);
    expect((await footprint(businessId)).ai_actions).toBe(100000);
  });

  /* Codex P2 on 8816a40: a delegate's first attempt took a unit and reached
   * the model, the job failed, and the member was made an accountant before
   * the retry. The retry refuses before the model, and the unit attempt 1
   * took goes back: a refused request consumes nothing. */
  it('gives back the unit when the member is demoted between attempts (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Demoted Ltd', '+2348140010051');
    await memberOf(businessId, '+2348140010052', 'delegate');
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_demote_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_demote_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' AND nextval('g57_demote_once') = 1 THEN
            RAISE EXCEPTION 'g57: first reply fails';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_demote_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_demote_fail_once()`);

      stubTransport.replyWith(A_SALE);
      await saysOverChat(businessId, '+2348140010052', 'Ada 20k');
      expect((await footprint(businessId)).ai_actions).toBe(1);

      await ownerDb.execute(sql`
        UPDATE memberships SET role = 'accountant' WHERE business_id = ${businessId}::uuid
           AND user_id = (SELECT id FROM users WHERE phone = '+2348140010052')`);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_demote_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_demote_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_demote_once`);
      await close();
    }
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(
      replies.viewOnlyAskAQuestion().text,
    );
    expect((await footprint(businessId)).ai_actions).toBe(0);
  });

  /* Final exact-head review on 017d5a8: a delegate's "yes" reserved its
   * document unit, the attempt rolled back, and the member was demoted
   * before the retry. The retry confirms nothing, so the unit goes back. */
  it('gives back the document unit when a yes is refused after a demotion between attempts (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Yes Ltd', '+2348140010053');
    await memberOf(businessId, '+2348140010054', 'delegate');
    stubTransport.replyWith(A_SALE);
    await saysOverChat(businessId, '+2348140010054', 'sold rice 20k cash');
    const documents = async () => {
      const [row] = await withBusiness(appDb, businessId, (tx) =>
        tx.execute<{ used: string }>(sql`
          SELECT COALESCE(sum(used), 0) AS used FROM usage_counters
           WHERE business_id = ${businessId}::uuid AND unit = 'DOCUMENT_GENERATION'`),
      );
      return Number(row?.used);
    };
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_yes_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_yes_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF nextval('g57_yes_once') = 1 THEN RAISE EXCEPTION 'g57_yes: first posting fails'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_yes_fail_once BEFORE INSERT ON ledger_transactions
          FOR EACH ROW EXECUTE FUNCTION g57_yes_fail_once()`);

      await saysOverChat(businessId, '+2348140010054', 'yes');
      expect(await documents()).toBe(1);

      await ownerDb.execute(sql`
        UPDATE memberships SET role = 'accountant' WHERE business_id = ${businessId}::uuid
           AND user_id = (SELECT id FROM users WHERE phone = '+2348140010054')`);
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_yes_fail_once ON ledger_transactions`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_yes_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_yes_once`);
      await close();
    }
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.viewOnlyRole().text);
    expect((await footprint(businessId)).postings).toBe(0);
    expect(await documents()).toBe(0);
  });
});
