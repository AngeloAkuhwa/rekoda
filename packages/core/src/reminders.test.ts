import { describe, expect, it } from 'vitest';
import {
  composeEmailReminder,
  composeWhatsAppReminder,
  validatePaymentInstruction,
  reminderBlock,
  reminderTemplateParameters,
  senderDisplayName,
  signReminderOptOut,
  verifyReminderOptOut,
  type ReminderFacts,
  type ReminderPreflight,
} from './reminders.js';

const ready: ReminderPreflight = {
  invoiceFound: true,
  invoiceStatus: 'issued',
  balanceDueK: 150_000,
  remindersStopped: false,
  hasCustomer: true,
  hasContact: true,
  publicContactApproved: true,
  needsAttestation: true,
  attested: true,
  optedOut: false,
  reminderInFlight: false,
};

describe('reminderBlock', () => {
  it('lets a chaseable, attested, reachable invoice go', () => {
    expect(reminderBlock(ready)).toBeNull();
  });

  it.each([
    [{ invoiceFound: false }, 'invoice_not_found'],
    [{ invoiceStatus: 'paid' }, 'nothing_owing'],
    [{ invoiceStatus: 'voided' }, 'nothing_owing'],
    [{ invoiceStatus: 'credited' }, 'nothing_owing'],
    [{ balanceDueK: 0 }, 'nothing_owing'],
    [{ remindersStopped: true }, 'reminders_stopped'],
    [{ hasCustomer: false }, 'no_customer'],
    [{ hasContact: false }, 'no_contact'],
    [{ publicContactApproved: false }, 'no_public_contact'],
    [{ optedOut: true }, 'customer_opted_out'],
    [{ attested: false }, 'attestation_required'],
    [{ reminderInFlight: true }, 'reminder_in_flight'],
  ] as const)('refuses %j with %s', (change, reason) => {
    expect(reminderBlock({ ...ready, ...change })).toBe(reason);
  });

  it('does not ask for an attestation on a channel that needs none', () => {
    expect(reminderBlock({ ...ready, needsAttestation: false, attested: false })).toBeNull();
  });

  it('names the stop and the opt-out before the attestation, so a customer who left is never asked about', () => {
    expect(reminderBlock({ ...ready, optedOut: true, attested: false })).toBe('customer_opted_out');
  });
});

describe('one reminder in flight per invoice and channel (REM-02)', () => {
  it('names every reason a merchant can act on before the in-flight hold', () => {
    expect(reminderBlock({ ...ready, reminderInFlight: true, invoiceStatus: 'paid' })).toBe(
      'nothing_owing',
    );
    expect(reminderBlock({ ...ready, reminderInFlight: true, optedOut: true })).toBe(
      'customer_opted_out',
    );
    expect(reminderBlock({ ...ready, reminderInFlight: true, attested: false })).toBe(
      'attestation_required',
    );
  });

  it('imposes no waiting period: with nothing in flight the reminder may go', () => {
    expect(reminderBlock({ ...ready, reminderInFlight: false })).toBeNull();
  });
});

const facts: ReminderFacts = {
  businessName: 'Ada Stores',
  publicPhone: '+2348031234567',
  invoiceNumber: 'INV-0007',
  balanceDueK: 150_050,
  dueDate: new Date('2026-10-20T09:00:00Z'),
  now: new Date('2026-10-25T09:00:00Z'),
};

describe('the email', () => {
  const mail = composeEmailReminder(facts, 'https://api.example/r/stop?t=abc');

  it('is "Business via Rekoda" with the merchant phone, the quoted balance and an opt-out', () => {
    expect(mail.fromName).toBe('Ada Stores via Rekoda');
    expect(mail.text).toContain('+2348031234567');
    expect(mail.text).toContain('₦1,500.50');
    expect(mail.text).toContain('5 days overdue');
    expect(mail.text).toContain('https://api.example/r/stop?t=abc');
    expect(mail.subject).toContain('INV-0007');
  });

  it('never presents Rekoda as the creditor', () => {
    expect(mail.text).toMatch(/Rekoda is not the\s+creditor/);
  });

  it('reports a future deadline as its date, never as due now, and counts a single day', () => {
    const before = composeEmailReminder({ ...facts, now: new Date('2026-10-19T09:00:00Z') }, 'u');
    expect(before.text).toContain('is due on 20 October 2026');
    expect(before.text).not.toContain('is now due');
    const none = composeEmailReminder({ ...facts, dueDate: null }, 'u');
    expect(none.text).toContain('is outstanding');
    const sameDay = composeEmailReminder({ ...facts, now: new Date('2026-10-20T15:00:00Z') }, 'u');
    expect(sameDay.text).toContain('is now due');
    const one = composeEmailReminder({ ...facts, now: new Date('2026-10-21T09:00:00Z') }, 'u');
    expect(one.text).toContain('is one day overdue');
  });
});

