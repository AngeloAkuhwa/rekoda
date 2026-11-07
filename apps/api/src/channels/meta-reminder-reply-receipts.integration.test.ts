/**
 * Meta's delivery receipts for the reminder-reply notice (OWN-83): a notice Meta accepted and later
 * reported failed is due again, whether the receipt's job ran, died, or arrived while the notice
 * was still being recorded. Fixtures are in meta-reminder-reply.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  issueRepo,
  jobsRepo,
  remindersRepo,
  sql,
  withBusiness,
} from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  post,
  statusPayload,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import {
  noticeRows,
  noticesTo,
  reminded,
  reply,
  shop,
  useSaleWriter,
} from './meta-reminder-reply.fixtures.js';

useMetaWebhookHarness();
useSaleWriter(issueRepo.issueSale);

describe('delivery receipts for the reminder-reply notice (OWN-83)', () => {
  it('a notice Meta accepts and later reports failed is due again, and told once more', async () => {
    const s = await shop('PN-RR-17');
    await reminded(s);
    await reply('PN-RR-17', 'wamid.RR.17A', 'I will pay');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    // The stub numbers its message ids by send order.
    const at = stubSender.sent.findIndex(
      (m) => m.to === s.ownerPhone && m.text.includes('has sent your business a WhatsApp'),
    );
    const noticeWamid = `wamid.STUB${at + 1}`;

    // Meta's delivery receipt for that notice, on Rekoda's number: failed.
    expect(
      (await post(statusPayload(s.ownerPhone.slice(1), noticeWamid, 'failed'))).statusCode,
    ).toBe(200);
    while (await buildRunner(workerDb, db, deps).runOnce()) {
      /* drain the delivery-status job */
    }

    // The customer's next message tells the business again, and only once more.
    await reply('PN-RR-17', 'wamid.RR.17B', 'hello?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(2);
    await reply('PN-RR-17', 'wamid.RR.17C', 'still there?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(2);
    expect(await noticeRows(s.businessId)).toHaveLength(1);
  });

  it('a failed receipt whose job died is still applied: the notice is told once more', async () => {
    const s = await shop('PN-RR-18');
    await reminded(s);
    await reply('PN-RR-18', 'wamid.RR.18A', 'I will pay');
    const at = stubSender.sent.findIndex(
      (m) => m.to === s.ownerPhone && m.text.includes('has sent your business a WhatsApp'),
    );
    const noticeWamid = `wamid.STUB${at + 1}`;
    // The receipt was stored, but its delivery-status job ran out of attempts.
    await withBusiness(db, s.businessId, async (tx) => {
      const [event] = [
        ...(await tx.execute<{ id: string }>(sql`
          INSERT INTO external_events (provider, event_type, external_id, payload, business_id, signature_valid)
          VALUES ('meta', 'status.failed', ${`st-${noticeWamid}`}, '{}'::jsonb, ${s.businessId}::uuid, 1)
          RETURNING id`)),
      ];
      const job = await jobsRepo.enqueue(tx, {
        businessId: s.businessId,
        kind: 'delivery.status',
        payload: { eventId: event!.id, outboundMessageId: noticeWamid },
        singletonKey: event!.id,
        maxAttempts: 12,
      });
      await tx.execute(
        sql`UPDATE jobs SET state = 'dead', attempts = 12 WHERE id = ${job!.id}::uuid`,
      );
    });
    // The customer writes again before the owner does: the notice is retried anyway.
    await reply('PN-RR-18', 'wamid.RR.18B', 'hello?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(2);
    expect(await noticeRows(s.businessId)).toHaveLength(1);
    // The owner's next message still applies the rest of the receipt (as the inbound handler
    // does), and the re-sent notice, with its new Meta id, is not re-opened by it.
    expect(
      await withBusiness(db, s.businessId, (tx) =>
        conversationsRepo.reconcileDeadReceipts(tx, s.businessId),
      ),
    ).toBe(1);
    await reply('PN-RR-18', 'wamid.RR.18C', 'still there?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(2);
  });

  it('a failed receipt that arrives while the notice is being recorded waits for the record', async () => {
    const s = await shop('PN-RR-19');
    await reminded(s);
    await reply('PN-RR-19', 'wamid.RR.19A', 'I will pay');
    const [row] = await noticeRows(s.businessId);
    // A notice is being recorded under its new Meta id, not yet committed, when Meta's failure
    // receipt for that id arrives (a fast 131047). The receipt job must wait for the record.
    let receiptJob: Promise<unknown> = Promise.resolve();
    await withBusiness(db, s.businessId, async (tx) => {
      await remindersRepo.lockReminderReplyNotices(tx, s.businessId);
      await tx.execute(sql`
        UPDATE reminder_reply_notices SET provider_message_id = 'wamid.RR.19-INFLIGHT'
         WHERE reminder_id = ${row!.reminder_id}::uuid`);
      expect(
        (await post(statusPayload(s.ownerPhone.slice(1), 'wamid.RR.19-INFLIGHT', 'failed')))
          .statusCode,
      ).toBe(200);
      receiptJob = buildRunner(workerDb, db, deps).runOnce();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await receiptJob;
    const [after] = await withBusiness(db, s.businessId, async (tx) => [
      ...(await tx.execute<{ undelivered: boolean }>(
        sql`SELECT undelivered_at IS NOT NULL AS undelivered FROM reminder_reply_notices`,
      )),
    ]);
    expect(after?.undelivered).toBe(true);
  });
});
