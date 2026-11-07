/**
 * Webhook ingress ordering (OWN-74, PR #428): a message of a webhook body is never stored ahead of
 * an earlier one that could not be stored. Split by concern from meta-webhook-ingress.integration
 * .test.ts; the shared app, stubs and payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { identity, jobsRepo, withBusiness, sql } from '@rekoda/db';
import { db, messagePayload, post, useMetaWebhookHarness } from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe('ordered ingress after a failed message', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  /* One body carrying a "cancel" then a "yes": if the first cannot get the ingress lock, the second
   * must not be stored ahead of it, whether it comes from the same member or another member of the
   * business. Meta redelivers the whole body on the non-200, and the redelivery stamps them in
   * sending order (independent review and CodeRabbit on #428). */
  it.each([
    ['the same member', '2348031234567'],
    ['another member of the business', '2348039990002'],
  ])(
    'does not store a later message of a batch after an earlier one failed (%s)',
    async (_who, laterFrom) => {
      const business = await seedMerchant('+2348031234567', 'Ada Fashion');
      const delegate = await identity.upsertUserByPhone(db, '+2348039990002');
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      const body = messagePayload('2348031234567', 'wamid.BATCH.A', 'cancel');
      body.entry[0]!.changes[0]!.value.messages.push({
        id: 'wamid.BATCH.B',
        from: laterFrom,
        timestamp: '1700000001',
        type: 'text',
        text: { body: 'yes' },
      });
      const stored = async () => {
        const rows = await withBusiness(db, business.id, (tx) =>
          tx.execute<{ external_id: string }>(sql`
          SELECT external_id FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at`),
        );
        return [...rows].map((r) => r.external_id);
      };

      /* Hold the business's ingress lock past the 2 s bound while the batch arrives. */
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = withBusiness(db, business.id, async (tx) => {
        await jobsRepo.serializeBusiness(tx, business.id, 'ingress');
        locked();
        await held;
      });
      try {
        await isLocked;
        /* Freed 2.25 s after the first message is seen waiting for the lock, so a later message that
         * is (wrongly) attempted would get it. Waiting is observed, not assumed (Qodo on #428). */
        const request = post(body);
        let seen = false;
        for (let tries = 0; tries < 200 && !seen; tries++) {
          const waiting = await withBusiness(db, business.id, (tx) =>
            tx.execute(sql`
            SELECT 1 FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
               AND query LIKE '%pg_advisory_xact_lock%' AND pid <> pg_backend_pid()`),
          );
          seen = [...waiting].length > 0;
          if (!seen) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!seen) throw new Error('the request was never seen waiting on the ingress lock');
        const timer = setTimeout(release, 2_250);
        const first = await request;
        clearTimeout(timer);
        expect(first.statusCode).toBe(503);
      } finally {
        release();
        await holder;
      }
      expect(await stored()).toEqual([]);

      const second = await post(body);
      expect(second.statusCode).toBe(200);
      expect(await stored()).toEqual(['wamid.BATCH.A', 'wamid.BATCH.B']);
    },
  );
});
