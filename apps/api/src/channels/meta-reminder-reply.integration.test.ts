/**
 * A customer replies on WhatsApp to an invoice reminder (OWN-83): the business that sent the
 * reminder is told in its own Rekoda chat, once per reminder, whether or not the away assistant is
 * on, and without the assistant's handoff telling it a second time. The notice names the invoice,
 * never the customer's number or message. Tenancy: a reply to one business's number never tells
 * another business, even when the same person is a customer of both.
 */
import { describe, expect, it } from 'vitest';
import {
  billingRepo,
  conversationsRepo,
  customersRepo,
  identity,
  issueRepo,
  remindersRepo,
  sql,
  wabaRepo,
  withBusiness,
} from '@rekoda/db';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const CUSTOMER_WA = '2349097778888';
/** The blind index the privacy gateway stores on a customer phone. */
const phoneKey = (businessId: string, phone: string) =>
  matchKeyFor(businessId, 'phone', normaliseFacet('phone', phone), deps.config.matchKey);
let seq = 0;

interface Shop {
  businessId: string;
  ownerPhone: string;
  ownerId: string;
  invoiceNumber: string;
  invoiceId: string;
  customerId: string;
}

/** The owner writes to Rekoda's number, which opens their 24-hour window for free-form notices. */
const ownerWrites = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: 'who owes me',
      providerMessageId: `wamid.owner-${businessId.slice(0, 8)}-${(seq += 1)}`,
    }),
  );

/**
 * A business on its own WhatsApp number, one customer on `CUSTOMER_WA`, one unpaid invoice. The
 * owner has written to Rekoda today unless `ownerWrote` is false.
 */
