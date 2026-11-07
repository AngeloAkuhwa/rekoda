/**
 * Where a customer's reply to a reminder email goes (OWN-83, superseding OWN-81): to the business
 * that issued the invoice, at its own verified email. Without a verified business email the email
 * reminder is not sent at all (`business_email_unverified`); WhatsApp may still go. Rekoda support
 * (REKODA_SUPPORT_EMAIL) is never the Reply-To. Split from reminder.integration.test.ts.
 */
import { issueRepo } from '@rekoda/db';
import { describe, expect, it } from 'vitest';
import { sql } from '@rekoda/db';
import { ReminderService } from './reminder.service.js';
import {
  BUSINESS_EMAIL,
  appDb,
  approvePhone,
  config,
  key,
  mail,
  rows,
  seedWith,
  sendEmail,
  setBusinessEmail,
  setWhatsappOutcome,
  useReminderHarness,
  whatsapp,
  whatsappCalls,
} from './reminder.fixtures.js';

const seed = (opts?: Parameters<typeof seedWith>[1]) => seedWith(issueRepo.issueSale, opts);

useReminderHarness();

describe('the reminder email Reply-To is the business (OWN-83)', () => {
  it("sends replies to the business's own verified email, never to Rekoda support", async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.replyTo).toBe(BUSINESS_EMAIL);
    expect(mail.outbox[0]!.replyTo).not.toBe(config.supportEmail);
    expect(JSON.stringify(mail.outbox[0])).not.toContain('support@rekoda.test');
    // Still sent from Rekoda's own address under the business's display name.
    expect(mail.outbox[0]!.fromName).toBe('Adaeze Fabrics via Rekoda');
  });

  it("uses each business's own address: two businesses never share or swap a Reply-To", async () => {
    const a = await seed({ name: 'Adaeze Fabrics', businessEmail: 'accounts@adaeze.example.ng' });
    const b = await seed({ name: 'Bisi Shoes', businessEmail: 'hello@bisi.example.ng' });
    await approvePhone(a);
    await approvePhone(b);
    await sendEmail(b, { attest: true });
    await sendEmail(a, { attest: true });
    expect(mail.outbox.map((m) => [m.fromName, m.replyTo])).toEqual([
      ['Bisi Shoes via Rekoda', 'hello@bisi.example.ng'],
      ['Adaeze Fabrics via Rekoda', 'accounts@adaeze.example.ng'],
    ]);
  });

  it('does not send the email when the business has no email at all', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    const r = await sendEmail(s, { attest: true });
    expect(r.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'business_email_unverified',
    });
    expect(mail.outbox).toHaveLength(0);
    expect(mail.attempts).toBe(0);
  });

  it('does not send the email while the business email is only typed in, not confirmed', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    await setBusinessEmail(appDb, config.vaultKey, s.businessId, 'typed@adaeze.example.ng', false);
    const r = await sendEmail(s, { attest: true });
    expect(r.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'business_email_unverified',
    });
    expect(mail.attempts).toBe(0);
  });

  it('stops sending when the business changes to a new address it has not confirmed', async () => {
    const s = await seed();
    await approvePhone(s);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    // A changed address clears the proof (setBillingEmailSealed), so the old one is not reused.
    await setBusinessEmail(appDb, config.vaultKey, s.businessId, 'new@adaeze.example.ng', false);
    const r = await sendEmail(s);
    expect(r.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'business_email_unverified',
    });
    expect(mail.outbox).toHaveLength(1);
    expect(JSON.stringify(mail.outbox)).not.toContain('new@adaeze.example.ng');
  });

  it('blocks rather than guesses when the verified seal cannot be opened', async () => {
    const s = await seed();
    await approvePhone(s);
    await rows(s.businessId, sql`UPDATE businesses SET billing_email_sealed = 'not-a-seal'`);
    const r = await sendEmail(s, { attest: true });
    expect(r.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'business_email_unverified',
    });
    expect(mail.attempts).toBe(0);
  });

  it('names the business email before asking for the attestation', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    const r = await sendEmail(s, { attest: false });
    expect(r.reminder).toMatchObject({
      status: 'blocked',
      reasonCode: 'business_email_unverified',
    });
  });

  it('confirming the business email lets email reminders go, with that address as Reply-To', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    await setBusinessEmail(appDb, config.vaultKey, s.businessId, 'later@adaeze.example.ng', false);
    expect((await sendEmail(s, { attest: true })).reminder.reasonCode).toBe(
      'business_email_unverified',
    );
    await rows(s.businessId, sql`UPDATE businesses SET billing_email_verified_at = now()`);
    // A blocked attempt records no attestation, so the next one still carries it.
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect(mail.outbox[0]!.replyTo).toBe('later@adaeze.example.ng');
  });

  it('no Rekoda support address is needed to send: the Reply-To never depends on it', async () => {
    const s = await seed();
    await approvePhone(s);
    const bare = new ReminderService({ ...config, supportEmail: null }, appDb, mail, whatsapp);
    const out = await bare.send(s.businessId, s.userId, {
      invoiceNumber: s.invoiceNumber,
      channels: ['email'],
      idempotencyKey: key(),
      attest: true,
    });
    expect(out.results[0]!.reminder.status).toBe('sent');
    expect(mail.outbox[0]!.replyTo).toBe(BUSINESS_EMAIL);
  });
});