describe('the WhatsApp text and template parameters', () => {
  it('carry the same facts, with the phone and a STOP instruction', () => {
    const text = composeWhatsAppReminder(facts);
    expect(text).toContain('Ada Stores');
    expect(text).toContain('₦1,500.50');
    expect(text).toContain('+2348031234567');
    expect(text).toContain('STOP');
    expect(reminderTemplateParameters(facts)).toEqual([
      'Ada Stores',
      'INV-0007',
      '₦1,500.50',
      '+2348031234567',
    ]);
  });
});

describe('senderDisplayName', () => {
  it('strips anything that could break out of an address header', () => {
    expect(senderDisplayName('Ada <evil@x.com>, "Stores"\r\nBcc: z@x.com')).toBe(
      'Ada evil x.com Stores Bcc: z x.com via Rekoda',
    );
    expect(senderDisplayName('   ')).toBe('Your supplier via Rekoda');
    expect(senderDisplayName('x'.repeat(200))).toBe(`${'x'.repeat(60)} via Rekoda`);
  });
});

describe('the opt-out token', () => {
  const secret = 'server-secret';
  const business = '11111111-2222-4333-8444-555555555555';
  const hash = 'a'.repeat(64);

  it('round-trips, and names no address', () => {
    const token = signReminderOptOut(secret, business, hash);
    expect(verifyReminderOptOut(secret, token)).toEqual({
      businessId: business,
      addressHash: hash,
    });
    expect(token).not.toContain('@');
  });

  it('rejects another secret, another business, another address, a cut token and no secret', () => {
    const token = signReminderOptOut(secret, business, hash);
    expect(verifyReminderOptOut('other', token)).toBeNull();
    expect(
      verifyReminderOptOut(secret, token.replace(business, '99999999-2222-4333-8444-555555555555')),
    ).toBeNull();
    expect(verifyReminderOptOut(secret, token.replace(hash, 'b'.repeat(64)))).toBeNull();
    expect(verifyReminderOptOut(secret, token.slice(0, -2))).toBeNull();
    expect(verifyReminderOptOut('', token)).toBeNull();
    expect(verifyReminderOptOut(secret, 'garbage')).toBeNull();
  });
});

describe('merchant payment instructions (REM-04, OWN-64)', () => {
  const instruction = {
    bankName: 'GTBank',
    accountName: 'Ada Stores Ltd',
    accountNumber: '0123456789',
  };

  it('validates a ten-digit account number and tolerates spaces and dashes, never repairs', () => {
    const ok = validatePaymentInstruction({ ...instruction, accountNumber: '0123 456-789' });
    expect(ok).toEqual({ ok: true, value: instruction });
    for (const bad of ['012345678', '01234567890', 'abcdefghij', '', '0123456789a', 12345678901]) {
      const r = validatePaymentInstruction({ ...instruction, accountNumber: bad });
      expect(r).toEqual({ ok: false, issues: ['account_number'] });
    }
  });

  it('refuses a missing, oversized, control-character or markup bank or account name', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bankName: '' }, 'bank_name'],
      [{ bankName: 'x'.repeat(61) }, 'bank_name'],
      [{ bankName: 'GT\u0000Bank' }, 'bank_name'],
      [{ accountName: '<b>Ada</b>' }, 'account_name'],
      [{ accountName: 'A' }, 'account_name'],
      [{ accountName: 42 }, 'account_name'],
    ];
    for (const [patch, issue] of cases) {
      const r = validatePaymentInstruction({ ...instruction, ...patch });
      expect(r).toEqual({ ok: false, issues: [issue] });
    }
  });

  it('collapses whitespace in names', () => {
    const r = validatePaymentInstruction({ ...instruction, accountName: '  Ada   Stores ' });
    expect(r.ok && r.value.accountName).toBe('Ada Stores');
  });

  it('puts the approved bank details and the invoice reference in the email and the WhatsApp text', () => {
    const withBank = { ...facts, paymentInstruction: instruction };
    const mail = composeEmailReminder(withBank, 'u');
    const wa = composeWhatsAppReminder(withBank);
    for (const text of [mail.text, wa]) {
      expect(text).toContain('₦1,500.50');
      expect(text).toContain('Ada Stores Ltd');
      expect(text).toContain('GTBank');
      expect(text).toContain('0123456789');
      expect(text).toContain('quote invoice INV-0007');
      expect(text).toContain('+2348031234567');
    }
  });

  it('shows no bank details when none is approved: it falls back to the phone, never invents one', () => {
    for (const f of [facts, { ...facts, paymentInstruction: null }]) {
      const mail = composeEmailReminder(f, 'u');
      expect(mail.text).toContain('To pay or ask about it, contact Ada Stores on +2348031234567.');
      expect(mail.text).not.toMatch(/account number/i);
      expect(composeWhatsAppReminder(f)).toContain('call +2348031234567');
      expect(composeWhatsAppReminder(f)).not.toMatch(/account number/i);
    }
  });

  it('leaves the approved WhatsApp template parameters unchanged', () => {
    expect(reminderTemplateParameters({ ...facts, paymentInstruction: instruction })).toEqual(
      reminderTemplateParameters(facts),
    );
  });
});
