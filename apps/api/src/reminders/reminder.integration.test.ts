/**
 * Customer payment reminders, slice A (N1, OWN-43, OWN-62).
 *
 * The claims pinned here, each against the real database under RLS with provider doubles:
 * a reminder quotes the balance read now and goes only with a public phone, an attestation and
 * no opt-out or stop; one key sends once however it is repeated or raced; an unknown provider
 * outcome is never resent; the opt-out token cannot be forged or aimed at another business;
 * WhatsApp outside the window sends nothing and says why; and no sale, invoice, payment or ledger
 * row is created or changed.
 */

import { describe, expect, it } from 'vitest';
import { emailSuppressionKey } from '@rekoda/core';
import { signReminderOptOut } from '@rekoda/core/reminders';
import 'reflect-metadata';
import { ROLES_KEY } from '../auth/roles.guard.js';
import { RemindersController } from './reminders.controller.js';
import { encryptFacet } from '@rekoda/core/vault';
import { unwindAllocations } from '../commands/payment-adjustment-commands.js';
import { customersRepo, issueRepo, settleRepo, sql, withBusiness } from '@rekoda/db';
import { EmailRefusedError, NoEmailSender, type EmailSender } from '../email/email.port.js';
import { EmailSuppressedError } from '../email/suppressing.sender.js';
import { ReminderInvoiceNotFound, ReminderKeyReused, ReminderService } from './reminder.service.js';
import {
  testKey,
  appDb,
  config,
  mail,
  whatsappCalls,
  whatsapp,
  useReminderHarness,
  setWhatsappOutcome,
  service,
  key,
  type Seeded,
  EMAIL,
  seedWith,
  approvePhone,
  rows,
  books,
  sendVia,
  sendEmail,
} from './reminder.fixtures.js';

const seed = (opts?: Parameters<typeof seedWith>[1]) => seedWith(issueRepo.issueSale, opts);

useReminderHarness();

/** A payment the merchant records against the invoice, through the real posting path. */
const pay = (s: Seeded, amountK: number) =>
  withBusiness(appDb, s.businessId, (tx) =>
    settleRepo.recordMerchantPayment(tx, {
      businessId: s.businessId,
      invoiceId: s.invoiceId,
      amountK,
      method: 'transfer',
      sourceType: 'dashboard',
      sourceId: s.invoiceNumber,
      actor: 'owner',
    }),
  );

