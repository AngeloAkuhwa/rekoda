/**
 * Migration 0223 (independent review of PR #432 at `75a8002`): settlement reaches only what its own
 * jobs name, and every application requeue of a dead job is bounded.
 *
 * Until 0223 the settlement principal's rights on `external_events` and `dead_job_exceptions` were
 * bounded only by the tenant pin, which any session sets. A compromised settlement process (the
 * threat OD-51.2 and OD-51.3 contain), holding the vault key, could pin any business and read its
 * WhatsApp message events and its customers' Paystack events, mark them processed (silently
 * dropping an inbound message or a customer payment before its pump ran), and close or pre-empt
 * the dead-job record of a merchant's customer payment. And the application could enqueue a
 * settlement job with no retry budget, or requeue a dead customer-payment job out of reach.
 *
 * Every attack runs as the real login role; each honest path the processes use is shown working.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { events, jobsRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

async function event(businessId: string, provider: 'paystack' | 'meta'): Promise<string> {
  const recorded = await withBusiness(appDb, businessId, (tx) =>
    events.recordEvent(tx, {
      provider,
      eventType: provider === 'meta' ? 'messages' : 'charge.success',
      externalId: `evt_${randomUUID()}`,
      payload: { sealed: 'opaque' },
      businessId,
    }),
  );
  if (!recorded.isNew) throw new Error('the event was not stored');
  return recorded.id;
}

/** A Paystack event with the settlement job the pump raises for it. */
async function billingEvent(businessId: string): Promise<{ eventId: string; jobId: string }> {
  const eventId = await event(businessId, 'paystack');
  const queued = await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, {
      businessId,
      kind: 'billing.process',
      payload: { eventId },
      singletonKey: `billevent:${eventId}`,
    }),
  );
  return { eventId, jobId: queued!.id };
}

const asSettlement = (businessId: string, statement: ReturnType<typeof sql>) =>
  withBusiness(settlementDb, businessId, async (tx) => [...(await tx.execute(statement))]);
const asApp = (businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)));

describe('settlement reaches only the Paystack events its own jobs name (0223)', () => {
  it('ATTACK: settlement cannot read a message event or a customer payment event', async () => {
    const businessId = await seedBusiness();
    const message = await event(businessId, 'meta');
    const customerPayment = await event(businessId, 'paystack');
    const { eventId } = await billingEvent(businessId);

    const seen = await asSettlement(businessId, sql`SELECT id FROM external_events`);
    expect(seen.map((row) => row['id'])).toEqual([eventId]);
    expect(
      await asSettlement(
        businessId,
        sql`SELECT id FROM external_events WHERE id IN (${message}::uuid, ${customerPayment}::uuid)`,
      ),
    ).toEqual([]);
  });

  it('ATTACK: settlement cannot mark a message or a customer payment processed', async () => {
    const businessId = await seedBusiness();
    const message = await event(businessId, 'meta');
    const customerPayment = await event(businessId, 'paystack');
    await billingEvent(businessId);

    const touched = await asSettlement(
      businessId,
      sql`UPDATE external_events SET processed_at = now(), error = 'dropped'
          WHERE id IN (${message}::uuid, ${customerPayment}::uuid) RETURNING id`,
    );
    expect(touched).toEqual([]);
    const rows = await ownerDb.execute(sql`
      SELECT count(*)::int AS n FROM external_events
      WHERE id IN (${message}::uuid, ${customerPayment}::uuid) AND processed_at IS NULL`);
    expect([...rows][0]).toMatchObject({ n: 2 });
  });

  it('settlement still reads and settles the event its job names', async () => {
    const businessId = await seedBusiness();
    const { eventId } = await billingEvent(businessId);
    const read = await withBusiness(settlementDb, businessId, (tx) =>
      events.eventForBusiness(tx, eventId, businessId),
    );
    expect(read?.id).toBe(eventId);
    await withBusiness(settlementDb, businessId, (tx) =>
      events.markProcessed(tx, eventId, null, businessId),
    );
    const rows = await ownerDb.execute(
      sql`SELECT processed_at IS NOT NULL AS done FROM external_events WHERE id = ${eventId}::uuid`,
    );
    expect([...rows][0]).toMatchObject({ done: true });
  });
});

