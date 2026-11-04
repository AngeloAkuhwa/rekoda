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
import { jobsRepo, schema, sql, withBusiness } from '@rekoda/db';
import { storedEventId } from '@rekoda/db/testing';
import { JobRunner } from './runner.js';
import { buildRunner } from './jobs.module.js';
import { sealPayload } from '../privacy/payload-vault.js';
import {
  appDb,
  arrivesAfterPreview,
  config,
  deps,
  enqueue,
  jobsOf,
  recordPinned,
  seedBusiness,
  stubTransport,
  waitFor,
  workerDb,
  useJobsHarness,
} from './jobs.fixtures.js';

useJobsHarness();

describe('the polling loop with lanes', () => {
  /**
   * SKIP LOCKED makes N lanes take N different jobs by construction; this
   * proves the lanes actually run side by side, because one twenty-second
   * model call stalling every delivery behind it was the whole finding.
   */
  it('runs two jobs at the same time when built with two lanes', async () => {
    const businessId = await seedBusiness('Lanes Ltd', '+2348140030001');
    let inFlight = 0;
    let peak = 0;
    const runner = new JobRunner(workerDb, appDb, { idleMs: 20, concurrency: 2 });
    runner.register('lane.test', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
    });
    await enqueue(businessId, 'lane.test', { n: 1 });
    await enqueue(businessId, 'lane.test', { n: 2 });

    runner.start();
    await waitFor(() => peak >= 2);
    await runner.stop();
    expect(peak).toBe(2);
  });
});

