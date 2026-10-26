/**
 * Customer payment reminders, slice A (N1, OWN-43, OWN-57).
 *
 * The claims pinned here, each against the real database under RLS with provider doubles:
 * a reminder quotes the balance read now and goes only with a public phone, an attestation and
 * no opt-out or stop; one key sends once however it is repeated or raced; an unknown provider
 * outcome is never resent; the opt-out token cannot be forged or aimed at another business;
 * WhatsApp outside the window sends nothing and says why; and no sale, invoice, payment or ledger
 * row is created or changed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailSuppressionKey, signReminderOptOut } from '@rekoda/core';
import { encryptFacet } from '@rekoda/core/vault';
import { matchKeyFor } from '@rekoda/core/vault';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { MockEmailSender, NoEmailSender, type EmailSender } from '../email/email.port.js';
import { EmailSuppressedError } from '../email/suppressing.sender.js';
import type { SendCustomerTextOutcome } from '../channels/waba-templates.service.js';
import {
  ReminderInvoiceNotFound,
  ReminderKeyReused,
  ReminderService,
  type ReminderWhatsApp,
} from './reminder.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let config: ApiConfig;
let mail: MockEmailSender;
let whatsappOutcome: SendCustomerTextOutcome;
let whatsappCalls: Array<{ to: string; text: string }>;

const whatsapp: ReminderWhatsApp = {
  async sendCustomerText(_businessId, input) {
    whatsappCalls.push(input);
    return whatsappOutcome;
  },
};

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = { ...loadConfig(), webUrl: 'https://app.rekoda.test' };
});

afterAll(async () => {
  await closeApp?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  mail = new MockEmailSender();
  whatsappOutcome = { outcome: 'sent', unit: 'SERVICE_MESSAGE' };
  whatsappCalls = [];
});

const service = (sender: EmailSender = mail) =>
  new ReminderService(config, appDb, sender, whatsapp);

let seq = 0;
const key = () => `reminder-key-${(seq += 1)}-${randomBytes(4).toString('hex')}`;

interface Seeded {
  businessId: string;
  userId: string;
  invoiceNumber: string;
  invoiceId: string;
  customerId: string;
}

const EMAIL = 'ada@customer.example.ng';

async function seed(opts: { name?: string; email?: string | null; phone?: string | null } = {}) {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481750${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: opts.name ?? 'Adaeze Fabrics',
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  const identities: customersRepo.IdentityInput[] = [];
  const email = opts.email === undefined ? EMAIL : opts.email;
  const phone = opts.phone === undefined ? '+2348039998888' : opts.phone;
  if (email) {
    identities.push({
      facet: 'email',
      ciphertext: encryptFacet(email, config.vaultKey, `${businessId}:email`),
      matchKey: null,
    });
  }
  if (phone) {
    identities.push({
      facet: 'phone',
      ciphertext: encryptFacet(phone, config.vaultKey, `${businessId}:phone`),
      matchKey: matchKeyFor(businessId, 'phone', phone, config.matchKey),
    });
  }
  const customer = await customersRepo.createCustomerWithIdentities(
    appDb,
    businessId,
    'X81',
    identities,
  );
  const sale = await withBusiness(appDb, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: 'CUSTOMER_X81',
      items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
      subtotalK: 8_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 8_000_000,
      paidK: 0,
      balanceDueK: 8_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${seq}`,
      actor: 'system',
    }),
  );
  return {
    businessId,
    userId: user.id,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    customerId: customer.id,
  } satisfies Seeded;
}

const approvePhone = (s: Seeded) => service().setPublicContact(s.businessId, '08031112222');

const rows = async <T extends Record<string, unknown>>(
  businessId: string,
  q: ReturnType<typeof sql>,
) => withBusiness(appDb, businessId, async (tx) => [...(await tx.execute<T>(q))]);

const books = async (businessId: string) => {
  const [r] = await rows<{ invoices: string; ledger: string; payments: string }>(
    businessId,
    sql`SELECT (SELECT count(*) FROM invoices)::text AS invoices,
               (SELECT count(*) FROM ledger_transactions)::text AS ledger,
               (SELECT count(*) FROM payments)::text AS payments`,
  );
  return r;
};

/** One channel of one event, with the same per-channel key the dual-channel door derives. */
const sendVia = async (
  s: Seeded,
  channel: 'email' | 'whatsapp',
  extra: { attest?: boolean; idempotencyKey?: string; sender?: EmailSender } = {},
) => {
  const out = await service(extra.sender).send(s.businessId, s.userId, {
    invoiceNumber: s.invoiceNumber,
    channels: [channel],
    idempotencyKey: extra.idempotencyKey ?? key(),
    ...(extra.attest === undefined ? {} : { attest: extra.attest }),
  });
  return out.results[0]!;
};
const sendEmail = (s: Seeded, extra: { attest?: boolean; idempotencyKey?: string } = {}) =>
  sendVia(s, 'email', extra);

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
    await rows(
      s.businessId,
      sql`UPDATE invoices SET balance_due_k = 3000000, status = 'partially_paid'`,
    );
    const part = await sendEmail(s, { attest: true });
    expect(part.reminder.balanceK).toBe(3_000_000);
    expect(mail.outbox.at(-1)!.text).toContain('30,000');

    await rows(s.businessId, sql`UPDATE invoices SET balance_due_k = 0, status = 'paid'`);
    const paid = await sendEmail(s);
    expect(paid.reminder).toMatchObject({ status: 'blocked', reasonCode: 'nothing_owing' });
    expect(mail.outbox).toHaveLength(1);
  });

  it('stops for an invoice the merchant stopped, and resumes when they undo it', async () => {
    const s = await seed();
    await approvePhone(s);
    await service().setStopped(s.businessId, s.invoiceNumber, true);
    expect((await sendEmail(s, { attest: true })).reminder.reasonCode).toBe('reminders_stopped');
    expect((await service().history(s.businessId, s.invoiceNumber)).remindersStopped).toBe(true);

    await service().setStopped(s.businessId, s.invoiceNumber, false);
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

  it('records a definite provider failure as failed, and a suppressed address as blocked', async () => {
    const s = await seed();
    await approvePhone(s);
    mail.failNext = true;
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('uncertain');

    const suppressed: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailSuppressedError();
      },
    };
    const r = await sendVia(s, 'email', { sender: suppressed });
    expect(r.reminder).toMatchObject({ status: 'blocked', reasonCode: 'address_suppressed' });
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
    whatsappOutcome = outcome;
    const r = await sendVia(s, 'whatsapp');
    expect(r.reminder).toMatchObject({ status, reasonCode });
    expect(mail.outbox).toHaveLength(0);
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
    whatsappOutcome = { outcome: 'window_closed' };
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

  it('sends nothing on either channel once the invoice is paid before dispatch', async () => {
    const s = await seed();
    await approvePhone(s);
    await rows(s.businessId, sql`UPDATE invoices SET balance_due_k = 0, status = 'paid'`);
    const out = await event(s, { attest: true });
    expect(out.results.map((r) => r.reminder.reasonCode)).toEqual([
      'nothing_owing',
      'nothing_owing',
    ]);
    expect(whatsappCalls).toHaveLength(0);
    expect(mail.outbox).toHaveLength(0);
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