describe("settlement touches only its own jobs' dead-job records (0223)", () => {
  async function paymentRecord(businessId: string): Promise<string> {
    const jobId = randomUUID();
    await ownerDb.execute(sql`
      INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts)
      VALUES (${jobId}::uuid, ${businessId}::uuid, 'payment.process', 'A customer payment', 5)`);
    return jobId;
  }

  it("ATTACK: settlement cannot close a customer payment's dead-job record", async () => {
    const businessId = await seedBusiness();
    const jobId = await paymentRecord(businessId);
    const closed = await asSettlement(
      businessId,
      sql`UPDATE dead_job_exceptions SET status = 'resolved', closed_at = now(),
                 closed_by = 'settlement', resolution = 'hidden'
          WHERE job_id = ${jobId}::uuid RETURNING job_id`,
    );
    expect(closed).toEqual([]);
    const rows = await ownerDb.execute(
      sql`SELECT status FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid`,
    );
    expect([...rows][0]).toMatchObject({ status: 'open' });
  });

  it('ATTACK: settlement cannot pre-empt a customer payment job with a closed record', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        asSettlement(
          businessId,
          sql`INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts, status)
              VALUES (${randomUUID()}::uuid, ${businessId}::uuid, 'payment.process', 'x', 1, 'resolved')`,
        ),
      ),
    ).toMatch(/^42501 .*row-level security/);
  });

  it("settlement still records its own job's death", async () => {
    const businessId = await seedBusiness();
    const { jobId } = await billingEvent(businessId);
    expect(
      await outcome(
        asSettlement(
          businessId,
          sql`INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts)
              VALUES (${jobId}::uuid, ${businessId}::uuid, 'billing.process', 'A subscription payment', 5)`,
        ),
      ),
    ).toBe('allowed');
  });
});

describe('the application cannot starve a job of its retries or park a dead one (0223)', () => {
  it('ATTACK: a settlement job enqueued with a cut retry budget is refused', async () => {
    const businessId = await seedBusiness();
    const eventId = await event(businessId, 'paystack');
    expect(
      await asApp(
        businessId,
        sql`INSERT INTO jobs (business_id, kind, payload, singleton_key, max_attempts)
            VALUES (${businessId}::uuid, 'billing.process',
                    jsonb_build_object('eventId', ${eventId}::text), ${`billevent:${eventId}`}, 1)`,
      ),
    ).toMatch(/^42501 .*only as pending work due now/);
  });

  async function deadPaymentJob(businessId: string): Promise<string> {
    const rows = await ownerDb.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts)
      VALUES (${businessId}::uuid, 'payment.process', '{}'::jsonb, 'dead', 5, 5)
      RETURNING id`);
    return [...rows][0]!.id;
  }

  it('ATTACK: a dead customer-payment job cannot be requeued into the far future', async () => {
    const businessId = await seedBusiness();
    const jobId = await deadPaymentJob(businessId);
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'pending', run_at = 'infinity', max_attempts = attempts + 1
            WHERE id = ${jobId}::uuid`,
      ),
    ).toMatch(/^42501 .*from dead to pending with no lease, due now, with one more attempt/);
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'pending', run_at = now(), max_attempts = 1000
            WHERE id = ${jobId}::uuid`,
      ),
    ).toMatch(/^42501 .*from dead to pending with no lease, due now, with one more attempt/);
  });

  it("the operator's recovery requeue (due now, one more attempt) still works", async () => {
    const businessId = await seedBusiness();
    const jobId = await deadPaymentJob(businessId);
    expect(
      await asApp(
        businessId,
        sql`UPDATE jobs SET state = 'pending', max_attempts = attempts + 1, run_at = now(),
                            locked_at = NULL, locked_by = NULL, updated_at = now()
            WHERE id = ${jobId}::uuid AND state = 'dead'`,
      ),
    ).toBe('allowed');
  });
});