describe('the channel decision without a verified business email (OWN-83)', () => {
  it("'auto' sends on WhatsApp only and does not try email", async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    const out = await new ReminderService(config, appDb, mail, whatsapp).send(
      s.businessId,
      s.userId,
      { invoiceNumber: s.invoiceNumber, channels: 'auto', idempotencyKey: key(), attest: true },
    );
    expect(out.results.map((r) => [r.channel, r.reminder.status])).toEqual([['whatsapp', 'sent']]);
    expect(whatsappCalls).toHaveLength(1);
    expect(mail.attempts).toBe(0);
  });

  it("'auto' treats a verified email whose seal cannot be opened as none: WhatsApp only", async () => {
    const s = await seed();
    await approvePhone(s);
    await rows(s.businessId, sql`UPDATE businesses SET billing_email_sealed = 'not-a-seal'`);
    const out = await new ReminderService(config, appDb, mail, whatsapp).send(
      s.businessId,
      s.userId,
      { invoiceNumber: s.invoiceNumber, channels: 'auto', idempotencyKey: key(), attest: true },
    );
    expect(out.results.map((r) => r.channel)).toEqual(['whatsapp']);
    expect(mail.attempts).toBe(0);
  });

  it("'auto' with a verified business email tries both channels", async () => {
    const s = await seed();
    await approvePhone(s);
    const out = await new ReminderService(config, appDb, mail, whatsapp).send(
      s.businessId,
      s.userId,
      { invoiceNumber: s.invoiceNumber, channels: 'auto', idempotencyKey: key(), attest: true },
    );
    expect(out.results.map((r) => [r.channel, r.reminder.status])).toEqual([
      ['whatsapp', 'sent'],
      ['email', 'sent'],
    ]);
    expect(mail.outbox[0]!.replyTo).toBe(BUSINESS_EMAIL);
  });

  it("'auto' with no WhatsApp number names the business email as the reason, not a silent email", async () => {
    const s = await seed({ businessEmail: null, phone: null });
    await approvePhone(s);
    const out = await new ReminderService(config, appDb, mail, whatsapp).send(
      s.businessId,
      s.userId,
      { invoiceNumber: s.invoiceNumber, channels: 'auto', idempotencyKey: key(), attest: true },
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      channel: 'email',
      reminder: { status: 'blocked', reasonCode: 'business_email_unverified' },
    });
    expect(mail.attempts).toBe(0);
    expect(whatsappCalls).toHaveLength(0);
  });

  it('a WhatsApp reminder the customer cannot receive is refused with its own reason, and email stays unsent', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    setWhatsappOutcome({ outcome: 'window_closed' });
    const out = await new ReminderService(config, appDb, mail, whatsapp).send(
      s.businessId,
      s.userId,
      { invoiceNumber: s.invoiceNumber, channels: 'auto', idempotencyKey: key(), attest: true },
    );
    expect(out.results).toEqual([
      expect.objectContaining({
        channel: 'whatsapp',
        reminder: expect.objectContaining({
          status: 'blocked',
          reasonCode: 'window_closed_no_template',
        }),
      }),
    ]);
    expect(mail.attempts).toBe(0);
  });

  it('the batch preview forecasts the same: email ineligible for the business email, WhatsApp eligible', async () => {
    const s = await seed({ businessEmail: null });
    await approvePhone(s);
    const preview = await new ReminderService(config, appDb, mail, whatsapp).preview(s.businessId, {
      invoiceNumbers: [s.invoiceNumber],
      channels: ['whatsapp', 'email'],
      attest: true,
    });
    expect(preview.recipients[0]!.channels).toEqual([
      { channel: 'whatsapp', eligible: true, reasonCode: null },
      { channel: 'email', eligible: false, reasonCode: 'business_email_unverified' },
    ]);
  });
});
