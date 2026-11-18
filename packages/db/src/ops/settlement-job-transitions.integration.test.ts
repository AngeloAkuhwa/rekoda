/**
 * The settlement credential moves its own jobs only through the runner's transitions (S-1, owner
 * instruction of 18 Nov 2026; migration 0242).
 *
 * Settlement claims, renews, completes, retries, defers, reclaims and kills `billing.process` and
 * `billing.apply_no_charge` jobs (0217). Until 0242 nothing bounded the DIRECTION of those moves: the
 * worker guard (0238, 0241) applied only to holders of `rekoda_worker`, so the settlement credential
 * could move a done or dead billing job back to pending and re-run it, outside the operator recovery
 * OWN-73 and OWN-76 make the only way back from dead (`deadJobsRepo.beginRecovery`, on the
 * application credential, audited, with exactly one more attempt). It could also hand a running
 * job its retry budget back, so a job failing for ever never died and never reached the operator.
 *
 * Every probe runs as the real settlement role, or as a role that only inherits it (created inside
 * a transaction that always rolls back); the owner only arranges state.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { deadJobsRepo, jobsRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

const GUARD = /^42501 .*moves a job only through its own transitions/;

/** A settlement job in a given state, written by the owner (arranging state only). */
async function billingJob(
  businessId: string,
  state: 'pending' | 'running' | 'done' | 'dead',
  attempts = 0,
  kind: 'billing.process' | 'billing.apply_no_charge' = 'billing.process',
): Promise<string> {
  const [row] = await ownerDb.execute<{ id: string }>(sql`
    INSERT INTO jobs (business_id, kind, payload, state, attempts, locked_at, locked_by)
    VALUES (${businessId}::uuid, ${kind}, '{}'::jsonb, ${state}, ${attempts},
            ${state === 'running' ? sql`now()` : sql`NULL`},
            ${state === 'running' ? 'settlement-probe' : null})
    RETURNING id`);
  return row!.id;
}

const stateOf = async (jobId: string) => {
  const [row] = await ownerDb.execute<{ state: string; attempts: number }>(
    sql`SELECT state, attempts FROM jobs WHERE id = ${jobId}::uuid`,
  );
  return row!;
};