describe('inbound messages for one business never overlap across lanes', () => {
  /**
   * The per-business advisory lock is what keeps the pending-draft
   * read-then-write single-runner. Two messages enqueued together — a sale
   * mention that creates a draft, then "yes" — must serialize so the second
   * sees the first's committed draft and confirms it, even with two lanes.
   * Without the lock the "yes" can run first and find nothing to confirm.
   */
  it('processes a draft then its confirmation in order under two lanes', async () => {
    const businessId = await seedBusiness('Lane Order Ltd', '+2348140040001');
    const waId = '2348140040001';

    function bodyFor(externalId: string, text: string) {
      return {
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
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const first = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.order1',
      payload: sealPayload(
        bodyFor('wamid.order1', 'spent 5k on fuel'),
        config.vaultKey,
        'meta',
        'wamid.order1',
      ),
      businessId,
    });
    const second = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.order2',
      payload: sealPayload(bodyFor('wamid.order2', 'yes'), config.vaultKey, 'meta', 'wamid.order2'),
      businessId,
    });
    await arrivesAfterPreview(businessId, second);
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(first) });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(second) });

    // Two lanes, both draining; the lock is what keeps them in order.
    const runner = buildRunner(workerDb, appDb, deps, { idleMs: 20, concurrency: 2 });
    runner.start();
    const deadline = Date.now() + 8_000;
    for (;;) {
      const jobs = await jobsOf(businessId);
      if (jobs.length >= 2 && jobs.every((j) => j.state === 'done' || j.state === 'dead')) break;
      if (Date.now() > deadline) throw new Error('timed out waiting for both inbound jobs');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runner.stop();

    // The "yes" confirmed the expense the first message drafted: exactly one
    // expense recorded, and no draft left pending.
    const expenses = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.expenses),
    );
    expect(expenses).toHaveLength(1);
    const drafts = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.commandDrafts),
    );
    expect(drafts.every((d) => d.state !== 'pending')).toBe(true);
  });

  /**
   * The lock alone guarantees exclusion, not order. Between claiming a job and
   * taking the business lock there is a window, and a lane holding the LATER
   * message can win the lock while the earlier message's lane is still on its
   * way — "yes" then finds no draft and the conversation silently loses a
   * record. This pins the window open: the draft's job is claimed by a lane
   * that never reaches the lock, so the confirm's lane must notice it is
   * jumping the queue and step back rather than run.
   */
  it('defers the confirm while the draft message is still claimed elsewhere', async () => {
    const businessId = await seedBusiness('Stalled Lane Ltd', '+2348140040002');
    const waId = '2348140040002';

    function bodyFor(externalId: string, text: string) {
      return {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550002', phone_number_id: 'PNID' },
                  contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                  messages: [
                    {
                      id: externalId,
                      from: waId,
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const first = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.stall1',
      payload: sealPayload(
        bodyFor('wamid.stall1', 'spent 5k on fuel'),
        config.vaultKey,
        'meta',
        'wamid.stall1',
      ),
      businessId,
    });
    const second = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.stall2',
      payload: sealPayload(bodyFor('wamid.stall2', 'yes'), config.vaultKey, 'meta', 'wamid.stall2'),
      businessId,
    });
    await arrivesAfterPreview(businessId, second);
    const draftJob = await enqueue(businessId, 'inbound.message', {
      eventId: storedEventId(first),
    });
    const confirmJob = await enqueue(businessId, 'inbound.message', {
      eventId: storedEventId(second),
    });
    if (!draftJob || !confirmJob) throw new Error('both jobs should have enqueued');

    // A lane claims the draft's job — the oldest — and stalls before the lock.
    const stalled = await jobsRepo.claimNext(workerDb, 'stalled-lane');
    expect(stalled?.id).toBe(draftJob.id);

    const runner = buildRunner(workerDb, appDb, deps, { idleMs: 20 });
    runner.start();
    try {
      // The confirm's lane runs, but must NOT process "yes" ahead of the
      // draft: give it long enough to have claimed, then look.
      await new Promise((resolve) => setTimeout(resolve, 700));
      /* The lane claims the confirm, steps back, and claims it again every
       * idle tick: a single sample can land mid-claim (`running`) on a slow
       * machine. Watch for a while: it must be seen stepped back to
       * `pending`, it must never finish, and the wait costs no attempt. */
      let seenPending = false;
      const watchUntil = Date.now() + 3_000;
      while (Date.now() < watchUntil) {
        const now = await jobsOf(businessId);
        const confirm = now.find((j) => j.id === confirmJob.id);
        expect(['pending', 'running']).toContain(confirm?.state);
        // Stepping back is not failing: the wait costs no attempt.
        expect(confirm?.attempts).toBe(0);
        if (confirm?.state === 'pending') {
          seenPending = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seenPending).toBe(true);
      const expensesBefore = await withBusiness(appDb, businessId, (tx) =>
        tx.select().from(schema.expenses),
      );
      expect(expensesBefore).toHaveLength(0);

      // The stalled lane's claim is returned to the queue — the actual
      // crashed-worker recovery, with no grace period — and NOW the pair
      // drains in order.
      await jobsRepo.reclaimStalled(workerDb, 0);
      const deadline = Date.now() + 8_000;
      for (;;) {
        const jobs = await jobsOf(businessId);
        if (jobs.length >= 2 && jobs.every((j) => j.state === 'done' || j.state === 'dead')) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for both inbound jobs');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }

    const expenses = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.expenses),
    );
    expect(expenses).toHaveLength(1);
  });

  /**
   * G-20 (Codex P1): a failed delivery receipt queued BEFORE the merchant's
   * "yes" must unsee its preview first. The lock alone lets the later "yes"
   * win it while the receipt's lane is between claim and lock, and confirm a
   * draft the merchant never received. The inbound job must step back for an
   * older live `delivery.status` job, not only for an older inbound one.
   */
  it('defers an inbound message while an older failed receipt is claimed elsewhere (G-20)', async () => {
    const businessId = await seedBusiness('Stalled Receipt Ltd', '+2348140040003');
    const waId = '2348140040003';
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
                metadata: { display_phone_number: '15550002', phone_number_id: 'PNID' },
                contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                messages: [
                  {
                    id: 'wamid.rcpt-yes',
                    from: waId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'yes' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const yes = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.rcpt-yes',
      payload: sealPayload(body, config.vaultKey, 'meta', 'wamid.rcpt-yes'),
      businessId,
    });
    await arrivesAfterPreview(businessId, yes);
    const receiptJob = await enqueue(businessId, 'delivery.status', {});
    const yesJob = await enqueue(businessId, 'inbound.message', { eventId: storedEventId(yes) });
    if (!receiptJob || !yesJob) throw new Error('both jobs should have enqueued');

    // A lane claims the receipt — the older job — and stalls before the lock.
    const stalled = await jobsRepo.claimNext(workerDb, 'stalled-lane');
    expect(stalled?.id).toBe(receiptJob.id);

    const runAtOf = async () => {
      const rows = await withBusiness(appDb, businessId, (tx) =>
        tx.execute<{ run_at: Date; state: string; attempts: number }>(
          sql`SELECT run_at, state, attempts FROM jobs WHERE id = ${yesJob.id}::uuid`,
        ),
      );
      return [...rows][0]!;
    };
    const before = new Date((await runAtOf()).run_at).getTime();

    const runner = buildRunner(workerDb, appDb, deps, { idleMs: 20 });
    runner.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 700));
      /* Evidence of the deferral itself, not of a job nobody claimed: the
       * runner claims the "yes", steps back, and `deferClaimed` pushes its
       * `run_at` forward and hands the attempt back. A job never claimed would
       * keep its enqueue-time `run_at`. */
      let deferred = false;
      const watchUntil = Date.now() + 5_000;
      while (Date.now() < watchUntil) {
        const now = await runAtOf();
        expect(['pending', 'running']).toContain(now.state);
        expect(now.attempts).toBeLessThanOrEqual(1);
        if (
          now.state === 'pending' &&
          now.attempts === 0 &&
          new Date(now.run_at).getTime() > before
        ) {
          deferred = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(deferred).toBe(true);
    } finally {
      await runner.stop();
    }
  });
});
