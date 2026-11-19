/**
 * A usage reservation binds only to its event's own metering job (closeout round G of PR #432;
 * Qodo findings 12 and 13 on the 0227 gate).
 *
 * A bound reservation is refundable for 45 days, not the 15 minutes of an unbound one, and only the
 * event's job finishing closes it (0218, 0221). 0227 bound to an event of this business with ANY
 * running job whose payload named it, matched by stripping `{`, `}` and `-` from the text:
 *   - Qodo 12: a payload the closure trigger cannot cast (`{{<uuid>}}`, a hyphen out of place)
 *     still matched, so the job's finish closed nothing and the unit stayed refundable for 45 days;
 *   - Qodo 13: a running job of any kind (one the application enqueued with a budget of one
 *     attempt, say) qualified, and its death leaves a reservation open by design.
 * Since 0245 the payload must be a spelling the trigger reads as this event's uuid, the job must be
 * an `inbound.message` or `customer.message` (the two handlers that meter an event's spend), and it
 * must be the event's only live such job. Every attack runs as `rekoda_app`; the owner only
 * arranges running jobs (the worker's claim, which no test needs to drive).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { usagePeriod, type UsageUnit } from '@rekoda/core';
import { withBusiness } from '../client.js';
import { events, usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

const UNIT: UsageUnit = 'AI_ACTIONS';
const NOT_BINDABLE =
  /^42501 .*usage_bind_event: not an event of this business whose (metering )?job is running/;

async function storedEvent(businessId: string): Promise<string> {
  const recorded = await withBusiness(appDb, businessId, (tx) =>
    events.recordEvent(tx, {
      provider: 'meta',
      eventType: 'message',
      externalId: `wamid.${randomUUID()}`,
      payload: { sealed: 'opaque' },
      businessId,
    }),
  );
  if (!recorded.isNew) throw new Error('the event was not stored');
  return recorded.id;
}
/** A running job with `eventId` spelled exactly as given (the worker's claim, arranged). */
async function running(businessId: string, kind: string, eventIdText: string): Promise<string> {
  const rows = await ownerDb.execute<{ id: string }>(sql`
    INSERT INTO jobs (business_id, kind, payload, state, locked_by, locked_at, attempts, max_attempts)
    VALUES (${businessId}::uuid, ${kind}, jsonb_build_object('eventId', ${eventIdText}::text),
            'running', 'fixture', now(), 1, 1)
    RETURNING id`);
  return [...rows][0]!.id;
}
const spend = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    usageRepo.reserveUnit(tx, businessId, usagePeriod(new Date()), UNIT, 50),
  );
const bind = (businessId: string, reservation: string, eventId: string) =>
  outcome(
    withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`SELECT usage_bind_event(${businessId}::uuid, ${reservation}::uuid,
                                             ${eventId}::uuid)`),
    ),
  );
const boundTo = async (reservation: string) =>
  [
    ...(await ownerDb.execute<{ event_id: string | null }>(
      sql`SELECT event_id FROM usage_reservations WHERE id = ${reservation}::uuid`,
    )),
  ][0]!.event_id;

describe('0245: a reservation binds only to its event’s own metering job', () => {
  it('ATTACK (Qodo 12): a payload the closure trigger cannot read as the uuid does not bind', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    const bare = eventId.replace(/-/g, '');
    for (const spelling of [`{{${eventId}}}`, `${bare.slice(0, 1)}-${bare.slice(1)}`]) {
      await ownerDb.execute(sql`DELETE FROM jobs WHERE business_id = ${businessId}::uuid`);
      await running(businessId, 'inbound.message', spelling);
      const reservation = usageRepo.reservationOf((await spend(businessId)).meter)!;
      expect(await bind(businessId, reservation, eventId)).toMatch(NOT_BINDABLE);
      expect(await boundTo(reservation)).toBeNull();
    }
  });

  it('ATTACK (Qodo 13): a running job of a kind that meters no event does not bind', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    await running(businessId, 'document.render', eventId);
    const reservation = usageRepo.reservationOf((await spend(businessId)).meter)!;
    expect(await bind(businessId, reservation, eventId)).toMatch(NOT_BINDABLE);
    expect(await boundTo(reservation)).toBeNull();
  });

  it('ATTACK (Qodo 13): a second live metering job naming the event does not bind either', async () => {
    const businessId = await seedBusiness();
    const eventId = await storedEvent(businessId);
    await running(businessId, 'inbound.message', eventId);
    await running(businessId, 'customer.message', eventId); // a forged twin, any lease
    const reservation = usageRepo.reservationOf((await spend(businessId)).meter)!;
    expect(await bind(businessId, reservation, eventId)).toMatch(NOT_BINDABLE);
    expect(await boundTo(reservation)).toBeNull();
  });

  it('binds to the event’s own running handler job, in any spelling the trigger reads, and its finish closes it', async () => {
    for (const [kind, spell] of [
      ['inbound.message', (e: string) => e],
      ['customer.message', (e: string) => `{${e.toUpperCase()}}`],
      ['inbound.message', (e: string) => e.replace(/-/g, '')],
    ] as const) {
      const businessId = await seedBusiness();
      const eventId = await storedEvent(businessId);
      const job = await running(businessId, kind, spell(eventId));
      const reservation = usageRepo.reservationOf((await spend(businessId)).meter)!;
      expect(await bind(businessId, reservation, eventId)).toBe('allowed');
      expect(await boundTo(reservation)).toBe(eventId);
      await ownerDb.execute(sql`UPDATE jobs SET state = 'done' WHERE id = ${job}::uuid`);
      const [closed] = [
        ...(await ownerDb.execute<{ closed: boolean }>(
          sql`SELECT closed_at IS NOT NULL AS closed FROM usage_reservations WHERE id = ${reservation}::uuid`,
        )),
      ];
      expect(closed!.closed).toBe(true);
    }
  });
});