describe('0242: settlement moves its jobs only through its own transitions', () => {
  it('ATTACK: settlement cannot move a done or dead billing job back to the queue, pinned or not', async () => {
    const a = await seedBusiness();
    for (const kind of ['billing.process', 'billing.apply_no_charge'] as const) {
      for (const [from, to] of [
        ['done', 'pending'],
        ['done', 'running'],
        ['done', 'dead'],
        ['dead', 'pending'],
        ['dead', 'running'],
        ['dead', 'done'],
      ] as const) {
        const job = await billingJob(a, from, 5, kind);
        const move = sql`UPDATE jobs SET state = ${to}, locked_at = NULL, locked_by = NULL,
                                  run_at = now() WHERE id = ${job}::uuid`;
        expect(await outcome(settlementDb.execute(move)), `${kind} ${from} -> ${to}`).toMatch(
          GUARD,
        );
        expect(
          await outcome(withBusiness(settlementDb, a, (tx) => tx.execute(move))),
          `${kind} ${from} -> ${to} (pinned)`,
        ).toMatch(GUARD);
        expect((await stateOf(job)).state).toBe(from);
      }
    }
  });

  it('ATTACK: a role that only inherits rekoda_settlement cannot revive a done or dead job', async () => {
    const a = await seedBusiness();
    for (const from of ['done', 'dead'] as const) {
      const job = await billingJob(a, from, 5);
      const hop = `settle_hop_${randomUUID().replaceAll('-', '')}`;
      const result = await outcome(
        ownerDb.transaction(async (tx) => {
          await tx.execute(sql.raw(`CREATE ROLE ${hop} NOLOGIN INHERIT IN ROLE rekoda_settlement`));
          await tx.execute(sql.raw(`SET LOCAL ROLE ${hop}`));
          const moved = await tx.execute<{ id: string }>(
            sql`UPDATE jobs SET state = 'pending', run_at = now() WHERE id = ${job}::uuid RETURNING id`,
          );
          // Reached only when the guard let the revival through: roll back and report it.
          throw new Error(`revived ${[...moved].length} ${from} job(s)`);
        }),
      );
      expect(result, from).toMatch(GUARD);
      expect((await stateOf(job)).state).toBe(from);
    }
  });

  it('ATTACK: settlement cannot hand a job its retry budget back, so a failing job still dies', async () => {
    const a = await seedBusiness();
    const running = await billingJob(a, 'running', 4);
    // A retry that also resets the attempts used.
    expect(
      await outcome(
        settlementDb.execute(sql`UPDATE jobs SET state = 'pending', attempts = 0, locked_at = NULL,
                                   locked_by = NULL WHERE id = ${running}::uuid`),
      ),
    ).toMatch(GUARD);
    // A reset of the attempts on a job it holds, with no change of state.
    expect(
      await outcome(
        settlementDb.execute(sql`UPDATE jobs SET attempts = 0 WHERE id = ${running}::uuid`),
      ),
    ).toMatch(GUARD);
    const pending = await billingJob(a, 'pending', 4);
    expect(
      await outcome(
        settlementDb.execute(sql`UPDATE jobs SET attempts = 0 WHERE id = ${pending}::uuid`),
      ),
    ).toMatch(GUARD);
    // A claim that does not count the attempt.
    expect(
      await outcome(
        settlementDb.execute(sql`UPDATE jobs SET state = 'running', locked_at = now(),
                                   locked_by = 'probe' WHERE id = ${pending}::uuid`),
      ),
    ).toMatch(GUARD);
    expect(await stateOf(running)).toEqual({ state: 'running', attempts: 4 });
    expect(await stateOf(pending)).toEqual({ state: 'pending', attempts: 4 });
  });

  it('keeps every move the settlement runner makes: claim, renew, defer, retry, complete, die, reclaim', async () => {
    const a = await seedBusiness();
    // Claim (pending -> running, one attempt counted) and lease renewal.
    const first = await billingJob(a, 'pending', 0, 'billing.apply_no_charge');
    const claimed = await jobsRepo.claimNext(settlementDb, 'settlement-test', {
      only: jobsRepo.SETTLEMENT_JOB_KINDS,
    });
    expect(claimed?.id).toBe(first);
    expect(await stateOf(first)).toEqual({ state: 'running', attempts: 1 });
    await withBusiness(settlementDb, a, (tx) => jobsRepo.touch(tx, first, 'settlement-test'));
    // Deferral hands the claim's attempt back (running -> pending, attempts - 1).
    await jobsRepo.deferClaimed(settlementDb, first, 0, 'settlement-test');
    expect(await stateOf(first)).toEqual({ state: 'pending', attempts: 0 });
    // Claim again, fail once (running -> pending), claim again, complete (running -> done).
    await jobsRepo.claimNext(settlementDb, 'settlement-test', {
      only: jobsRepo.SETTLEMENT_JOB_KINDS,
    });
    const retry = await jobsRepo.markFailed(
      settlementDb,
      { id: first, attempts: 1, maxAttempts: 5 },
      'transient',
      0,
      'settlement-test',
    );
    expect(retry.state).toBe('pending');
    await jobsRepo.claimNext(settlementDb, 'settlement-test', {
      only: jobsRepo.SETTLEMENT_JOB_KINDS,
    });
    await withBusiness(settlementDb, a, (tx) => jobsRepo.markDone(tx, first, 'settlement-test'));
    expect(await stateOf(first)).toEqual({ state: 'done', attempts: 2 });

    // Death on the last attempt (running -> dead), with its dead-job record in the same commit.
    const last = await billingJob(a, 'running', 5);
    const died = await jobsRepo.markFailed(
      settlementDb,
      { id: last, attempts: 5, maxAttempts: 5 },
      'gave up',
      0,
      'settlement-probe',
    );
    expect(died.state).toBe('dead');
    expect(await stateOf(last)).toEqual({ state: 'dead', attempts: 5 });

    // Reclaim of a stalled job: back to the queue, and past the last attempt, to dead.
    const stalled = await billingJob(a, 'running', 1);
    const exhausted = await billingJob(a, 'running', 6);
    await ownerDb.execute(sql`UPDATE jobs SET locked_at = now() - interval '1 hour'
                               WHERE id IN (${stalled}::uuid, ${exhausted}::uuid)`);
    expect(await jobsRepo.reclaimStalled(settlementDb, 60_000)).toBe(2);
    expect(await stateOf(stalled)).toEqual({ state: 'pending', attempts: 1 });
    expect(await stateOf(exhausted)).toEqual({ state: 'dead', attempts: 6 });
  });

  it('keeps the operator’s recovery: a dead billing job is requeued on the application credential', async () => {
    const a = await seedBusiness();
    const dead = await billingJob(a, 'running', 5);
    await jobsRepo.markFailed(
      settlementDb,
      { id: dead, attempts: 5, maxAttempts: 5 },
      'gave up',
      0,
      'settlement-probe',
    );
    const started = await withBusiness(appDb, a, (tx) =>
      deadJobsRepo.beginRecovery(tx, {
        businessId: a,
        jobId: dead,
        actor: 'operator:ops@example.test',
        reason: 'verified with Paystack',
        reference: 'RKD-SUB-20261118-S0001',
        verification: 'success',
      }),
    );
    expect(started).toBe(true);
    expect(await stateOf(dead)).toEqual({ state: 'pending', attempts: 5 });
    // And settlement runs the recovered attempt as usual.
    const claimed = await jobsRepo.claimNext(settlementDb, 'settlement-test', {
      only: jobsRepo.SETTLEMENT_JOB_KINDS,
    });
    expect(claimed?.id).toBe(dead);
    expect(await stateOf(dead)).toEqual({ state: 'running', attempts: 6 });
  });
});