describe('an email reminder', () => {
  it('names the merchant, quotes the balance and phone, and links an opt-out', async () => {
    const s = await seed();
    await approvePhone(s);
    const before = await books(s.businessId);

    const { reminder, replayed } = await sendEmail(s, { attest: true });

    expect(replayed).toBe(false);
    expect(reminder.status).toBe('sent');
    expect(reminder.balanceK).toBe(8_000_000);
    expect(mail.outbox).toHaveLength(1);
    const message = mail.outbox[0]!;
    expect(message.to).toBe(EMAIL);
    expect(message.fromName).toBe('Adaeze Fabrics via Rekoda');
    expect(message.text).toContain('Adaeze Fabrics');
    expect(message.text).toContain('80,000');
    expect(message.text).toContain(s.invoiceNumber);
    expect(message.text).toContain('+2348031112222');
    expect(message.text).toContain('Rekoda is not the creditor');
    expect(message.text).toContain('https://app.rekoda.test/reminders/opt-out#token=');
    // The private sign-in number never appears.
    expect(message.text).not.toContain('2348175');
    // No sale, invoice, payment or ledger row was created.
    expect(await books(s.businessId)).toEqual(before);
  });

  it('records the merchant attestation once, and later reminders do not ask again', async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendEmail(s)).reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'attestation_required',
    });
    expect(mail.outbox).toHaveLength(0);

    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect((await sendEmail(s)).reminder.status).toBe('sent');
    const [count] = await rows<{ n: string }>(
      s.businessId,
      sql`SELECT count(*)::text AS n FROM reminder_attestations`,
    );
    expect(count!.n).toBe('1');
    // The attestation names its purpose, so it cannot be read as consent to anything else.
    const [purpose] = await rows<{ purpose: string }>(
      s.businessId,
      sql`SELECT purpose FROM reminder_attestations`,
    );
    expect(purpose!.purpose).toBe('debt_reminder');
  });

  it('waits for the merchant to approve a public business phone', async () => {
    const s = await seed();
    const { reminder } = await sendEmail(s, { attest: true });
    expect(reminder).toMatchObject({ status: 'blocked', reasonCode: 'no_public_contact' });
    expect(mail.outbox).toHaveLength(0);
  });

  it('refuses a customer with no email address, and says so', async () => {
    const s = await seed({ email: null });
    await approvePhone(s);
    expect((await sendEmail(s, { attest: true })).reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'no_contact',
    });
  });

  it('sends nothing for an invoice that is already paid, and quotes the current balance otherwise', async () => {
    const s = await seed();
    await approvePhone(s);
    await pay(s, 5_000_000);
    const part = await sendEmail(s, { attest: true });
    expect(part.reminder.balanceK).toBe(3_000_000);
    expect(mail.outbox.at(-1)!.text).toContain('30,000');

    await pay(s, 3_000_000);
    const paid = await sendEmail(s);
    expect(paid.reminder).toMatchObject({ status: 'blocked', reasonCode: 'nothing_owing' });
    expect(mail.outbox).toHaveLength(1);
  });

  it('stops for an invoice the merchant stopped, and resumes when they undo it', async () => {
    const s = await seed();
    await approvePhone(s);
    const invoiceBefore = await rows(s.businessId, sql`SELECT * FROM invoices`);
    await service().setStopped(s.businessId, s.invoiceNumber, true);
    expect(await rows(s.businessId, sql`SELECT * FROM invoices`)).toEqual(invoiceBefore);
    expect((await sendEmail(s, { attest: true })).reminder.reasonCode).toBe('reminders_stopped');
    expect((await service().history(s.businessId, s.invoiceNumber)).remindersStopped).toBe(true);

    await service().setStopped(s.businessId, s.invoiceNumber, false);
    expect(await rows(s.businessId, sql`SELECT * FROM invoices`)).toEqual(invoiceBefore);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
  });

  it('sends one email for one key however often or concurrently it is asked', async () => {
    const s = await seed();
    await approvePhone(s);
    const idempotencyKey = key();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sendEmail(s, { attest: true, idempotencyKey })),
    );
    expect(mail.outbox).toHaveLength(1);
    expect(new Set(results.map((r) => r.reminder.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    // One click is one attestation, however many raced copies of it arrived.
    const [attested] = await rows<{ n: string }>(
      s.businessId,
      sql`SELECT count(*)::text AS n FROM reminder_attestations`,
    );
    expect(attested!.n).toBe('1');
    const [count] = await rows<{ n: string }>(
      s.businessId,
      sql`SELECT count(*)::text AS n FROM invoice_reminders`,
    );
    expect(count!.n).toBe('1');
  });

  it('is never resent after an unknown provider outcome, and says it could not be confirmed', async () => {
    const s = await seed();
    await approvePhone(s);
    mail.uncertainNext = 1;
    const idempotencyKey = key();
    const first = await sendEmail(s, { attest: true, idempotencyKey });
    expect(first.reminder).toMatchObject({
      status: 'uncertain',
      reasonCode: 'delivery_unconfirmed',
    });

    const again = await sendEmail(s, { attest: true, idempotencyKey });
    expect(again.replayed).toBe(true);
    expect(again.reminder.status).toBe('uncertain');
    expect(mail.attempts).toBe(1);
  });

  it('records a refusal as failed, an unexpected error as uncertain, and a suppressed address as blocked', async () => {
    const s = await seed();
    await approvePhone(s);
    mail.failNext = true;
    expect((await sendEmail(s, { attest: true })).reminder).toMatchObject({
      status: 'uncertain',
      reasonCode: 'unexpected',
    });

    const refused: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailRefusedError('422');
      },
    };
    expect((await sendVia(s, 'email', { sender: refused })).reminder).toMatchObject({
      status: 'failed',
      reasonCode: 'send_failed',
    });

    const suppressed: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailSuppressedError();
      },
    };
    const r = await sendVia(s, 'email', { sender: suppressed });
    expect(r.reminder).toMatchObject({ status: 'blocked', reasonCode: 'address_suppressed' });
  });

  it('sends nothing on any channel until reminders are released', async () => {
    const s = await seed();
    await approvePhone(s);
    const held = new ReminderService(
      { ...config, customerReminders: false },
      appDb,
      mail,
      whatsapp,
    );
    for (const channel of ['email', 'whatsapp'] as const) {
      const r = await held.send(s.businessId, s.userId, {
        invoiceNumber: s.invoiceNumber,
        channels: [channel],
        idempotencyKey: key(),
        attest: true,
      });
      expect(r.results[0]!.reminder).toMatchObject({
        status: 'blocked',
        reasonCode: 'reminders_not_released',
      });
    }
    expect(mail.outbox).toHaveLength(0);
  });

  it('says email is not set up rather than pretending, when no sender is configured', async () => {
    const s = await seed();
    await approvePhone(s);
    const r = await sendVia(s, 'email', { sender: new NoEmailSender(), attest: true });
    expect(r.reminder).toMatchObject({ status: 'blocked', reasonCode: 'email_not_configured' });
  });

  it('honours the customer opt-out link, and refuses a forged or foreign token', async () => {
    const s = await seed();
    await approvePhone(s);
    await sendEmail(s, { attest: true });
    const token = /token=([^\s]+)/.exec(mail.outbox[0]!.text)![1]!;

    expect(await service().optOut(`${token.slice(0, -2)}xx`)).toBe(false);
    const other = await seed({ name: 'Other Ltd' });
    const aimedAtOther = signReminderOptOut(
      testKey('not-the-secret'),
      other.businessId,
      emailSuppressionKey(EMAIL),
    );
    expect(await service().optOut(aimedAtOther)).toBe(false);

    expect(await service().optOut(decodeURIComponent(token))).toBe(true);
    expect(await service().optOut(decodeURIComponent(token))).toBe(true);

    const after = await sendEmail(s);
    expect(after.reminder).toMatchObject({ status: 'blocked', reasonCode: 'customer_opted_out' });
    expect(mail.outbox).toHaveLength(1);

    // The opt-out is this merchant's only: another business may still write to that address.
    await approvePhone(other);
    expect((await sendEmail(other, { attest: true })).reminder.status).toBe('sent');
  });
});