async function shop(
  phoneNumberId: string,
  opts: { name?: string; assistant?: boolean; ownerWrote?: boolean } = {},
): Promise<Shop> {
  seq += 1;
  const ownerPhone = `+23480300033${String(seq).padStart(2, '0')}`;
  const owner = await identity.upsertUserByPhone(db, ownerPhone);
  const business = await identity.createBusinessWithOwner(db, {
    name: opts.name ?? 'Ada Fashion',
    businessType: null,
    ownerUserId: owner.id,
  });
  const businessId = business.id;
  await billingRepo.setPlan(db, { businessId, plan: 'complete', expiresAt: null, actor: 'test' });
  await withBusiness(db, businessId, async (tx) => {
    await wabaRepo.connectWaba(tx, {
      businessId,
      wabaId: `waba-${phoneNumberId}`,
      phoneNumberId,
      accessTokenCipher: encryptFacet(
        'EAAG-merchant-token',
        deps.config.connectionKey,
        `${businessId}:waba_token`,
      ),
      tokenTail: '4821',
    });
    await wabaRepo.setAssistantSettings(tx, businessId, {
      enabled: opts.assistant ?? false,
      dailyReplyLimit: 3,
    });
  });
  if (opts.ownerWrote ?? true) await ownerWrites(businessId);
  const customer = await customersRepo.createCustomerWithIdentities(db, businessId, `R${seq}`, [
    {
      facet: 'phone',
      ciphertext: encryptFacet(`+${CUSTOMER_WA}`, deps.config.vaultKey, `${businessId}:phone`),
      // Keyed as the privacy gateway keys every customer phone it stores.
      matchKey: phoneKey(businessId, `+${CUSTOMER_WA}`),
    },
  ]);
  const sale = await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: `CUSTOMER_R${seq}`,
      items: [{ name: 'gown', quantity: 1, unitPriceK: 4_500_000 }],
      subtotalK: 4_500_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 4_500_000,
      paidK: 0,
      balanceDueK: 4_500_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-reply-${seq}`,
      actor: 'system',
    }),
  );
  return {
    businessId,
    ownerPhone,
    ownerId: owner.id,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    customerId: customer.id,
  };
}

/** A WhatsApp reminder for the shop's invoice, recorded as the reminder service records one. */
async function reminded(s: Shop, status: 'sent' | 'blocked' = 'sent'): Promise<string> {
  return withBusiness(db, s.businessId, async (tx) => {
    const id = await remindersRepo.startReminder(tx, {
      businessId: s.businessId,
      invoiceId: s.invoiceId,
      customerId: s.customerId,
      channel: 'whatsapp',
      idempotencyKey: `reply-test-${s.businessId.slice(0, 8)}-${(seq += 1)}`,
      balanceK: 4_500_000,
      attestationId: null,
      userId: s.ownerId,
    });
    await remindersRepo.finishReminder(
      tx,
      s.businessId,
      id!,
      status,
      status === 'sent' ? null : 'window_closed_no_template',
    );
    return id!;
  });
}

const reply = async (phoneNumberId: string, wamid: string, text: string) => {
  expect((await post(messagePayload(CUSTOMER_WA, wamid, text, phoneNumberId))).statusCode).toBe(
    200,
  );
  while (await buildRunner(workerDb, db, deps).runOnce()) {
    /* drain: every job this webhook queued */
  }
};

const noticesTo = (phone: string) =>
  stubSender.sent.filter(
    (m) => m.to === phone && m.text.includes('has sent your business a WhatsApp'),
  );

const noticeRows = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => [
    ...(await tx.execute<{ reminder_id: string }>(
      sql`SELECT reminder_id FROM reminder_reply_notices`,
    )),
  ]);

describe('a customer replies to a WhatsApp reminder (OWN-83)', () => {
  it('tells the business in its own chat, naming the invoice, with the assistant off', async () => {
    const s = await shop('PN-RR-1');
    const reminderId = await reminded(s);

    await reply('PN-RR-1', 'wamid.RR.1', 'I will pay on Friday');

    const notices = noticesTo(s.ownerPhone);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain(s.invoiceNumber);
    expect(notices[0]!.text).toContain('Rekoda does not show customer messages here');
    // No customer identity or message content rides the notice.
    expect(notices[0]!.text).not.toMatch(/234909|9097778888/);
    expect(notices[0]!.text).not.toContain('Friday');
    expect(await noticeRows(s.businessId)).toEqual([{ reminder_id: reminderId }]);
    // The assistant is off: nothing went back to the customer.
    expect(stubSender.connectionTexts).toHaveLength(0);
  });

  it('a redelivered webhook and the customer’s next messages tell the business nothing more', async () => {
    const s = await shop('PN-RR-2');
    await reminded(s);

    await reply('PN-RR-2', 'wamid.RR.2A', 'I will pay on Friday');
    // Meta delivers the same message again.
    await reply('PN-RR-2', 'wamid.RR.2A', 'I will pay on Friday');
    // And the customer writes twice more, including a voice note.
    await reply('PN-RR-2', 'wamid.RR.2B', 'hello?');
    await reply('PN-RR-2', 'wamid.RR.2C', '');

    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    expect(await noticeRows(s.businessId)).toHaveLength(1);
  });

  it('a notice that could not be delivered is not spent: the next message tries again', async () => {
    const s = await shop('PN-RR-12');
    await reminded(s);
    // The owner's WhatsApp window is closed (or Meta is down): the free-form notice is refused.
    stubSender.failWith();
    await reply('PN-RR-12', 'wamid.RR.12A', 'I will pay');
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
    expect(await noticeRows(s.businessId)).toHaveLength(0);
    // The customer writes again once delivery works: the business is told, once.
    await reply('PN-RR-12', 'wamid.RR.12B', 'hello?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    expect(await noticeRows(s.businessId)).toHaveLength(1);
    await reply('PN-RR-12', 'wamid.RR.12C', 'still there?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
  });

  it('waits for the owner’s 24-hour window: not sent, not spent, then told once they write', async () => {
    // The owner has not written to Rekoda in the last day: Meta would accept the free-form notice
    // and fail it later (131047), so it is not sent and nothing is recorded.
    const s = await shop('PN-RR-14', { ownerWrote: false });
    await reminded(s);
    await reply('PN-RR-14', 'wamid.RR.14A', 'I will pay');
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
    expect(await noticeRows(s.businessId)).toHaveLength(0);

    // A window that closed a day ago is still closed.
    await ownerWrites(s.businessId);
    await withBusiness(db, s.businessId, (tx) =>
      tx.execute(
        sql`UPDATE conversation_messages SET created_at = now() - interval '25 hours' WHERE direction = 'inbound'`,
      ),
    );
    await reply('PN-RR-14', 'wamid.RR.14B', 'hello?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);

    // The owner writes; the customer's next message tells the business, once.
    await ownerWrites(s.businessId);
    await reply('PN-RR-14', 'wamid.RR.14C', 'are you there?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    expect(await noticeRows(s.businessId)).toHaveLength(1);
  });

  it('a busy shop: a reply still matches when many newer reminders went to other customers', async () => {
    const s = await shop('PN-RR-13');
    await reminded(s);
    // 55 newer WhatsApp reminders on the same invoice's business, each to a different customer.
    for (let i = 0; i < 55; i += 1) {
      const other = await customersRepo.createCustomerWithIdentities(db, s.businessId, `O${i}`, [
        {
          facet: 'phone',
          ciphertext: encryptFacet(
            `+23490977${String(10000 + i)}`,
            deps.config.vaultKey,
            `${s.businessId}:phone`,
          ),
          matchKey: phoneKey(s.businessId, `+23490977${String(10000 + i)}`),
        },
      ]);
      await withBusiness(db, s.businessId, async (tx) => {
        const id = await remindersRepo.startReminder(tx, {
          businessId: s.businessId,
          invoiceId: s.invoiceId,
          customerId: other.id,
          channel: 'whatsapp',
          idempotencyKey: `busy-${i}-${s.businessId.slice(0, 8)}`,
          balanceK: 4_500_000,
          attestationId: null,
          userId: s.ownerId,
        });
        await remindersRepo.finishReminder(tx, s.businessId, id!, 'sent', null);
        await tx.execute(
          sql`UPDATE invoice_reminders SET sent_at = now() + make_interval(secs => ${i + 1}) WHERE id = ${id}::uuid`,
        );
      });
    }
    await reply('PN-RR-13', 'wamid.RR.13', 'I will pay');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
  });

  it('a message from a number no reminder went to tells the business nothing', async () => {
    const s = await shop('PN-RR-14');
    await reminded(s);
    // Someone else writes to the shop's number: not the reminded customer.
    expect(
      (await post(messagePayload('2349091112222', 'wamid.RR.14', 'hello', 'PN-RR-14'))).statusCode,
    ).toBe(200);
    while (await buildRunner(workerDb, db, deps).runOnce()) {
      /* drain */
    }
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
    expect(await noticeRows(s.businessId)).toHaveLength(0);
  });

  it('a later reminder answered again is told again', async () => {
    const s = await shop('PN-RR-3');
    await reminded(s);
    await reply('PN-RR-3', 'wamid.RR.3A', 'ok');
    await reminded(s);
    await reply('PN-RR-3', 'wamid.RR.3B', 'paid now');
    expect(noticesTo(s.ownerPhone)).toHaveLength(2);
  });

  it('with the assistant on, the customer is handed off and the business is told once, not twice', async () => {
    const s = await shop('PN-RR-4', { assistant: true });
    await reminded(s);

    await reply('PN-RR-4', 'wamid.RR.4', 'I already paid yesterday, check your account');

    // The customer still hears a person will reply, on the shop's own number.
    expect(stubSender.connectionTexts).toHaveLength(1);
    expect(stubSender.connectionTexts[0]!.text).toContain('Someone from the shop will reply');
    // The business gets the reminder-reply notice, and NOT the generic handoff notice as well.
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    expect(stubSender.sent.filter((m) => m.to === s.ownerPhone)).toHaveLength(1);
  });

  it('after the one reminder notice, a later unanswered message is handed off to the business as before', async () => {
    const s = await shop('PN-RR-11', { assistant: true });
    await reminded(s);
    await reply('PN-RR-11', 'wamid.RR.11A', 'I already paid yesterday');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    // A new day for the assistant's once-a-day handoff (the reminder notice is already spent).
    await withBusiness(db, s.businessId, (tx) =>
      tx.execute(sql`UPDATE away_assistant_replies SET day = '2000-01-01'`),
    );
    await reply('PN-RR-11', 'wamid.RR.11B', 'when do you open tomorrow?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(1);
    // The business is not left in the dark: the ordinary handoff notice tells it.
    const handoff = stubSender.sent.filter(
      (m) => m.to === s.ownerPhone && m.text.includes('could not answer'),
    );
    expect(handoff).toHaveLength(1);
  });

  it('with the assistant on and the owner’s window closed, the handoff is not silenced', async () => {
    const s = await shop('PN-RR-15', { assistant: true, ownerWrote: false });
    await reminded(s);
    await reply('PN-RR-15', 'wamid.RR.15', 'I already paid yesterday, check your account');
    // The reminder notice waits for the window, so the handoff tries its own notice as before.
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
    expect(await noticeRows(s.businessId)).toHaveLength(0);
    const handoff = stubSender.sent.filter(
      (m) => m.to === s.ownerPhone && m.text.includes('could not answer'),
    );
    expect(handoff).toHaveLength(1);
  });

  it('a message that answers no reminder keeps today’s behaviour: no reminder notice', async () => {
    const s = await shop('PN-RR-5', { assistant: true });
    await reply('PN-RR-5', 'wamid.RR.5', 'when do you open tomorrow?');
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
    // The ordinary handoff still tells the merchant, as before.
    expect(stubSender.sent.find((m) => m.text.includes('could not answer'))?.to).toBe(s.ownerPhone);
  });

  it('a reminder that was never delivered, or one older than seven days, is not what they answered', async () => {
    const blocked = await shop('PN-RR-6');
    await reminded(blocked, 'blocked');
    await reply('PN-RR-6', 'wamid.RR.6', 'hello');
    expect(noticesTo(blocked.ownerPhone)).toHaveLength(0);

    const old = await shop('PN-RR-7');
    const id = await reminded(old);
    await withBusiness(db, old.businessId, (tx) =>
      tx.execute(
        sql`UPDATE invoice_reminders SET sent_at = now() - interval '8 days' WHERE id = ${id}::uuid`,
      ),
    );
    await reply('PN-RR-7', 'wamid.RR.7', 'hello');
    expect(noticesTo(old.ownerPhone)).toHaveLength(0);
  });

  it('a STOP is a consent change, not a reply needing attention', async () => {
    const s = await shop('PN-RR-8');
    await reminded(s);
    await reply('PN-RR-8', 'wamid.RR.8', 'STOP');
    expect(noticesTo(s.ownerPhone)).toHaveLength(0);
  });

  it('never crosses tenants: the same person, a customer of two businesses', async () => {
    const a = await shop('PN-RR-A', { name: 'Ada Fashion' });
    const b = await shop('PN-RR-B', { name: 'Bisi Shoes' });
    // Only A reminded them.
    await reminded(a);

    // They write to B's number: B sent no reminder, so B is not told, and A is not told either.
    await reply('PN-RR-B', 'wamid.RR.AB1', 'hello');
    expect(noticesTo(a.ownerPhone)).toHaveLength(0);
    expect(noticesTo(b.ownerPhone)).toHaveLength(0);

    // They write to A's number: only A is told, about A's invoice.
    await reply('PN-RR-A', 'wamid.RR.AB2', 'I will pay');
    expect(noticesTo(a.ownerPhone)).toHaveLength(1);
    expect(noticesTo(a.ownerPhone)[0]!.text).toContain(a.invoiceNumber);
    expect(noticesTo(b.ownerPhone)).toHaveLength(0);
    expect(await noticeRows(a.businessId)).toHaveLength(1);
    expect(await noticeRows(b.businessId)).toHaveLength(0);
  });

  it('the notice table is the application role’s to insert and read only, under RLS', async () => {
    const s = await shop('PN-RR-9');
    await reminded(s);
    await reply('PN-RR-9', 'wamid.RR.9', 'ok');
    const other = await shop('PN-RR-10', { name: 'Other' });
    // Another tenant sees nothing.
    expect(await noticeRows(other.businessId)).toHaveLength(0);
    // Evidence is never changed or deleted by the application.
    await expect(
      withBusiness(db, s.businessId, (tx) => tx.execute(sql`DELETE FROM reminder_reply_notices`)),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, s.businessId, (tx) =>
        tx.execute(sql`UPDATE reminder_reply_notices SET notified_at = now()`),
      ),
    ).rejects.toThrow();
  });
});