describe('the merchant attestation is for one address', () => {
  it("asks again when the customer's address has changed", async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect((await sendEmail(s)).reminder.status).toBe('sent');

    // The stored address is replaced (the old facet row is rewritten with another address).
    await rows(
      s.businessId,
      sql`UPDATE customer_identities SET ciphertext = ${encryptFacet(
        'someone.else@customer.example.ng',
        config.vaultKey,
        `${s.businessId}:email`,
      )} WHERE customer_id = ${s.customerId}::uuid AND facet = 'email'`,
    );
    const changed = await sendEmail(s);
    expect(changed.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'attestation_required',
    });
    expect(mail.outbox).toHaveLength(2);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect(mail.outbox.at(-1)!.to).toBe('someone.else@customer.example.ng');
  });
});

describe('a customer with two stored addresses', () => {
  it('sends to neither, rather than guessing which one is current', async () => {
    const s = await seed();
    await approvePhone(s);
    await customersRepo.addIdentityFacet(appDb, s.businessId, s.customerId, {
      facet: 'email',
      ciphertext: encryptFacet('new@customer.example.ng', config.vaultKey, `${s.businessId}:email`),
      matchKey: null,
    });
    const r = await sendEmail(s, { attest: true });
    expect(r.reminder).toMatchObject({ status: 'blocked', reasonCode: 'ambiguous_contact' });
    expect(mail.outbox).toHaveLength(0);
    // The phone is still unambiguous, so WhatsApp is unaffected.
    expect((await sendVia(s, 'whatsapp')).reminder.status).toBe('sent');
  });
});

describe('the opt-out link', () => {
  it('still works after MATCH_KEY is rotated', async () => {
    const s = await seed();
    await approvePhone(s);
    await sendEmail(s, { attest: true });
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.outbox[0]!.text)![1]!);
    const rotated = new ReminderService(
      { ...config, matchKey: testKey('a-different-match-key') },
      appDb,
      mail,
      whatsapp,
    );
    expect(await rotated.optOut(token)).toBe(true);
  });
});

describe('a WhatsApp reminder', () => {
  it('goes through the merchant line inside the window, with the public phone', async () => {
    const s = await seed();
    await approvePhone(s);
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder.status).toBe('sent');
    expect(whatsappCalls).toHaveLength(1);
    expect(whatsappCalls[0]!.to).toBe('+2348039998888');
    expect(whatsappCalls[0]!.text).toContain('+2348031112222');
    expect(whatsappCalls[0]!.text).toContain('STOP');
  });

  it.each([
    [{ outcome: 'window_closed' } as const, 'blocked', 'window_closed_no_template'],
    [{ outcome: 'suppressed' } as const, 'blocked', 'customer_opted_out'],
    [{ outcome: 'not_entitled' } as const, 'blocked', 'not_entitled'],
    [{ outcome: 'no_connection' } as const, 'blocked', 'no_whatsapp_connection'],
    [
      { outcome: 'allowance_exhausted', unit: 'SERVICE_MESSAGE' } as const,
      'blocked',
      'allowance_exhausted',
    ],
    [{ outcome: 'send_failed', unit: 'SERVICE_MESSAGE' } as const, 'failed', 'send_failed'],
  ])('records %j as %s / %s and substitutes nothing', async (outcome, status, reasonCode) => {
    const s = await seed();
    await approvePhone(s);
    setWhatsappOutcome(outcome);
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder).toMatchObject({ status, reasonCode });
    expect(mail.outbox).toHaveLength(0);
  });

  it('records a send whose outcome Meta left unknown as uncertain, not failed', async () => {
    const s = await seed();
    await approvePhone(s);
    setWhatsappOutcome({ outcome: 'send_failed', unit: 'SERVICE_MESSAGE', unknown: true });
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder).toMatchObject({ status: 'uncertain', reasonCode: 'delivery_unconfirmed' });
  });

  it('records a send Meta accepted but whose provider id was not recorded as sent, says so, and never resends it', async () => {
    const s = await seed();
    await approvePhone(s);
    setWhatsappOutcome({ outcome: 'sent', unit: 'SERVICE_MESSAGE', providerIdUnrecorded: true });
    const idempotencyKey = key();
    const r = await sendVia(s, 'whatsapp', { idempotencyKey });
    expect(r.reminder).toMatchObject({ status: 'sent', reasonCode: 'provider_id_unrecorded' });

    /* The same request again is the stored answer, not a second message. */
    const again = await sendVia(s, 'whatsapp', { idempotencyKey });
    expect(again.replayed).toBe(true);
    expect(again.reminder).toMatchObject({ status: 'sent', reasonCode: 'provider_id_unrecorded' });
    expect(whatsappCalls).toHaveLength(1);
  });

  it('refuses a customer with no phone', async () => {
    const s = await seed({ phone: null });
    await approvePhone(s);
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder).toMatchObject({ status: 'blocked', reasonCode: 'no_contact' });
    expect(whatsappCalls).toHaveLength(0);
  });
});

describe('an attempt that cannot be finished or repeated wrongly', () => {
  it('shows a reminder stuck in sending as uncertain, never as still sending, and does not resend it', async () => {
    const s = await seed();
    await approvePhone(s);
    const idempotencyKey = key();
    const first = await sendEmail(s, { attest: true, idempotencyKey });
    // Simulate a crash after the provider call: the row never left 'sending'.
    await rows(
      s.businessId,
      sql`UPDATE invoice_reminders
             SET status = 'sending', reason_code = NULL, sent_at = NULL,
                 updated_at = now() - interval '30 minutes'
           WHERE id = ${first.reminder.id}::uuid`,
    );
    const history = await service().history(s.businessId, s.invoiceNumber);
    expect(history.items[0]).toMatchObject({
      status: 'uncertain',
      reasonCode: 'delivery_unconfirmed',
    });
    const again = await sendEmail(s, { attest: true, idempotencyKey });
    expect(again.replayed).toBe(true);
    expect(mail.outbox).toHaveLength(1);
  });

  it('leaves a recent sending row alone: it may still be in flight', async () => {
    const s = await seed();
    await approvePhone(s);
    const sent = await sendEmail(s, { attest: true });
    await rows(
      s.businessId,
      sql`UPDATE invoice_reminders SET status = 'sending', reason_code = NULL, sent_at = NULL
           WHERE id = ${sent.reminder.id}::uuid`,
    );
    const history = await service().history(s.businessId, s.invoiceNumber);
    expect(history.items[0]!.status).toBe('sending');
  });

  it('refuses a key that was already used for a different invoice instead of silently skipping it', async () => {
    const s = await seed();
    await approvePhone(s);
    const second = await withBusiness(appDb, s.businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: s.businessId,
        customerId: s.customerId,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'scarf', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 0,
        balanceDueK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-second',
        actor: 'system',
      }),
    );
    const idempotencyKey = key();
    await sendEmail(s, { attest: true, idempotencyKey });
    await expect(
      service().send(s.businessId, s.userId, {
        invoiceNumber: second.invoiceNumber,
        channels: ['email'],
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(ReminderKeyReused);
    expect(mail.outbox).toHaveLength(1);
  });
});

describe('both channels for one event', () => {
  const event = (s: Seeded, extra: { attest?: boolean; idempotencyKey?: string } = {}) =>
    service().send(s.businessId, s.userId, {
      invoiceNumber: s.invoiceNumber,
      channels: 'auto',
      idempotencyKey: extra.idempotencyKey ?? key(),
      ...(extra.attest === undefined ? {} : { attest: extra.attest }),
    });
  const byChannel = (out: Awaited<ReturnType<typeof event>>) =>
    Object.fromEntries(out.results.map((r) => [r.channel, r.reminder]));

  it('sends WhatsApp first and email as well, and records each channel on its own row', async () => {
    const s = await seed();
    await approvePhone(s);
    const out = await event(s, { attest: true });
    expect(out.results.map((r) => r.channel)).toEqual(['whatsapp', 'email']);
    expect(byChannel(out)['whatsapp']!.status).toBe('sent');
    expect(byChannel(out)['email']!.status).toBe('sent');
    expect(whatsappCalls).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
    const history = await service().history(s.businessId, s.invoiceNumber);
    expect(history.items.map((i) => i.channel).sort()).toEqual(['email', 'whatsapp']);
  });

  it('uses WhatsApp alone for a phone-only customer, with no phantom email row', async () => {
    const s = await seed({ email: null });
    await approvePhone(s);
    const out = await event(s);
    expect(out.results.map((r) => r.channel)).toEqual(['whatsapp']);
    expect(out.results[0]!.reminder.status).toBe('sent');
  });

  it('uses email alone for an email-only customer', async () => {
    const s = await seed({ phone: null });
    await approvePhone(s);
    const out = await event(s, { attest: true });
    expect(out.results.map((r) => r.channel)).toEqual(['email']);
    expect(out.results[0]!.reminder.status).toBe('sent');
    expect(whatsappCalls).toHaveLength(0);
  });

  it('records one honest refusal when the customer has neither a phone nor an email', async () => {
    const s = await seed({ phone: null, email: null });
    await approvePhone(s);
    const out = await event(s);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.reminder).toMatchObject({ status: 'blocked', reasonCode: 'no_contact' });
    expect(whatsappCalls).toHaveLength(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('lets email go when WhatsApp is outside its window, and says why WhatsApp did not', async () => {
    const s = await seed();
    await approvePhone(s);
    setWhatsappOutcome({ outcome: 'window_closed' });
    const out = byChannel(await event(s, { attest: true }));
    expect(out['whatsapp']).toMatchObject({
      status: 'blocked',
      reasonCode: 'window_closed_no_template',
    });
    expect(out['email']!.status).toBe('sent');
  });

  it("keeps one channel's failure off the other, and never repeats either on a repeat event", async () => {
    const s = await seed();
    await approvePhone(s);
    mail.uncertainNext = 1;
    const idempotencyKey = key();
    const first = byChannel(await event(s, { attest: true, idempotencyKey }));
    expect(first['whatsapp']!.status).toBe('sent');
    expect(first['email']).toMatchObject({
      status: 'uncertain',
      reasonCode: 'delivery_unconfirmed',
    });

    const again = await event(s, { attest: true, idempotencyKey });
    expect(again.results.every((r) => r.replayed)).toBe(true);
    expect(whatsappCalls).toHaveLength(1);
    expect(mail.attempts).toBe(1);
  });

  it('sends WhatsApp when the merchant has not attested for email, and blocks only the email', async () => {
    const s = await seed();
    await approvePhone(s);
    const out = byChannel(await event(s));
    expect(out['whatsapp']!.status).toBe('sent');
    expect(out['email']).toMatchObject({ status: 'blocked', reasonCode: 'attestation_required' });
    expect(mail.outbox).toHaveLength(0);
  });

  it('sends nothing on either channel once a real payment settles the invoice in full', async () => {
    const s = await seed();
    await approvePhone(s);
    await pay(s, 8_000_000);
    const out = await event(s, { attest: true });
    expect(out.results.map((r) => [r.channel, r.reminder.status, r.reminder.reasonCode])).toEqual([
      ['whatsapp', 'blocked', 'nothing_owing'],
      ['email', 'blocked', 'nothing_owing'],
    ]);
    expect(whatsappCalls).toHaveLength(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('imposes no waiting period: a finished event does not hold the next one', async () => {
    const s = await seed();
    await approvePhone(s);
    await event(s, { attest: true });
    const again = byChannel(await event(s));
    expect(again['whatsapp']).toMatchObject({ status: 'sent' });
    expect(again['email']).toMatchObject({ status: 'sent' });
    expect(whatsappCalls).toHaveLength(2);
    expect(mail.outbox).toHaveLength(2);
  });

  it("shows the merchant's changed public phone on the next event, never the old one", async () => {
    const s = await seed();
    await approvePhone(s);
    await event(s, { attest: true });
    await service().setPublicContact(s.businessId, '08055550000');
    await event(s);
    expect(whatsappCalls.at(-1)!.text).toContain('+2348055550000');
    expect(mail.outbox.at(-1)!.text).toContain('+2348055550000');
    expect(mail.outbox.at(-1)!.text).not.toContain('+2348031112222');
  });
});

describe('tenancy', () => {
  it("never shows or sends another business's reminders, even for the same invoice number", async () => {
    const a = await seed({ name: 'A Ltd' });
    const b = await seed({ name: 'B Ltd' });
    // Invoice numbers run per business, so both hold the same number: each sees only its own.
    expect(a.invoiceNumber).toBe(b.invoiceNumber);
    await approvePhone(a);
    await sendEmail(a, { attest: true });

    expect((await service().history(a.businessId, a.invoiceNumber)).items).toHaveLength(1);
    expect((await service().history(b.businessId, b.invoiceNumber)).items).toHaveLength(0);
    expect(await rows(b.businessId, sql`SELECT 1 FROM invoice_reminders`)).toHaveLength(0);
    expect(await rows(b.businessId, sql`SELECT 1 FROM reminder_attestations`)).toHaveLength(0);

    await expect(service().history(b.businessId, 'INV-2026-999999')).rejects.toBeInstanceOf(
      ReminderInvoiceNotFound,
    );
    // B has no approved phone, so B's own request is refused on B's facts, not A's.
    expect((await sendEmail(b, { attest: true })).reminder.reasonCode).toBe('no_public_contact');
  });
});

/** An email sender that stays "with the provider" until released, so an overlap is deterministic. */
function gatedSender() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sends = 0;
  let inside = 0;
  let maxInside = 0;
  const sender: EmailSender = {
    available: true,
    send: async () => {
      sends += 1;
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      entered();
      await gate;
      inside -= 1;
    },
  };
  return { sender, release, started, stats: () => ({ sends, maxInside }) };
}

describe('one reminder in flight per invoice and channel, whatever the key (REM-02)', () => {
  it('refuses a different key while the first is with the provider, and sends once it has settled', async () => {
    const s = await seed();
    await approvePhone(s);
    const gated = gatedSender();
    const first = sendVia(s, 'email', { attest: true, sender: gated.sender });
    await gated.started;

    // Five more requests, each with its own key, arrive while the first is still in flight.
    const during = await Promise.all(
      Array.from({ length: 5 }, () => sendVia(s, 'email', { attest: true, sender: gated.sender })),
    );
    expect(during.map((r) => [r.reminder.status, r.reminder.reasonCode])).toEqual(
      Array(5).fill(['blocked', 'reminder_in_flight']),
    );
    expect(gated.stats()).toEqual({ sends: 1, maxInside: 1 });

    gated.release();
    expect((await first).reminder.status).toBe('sent');

    // No waiting period follows: the next request is judged on its own facts and goes.
    expect((await sendEmail(s)).reminder.status).toBe('sent');
    expect(mail.outbox).toHaveLength(1);
  });

  it('never has two reminders with the provider at once when different keys race', async () => {
    const s = await seed();
    await approvePhone(s);
    const gated = gatedSender();
    const raced = Promise.all(
      Array.from({ length: 6 }, () => sendVia(s, 'email', { attest: true, sender: gated.sender })),
    );
    await gated.started;
    // Let every loser reach its refusal while the winner is held at the provider.
    await new Promise((resolve) => setTimeout(resolve, 300));
    gated.release();
    const results = await raced;
    expect(gated.stats()).toEqual({ sends: 1, maxInside: 1 });
    expect(results.filter((r) => r.reminder.status === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r.reminder.reasonCode === 'reminder_in_flight')).toHaveLength(5);
    const [attested] = await rows<{ n: string }>(
      s.businessId,
      sql`SELECT count(*)::text AS n FROM reminder_attestations`,
    );
    expect(attested!.n).toBe('1');
  });

  it('holds only its own channel: WhatsApp goes while an email is in flight', async () => {
    const s = await seed();
    await approvePhone(s);
    const gated = gatedSender();
    const email = sendVia(s, 'email', { attest: true, sender: gated.sender });
    await gated.started;
    expect((await sendVia(s, 'whatsapp')).reminder.status).toBe('sent');
    gated.release();
    await email;
  });

  it('holds only its own invoice', async () => {
    const a = await seed();
    await approvePhone(a);
    const gated = gatedSender();
    const first = sendVia(a, 'email', { attest: true, sender: gated.sender });
    await gated.started;
    const other = await withBusiness(appDb, a.businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: a.businessId,
        customerId: a.customerId,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'shoes', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 0,
        balanceDueK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-second-invoice',
        actor: 'system',
      }),
    );
    const second = await service().send(a.businessId, a.userId, {
      invoiceNumber: other.invoiceNumber,
      channels: ['email'],
      idempotencyKey: key(),
      attest: true,
    });
    expect(second.results[0]!.reminder.status).toBe('sent');
    gated.release();
    await first;
  });

  it('does not let a failed, refused or uncertain attempt hold the invoice', async () => {
    const s = await seed();
    await approvePhone(s);
    mail.failNext = true;
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('uncertain');
    // An unknown outcome is never resent by the system; the merchant's own new request is a new
    // decision, judged on the facts it carries, with no waiting period invented here.
    expect((await sendEmail(s)).reminder.status).toBe('sent');
    expect(mail.outbox).toHaveLength(1);
  });

  it('holds while a live attempt is unsettled, and releases when a dead one is settled as uncertain', async () => {
    const s = await seed();
    await approvePhone(s);
    const first = await sendVia(s, 'whatsapp');
    // The process died after the provider call: the row is left `sending`.
    await rows(
      s.businessId,
      sql`UPDATE invoice_reminders SET status = 'sending', sent_at = NULL
           WHERE id = ${first.reminder.id}::uuid`,
    );
    expect((await sendVia(s, 'whatsapp')).reminder.reasonCode).toBe('reminder_in_flight');
    expect(whatsappCalls).toHaveLength(1);

    // Past the stale threshold the dead attempt settles to uncertain (never resent) and stops
    // holding the invoice.
    await rows(
      s.businessId,
      sql`UPDATE invoice_reminders SET updated_at = now() - interval '11 minutes'
           WHERE id = ${first.reminder.id}::uuid`,
    );
    expect((await sendVia(s, 'whatsapp')).reminder.status).toBe('sent');
    const [settled] = await rows<{ status: string }>(
      s.businessId,
      sql`SELECT status FROM invoice_reminders WHERE id = ${first.reminder.id}::uuid`,
    );
    expect(settled!.status).toBe('uncertain');
    expect(whatsappCalls).toHaveLength(2);
  });
});

describe('the balance is read under the payment lock (REM-02)', () => {
  it('waits for a payment being posted, then refuses the invoice it settled', async () => {
    const s = await seed();
    await approvePhone(s);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let posted!: () => void;
    const lockTaken = new Promise<void>((resolve) => (posted = resolve));
    const payment = withBusiness(appDb, s.businessId, async (tx) => {
      await settleRepo.recordMerchantPayment(tx, {
        businessId: s.businessId,
        invoiceId: s.invoiceId,
        amountK: 8_000_000,
        method: 'transfer',
        sourceType: 'dashboard',
        sourceId: s.invoiceNumber,
        actor: 'owner',
      });
      posted();
      await held;
    });
    await lockTaken;

    let settled = false;
    const reminder = sendEmail(s, { attest: true }).finally(() => (settled = true));
    /* Until the reminder is seen waiting on a lock (or has finished without waiting, which is the
     * bug), the payment stays uncommitted. */
    for (let i = 0; i < 100 && !settled; i += 1) {
      const [waiting] = [
        ...(await appDb.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )),
      ];
      if (waiting!.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await payment;

    const { reminder: row } = await reminder;
    expect(row).toMatchObject({ status: 'blocked', reasonCode: 'nothing_owing', balanceK: 0 });
    expect(mail.outbox).toHaveLength(0);
  });
});

describe('void, credit and reversal (REM-02)', () => {
  it('refuses a voided invoice', async () => {
    const s = await seed();
    await approvePhone(s);
    const voided = await withBusiness(appDb, s.businessId, (tx) =>
      issueRepo.voidInvoice(tx, s.businessId, s.invoiceNumber, 'wrong customer', 'owner'),
    );
    expect(voided.outcome).toBe('voided');
    for (const channel of ['whatsapp', 'email'] as const) {
      expect((await sendVia(s, channel, { attest: true })).reminder).toMatchObject({
        status: 'blocked',
        reasonCode: 'nothing_owing',
      });
    }
    expect(whatsappCalls).toHaveLength(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('refuses an invoice a credit note has fully credited', async () => {
    const s = await seed();
    await approvePhone(s);
    await pay(s, 3_000_000);
    const credited = await withBusiness(appDb, s.businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId: s.businessId,
        invoiceNumber: s.invoiceNumber,
        amountK: 8_000_000,
        reason: 'goods returned',
        actor: 'owner',
      }),
    );
    expect(credited.outcome).toBe('credited');
    const [invoice] = await rows<{ status: string }>(
      s.businessId,
      sql`SELECT status FROM invoices`,
    );
    expect(invoice!.status).toBe('credited');
    for (const channel of ['whatsapp', 'email'] as const) {
      expect((await sendVia(s, channel, { attest: true })).reminder).toMatchObject({
        status: 'blocked',
        reasonCode: 'nothing_owing',
      });
    }
    expect(whatsappCalls).toHaveLength(0);
    expect(mail.outbox).toHaveLength(0);
  });

  it('quotes the remaining balance after a partial payment', async () => {
    const s = await seed();
    await approvePhone(s);
    await pay(s, 3_000_000);
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder).toMatchObject({ status: 'sent', balanceK: 5_000_000 });
    expect(whatsappCalls[0]!.text).toContain('50,000');
  });

  it('quotes the reopened balance once a reversal reopens it', async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendVia(s, 'whatsapp')).reminder.status).toBe('sent');
    const paid = await pay(s, 8_000_000);
    expect((await sendVia(s, 'whatsapp')).reminder.reasonCode).toBe('nothing_owing');

    const reopened = await withBusiness(appDb, s.businessId, (tx) =>
      unwindAllocations(tx, {
        businessId: s.businessId,
        paymentId: paid.paymentId,
        amountK: 8_000_000,
        reason: 'transfer reversed by the bank',
        sourceType: 'payment_reversal',
        sourceId: 'reversal-test-1',
      }),
    );
    expect(reopened.invoicesReopened).toEqual([s.invoiceNumber]);

    const again = await sendVia(s, 'whatsapp');
    expect(again.reminder).toMatchObject({ status: 'sent', balanceK: 8_000_000 });
    expect(whatsappCalls).toHaveLength(2);
  });
});

describe('merchant payment instructions (REM-04, OWN-64)', () => {
  const bank = {
    bankName: 'GTBank',
    accountName: 'Adaeze Fabrics Ltd',
    accountNumber: '0123456789',
  };
  const save = (s: Seeded, input = bank) =>
    service().setPaymentInstruction(s.businessId, s.userId, input);

  it('puts the approved account, the invoice reference and the CURRENT balance in the email and the WhatsApp text', async () => {
    const s = await seed();
    await approvePhone(s);
    expect(await save(s)).toEqual({ ok: true });
    await pay(s, 3_000_000);

    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect((await sendVia(s, 'whatsapp')).reminder.status).toBe('sent');
    const email = mail.outbox[0]!.text;
    const wa = whatsappCalls[0]!.text;
    for (const text of [email, wa]) {
      expect(text).toContain('50,000');
      expect(text).toContain('Adaeze Fabrics Ltd');
      expect(text).toContain('GTBank');
      expect(text).toContain('0123456789');
      expect(text).toContain(`quote invoice ${s.invoiceNumber}`);
    }
  });

  it('shows no account when none was approved: the phone only, nothing invented', async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect(mail.outbox[0]!.text).not.toMatch(/account number/i);
    expect(mail.outbox[0]!.text).toContain('+2348031112222');
  });

  it('stores nothing for invalid details and keeps the previous approved account', async () => {
    const s = await seed();
    await approvePhone(s);
    await save(s);
    for (const bad of [
      { ...bank, accountNumber: '12345' },
      { ...bank, bankName: '' },
      { ...bank, accountName: '<script>' },
    ]) {
      const r = await save(s, bad);
      expect(r.ok).toBe(false);
    }
    expect((await service().paymentInstruction(s.businessId)).instruction).toEqual(bank);
  });

  it('replaces on update and falls back to the phone after removal', async () => {
    const s = await seed();
    await approvePhone(s);
    await save(s);
    await save(s, {
      bankName: 'Access Bank',
      accountName: 'Ada O.',
      accountNumber: '0987 654 321',
    });
    await sendEmail(s, { attest: true });
    expect(mail.outbox[0]!.text).toContain('Access Bank');
    expect(mail.outbox[0]!.text).toContain('0987654321');
    expect(mail.outbox[0]!.text).not.toContain('0123456789');

    await service().clearPaymentInstruction(s.businessId);
    expect((await service().paymentInstruction(s.businessId)).instruction).toBeNull();
    await sendEmail(s);
    expect(mail.outbox[1]!.text).not.toMatch(/account number/i);
  });

  it("never carries one business's account to another business's customer, and records who approved it", async () => {
    const a = await seed({ name: 'Alpha Ltd' });
    const b = await seed({ name: 'Beta Ltd' });
    await approvePhone(a);
    await approvePhone(b);
    await save(a);
    await sendEmail(b, { attest: true });
    expect(mail.outbox[0]!.text).not.toContain('0123456789');
    expect((await service().paymentInstruction(b.businessId)).instruction).toBeNull();
    const [approval] = await rows<{ by: string; at: Date | null }>(
      a.businessId,
      sql`SELECT payment_instruction_approved_by::text AS by, payment_instruction_approved_at AS at FROM businesses`,
    );
    expect(approval!.by).toBe(a.userId);
    expect(approval!.at).not.toBeNull();
  });

  it('cannot be stored half-filled, unapproved, unattributed or malformed, even by a direct write', async () => {
    const s = await seed();
    const writes = [
      sql`UPDATE businesses SET payment_account_number = '0123456789'`,
      sql`UPDATE businesses SET payment_bank_name = 'B', payment_account_name = 'N', payment_account_number = '0123456789'`,
      sql`UPDATE businesses SET payment_bank_name = 'B', payment_account_name = 'N', payment_account_number = '0123456789', payment_instruction_approved_at = now()`,
      sql`UPDATE businesses SET payment_bank_name = 'B', payment_account_name = 'N', payment_account_number = NULL, payment_instruction_approved_at = now(), payment_instruction_approved_by = ${s.userId}::uuid`,
      sql`UPDATE businesses SET payment_bank_name = 'B', payment_account_name = 'N', payment_account_number = '12345', payment_instruction_approved_at = now(), payment_instruction_approved_by = ${s.userId}::uuid`,
    ];
    for (const write of writes) {
      let caught: unknown;
      await withBusiness(appDb, s.businessId, (tx) => tx.execute(write)).catch((e: unknown) => {
        caught = e;
      });
      const cause = (caught as { cause?: { constraint_name?: string } } | undefined)?.cause;
      const name =
        cause?.constraint_name ?? (caught as { constraint_name?: string })?.constraint_name;
      expect(name ?? String(caught)).toContain('businesses_payment_instruction_all_or_nothing');
    }
  });

  it('is configurable by the owner only; the delegate may read, the accountant neither', () => {
    const roles = (name: keyof RemindersController) =>
      Reflect.getMetadata(ROLES_KEY, RemindersController.prototype[name]) as string[];
    expect(roles('setPaymentInstruction')).toEqual(['owner']);
    expect(roles('clearPaymentInstruction')).toEqual(['owner']);
    expect(roles('paymentInstruction')).toEqual(['owner', 'delegate']);
  });
});
