import { describe, expect, it } from 'vitest';
import {
  accountNumberDigits,
  batchItemStatus,
  batchRefusal,
  batchStateLabel,
  confirmProblem,
  newBatchView,
  remindersOffNotice,
  previewReason,
  reminderAccessRefusal,
  channelsFromChoice,
  channelsLabel,
  channelsPhrase,
  choiceMayEmail,
  lagosDateTime,
  lagosLocalInput,
  lagosLocalToIso,
  paymentInstructionIssue,
  reminderReason,
  reminderStatusDetail,
  reminderStatusLabel,
  scheduleProblem,
} from './reminder-copy';

/** Every reason code the API can store or return today (core `reminderBlock`, the service, the worker). */
const CODES = [
  'reminders_not_released',
  'invoice_not_found',
  'nothing_owing',
  'reminders_stopped',
  'no_customer',
  'no_contact',
  'no_public_contact',
  'attestation_required',
  'customer_opted_out',
  'address_suppressed',
  'not_entitled',
  'window_closed_no_template',
  'template_not_configured',
  'template_not_approved',
  'no_whatsapp_connection',
  'allowance_exhausted',
  'invalid_recipient',
  'ambiguous_contact',
  'email_not_configured',
  'send_failed',
  'reminder_in_flight',
  'delivery_unconfirmed',
  'unexpected',
  'batch_cancelled',
  'scheduler_not_authorised',
  'dispatch_error',
];

describe('reminder reasons in plain words', () => {
  it('gives every known code its own sentence, never the fallback and never the code', () => {
    const fallback = reminderReason('a_code_nobody_knows');
    for (const code of CODES) {
      const text = reminderReason(code);
      expect(text, code).not.toBe(fallback);
      expect(text, code).not.toMatch(/_/);
      expect(text, code).toMatch(/\.$/);
    }
  });

  it('never shows a raw code, even for one it does not know', () => {
    expect(reminderReason('totally_new_reason')).toBe('This reminder was not sent.');
    expect(reminderReason(null)).toBe('This reminder was not sent.');
  });

  it('explains the WhatsApp 24 hour window', () => {
    expect(reminderReason('window_closed_no_template')).toMatch(/last 24 hours/);
  });

  it('says reminders are not switched on rather than naming a release flag', () => {
    expect(reminderReason('reminders_not_released')).toMatch(/not switched on for your business/);
  });

  it('promises no automatic resend when delivery could not be confirmed', () => {
    const text = reminderReason('delivery_unconfirmed');
    expect(text).toMatch(/could not confirm delivery/);
    expect(text).toMatch(/will not send it again automatically/);
  });

  it('keeps an opt-out on the channel it belongs to', () => {
    expect(reminderReason('customer_opted_out', 'email')).toMatch(/by email/);
    expect(reminderReason('customer_opted_out', 'whatsapp')).toMatch(/on WhatsApp/);
  });

  it('names the missing contact by channel', () => {
    expect(reminderReason('no_contact', 'email')).toMatch(/email address/);
    expect(reminderReason('no_contact', 'whatsapp')).toMatch(/WhatsApp number/);
  });

  it('asks for the lawful-basis confirmation by name', () => {
    expect(reminderReason('attestation_required')).toMatch(/lawful reason to contact them/);
  });

  it('never claims a payment failed, and no reason uses internal words', () => {
    for (const code of CODES) {
      const text = reminderReason(code);
      expect(text, code).not.toMatch(/payment (failed|was declined)/i);
      expect(text, code).not.toMatch(/entitlement|idempotency|reason.?code|deleted/i);
      for (const dash of [0x2013, 0x2014]) {
        expect(text, code).not.toContain(String.fromCharCode(dash));
      }
    }
  });
});

describe('reminder statuses', () => {
  it('labels each status without treating a blocked reminder as a failure', () => {
    expect(reminderStatusLabel('sent')).toEqual({ label: 'Sent', tone: 'ok' });
    expect(reminderStatusLabel('blocked')).toEqual({ label: 'Not sent', tone: 'neutral' });
    expect(reminderStatusLabel('failed')).toEqual({ label: 'Not sent', tone: 'neutral' });
    expect(reminderStatusLabel('uncertain').label).toBe('Could not be confirmed');
  });

  it('explains everything except a sent reminder', () => {
    expect(reminderStatusDetail('sent', null)).toBeNull();
    expect(reminderStatusDetail('blocked', 'nothing_owing')).toMatch(/Nothing is owed/);
    expect(reminderStatusDetail('uncertain', 'unexpected')).toMatch(/could not confirm/);
  });
});

describe('batch recipients', () => {
  const base = { invoiceNumber: 'INV-0001', reasonCode: null, reminders: [] };

  it('reads the batch state before any send', () => {
    expect(batchItemStatus({ ...base, state: 'pending' }).label).toBe('Waiting to send');
    expect(batchItemStatus({ ...base, state: 'dispatching' }).label).toBe('Sending');
    expect(
      batchItemStatus({ ...base, state: 'cancelled', reasonCode: 'batch_cancelled' }).label,
    ).toBe('Cancelled');
  });

  it('trusts the reminder rows once a send was attempted', () => {
    const sent = batchItemStatus({
      ...base,
      state: 'done',
      reminders: [
        { channel: 'whatsapp', status: 'blocked', reasonCode: 'no_contact', sentAt: null },
        { channel: 'email', status: 'sent', reasonCode: null, sentAt: '2026-11-03T09:00:00Z' },
      ],
    });
    expect(sent).toEqual({ label: 'Sent', tone: 'ok', detail: null });

    const unsure = batchItemStatus({
      ...base,
      state: 'done',
      reminders: [
        { channel: 'email', status: 'uncertain', reasonCode: 'delivery_unconfirmed', sentAt: null },
      ],
    });
    expect(unsure.label).toBe('Could not be confirmed');

    const blocked = batchItemStatus({
      ...base,
      state: 'done',
      reminders: [
        { channel: 'email', status: 'blocked', reasonCode: 'customer_opted_out', sentAt: null },
      ],
    });
    expect(blocked.label).toBe('Not sent');
    expect(blocked.detail).toMatch(/by email/);
  });

  it('uses the item reason when nothing was attempted', () => {
    const skipped = batchItemStatus({ ...base, state: 'skipped', reasonCode: 'dispatch_error' });
    expect(skipped.label).toBe('Not sent');
    expect(skipped.detail).toMatch(/stopped trying/);
  });
});

describe('batch state and channels', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  it('shows a due scheduled batch as sending', () => {
    expect(batchStateLabel('scheduled', '2026-11-04T12:00:00Z', now)).toBe('Scheduled');
    expect(batchStateLabel('scheduled', '2026-11-03T11:00:00Z', now)).toBe('Due to send');
    expect(batchStateLabel('completed', '2026-11-03T11:00:00Z', now)).toBe('Finished');
    expect(batchStateLabel('cancelled', '2026-11-04T12:00:00Z', now)).toBe('Cancelled');
  });

  it('maps the channel choice both ways', () => {
    expect(channelsFromChoice('auto')).toBe('auto');
    expect(channelsFromChoice('both')).toEqual(['whatsapp', 'email']);
    expect(channelsFromChoice('sms')).toBeNull();
    expect(channelsLabel(['email'])).toBe('Email only');
    expect(channelsLabel(['email', 'whatsapp'])).toBe('WhatsApp and email');
    expect(channelsPhrase('auto')).toMatch(/^on WhatsApp/);
    expect(channelsPhrase(['email'])).toBe('by email only');
    expect(choiceMayEmail('whatsapp')).toBe(false);
    expect(choiceMayEmail('auto')).toBe(true);
  });
});

describe('scheduling in Lagos time', () => {
  it('reads a datetime-local value as UTC+1', () => {
    expect(lagosLocalToIso('2026-11-04T09:30')).toBe('2026-11-04T08:30:00Z');
    expect(lagosLocalToIso('2026-01-01T00:15')).toBe('2025-12-31T23:15:00Z');
  });

  it('writes a moment back as a Lagos datetime-local value, and round-trips', () => {
    expect(lagosLocalInput(new Date('2026-11-04T08:30:00Z'))).toBe('2026-11-04T09:30');
    expect(lagosLocalToIso(lagosLocalInput(new Date('2026-11-04T08:30:00Z')))).toBe(
      '2026-11-04T08:30:00Z',
    );
  });

  it('refuses malformed or impossible values', () => {
    expect(lagosLocalToIso('')).toBeNull();
    expect(lagosLocalToIso('tomorrow')).toBeNull();
    expect(lagosLocalToIso('2026-11-31T09:00')).toBeNull();
  });

  it('says what is wrong with a time', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    expect(scheduleProblem(null, now)).toMatch(/Pick a date/);
    expect(scheduleProblem('2026-11-03T11:00:00Z', now)).toMatch(/later than now/);
    expect(scheduleProblem('2026-12-10T12:00:00Z', now)).toMatch(/30 days/);
    expect(scheduleProblem('2026-11-04T12:00:00Z', now)).toBeNull();
  });

  it('writes a time back in Lagos', () => {
    expect(lagosDateTime('2026-11-04T08:30:00Z')).toMatch(/4 Nov 2026/);
    expect(lagosDateTime('2026-11-04T08:30:00Z')).toMatch(/09:30/);
  });
});

describe('refusals and bank details', () => {
  it('turns batch refusals into sentences', () => {
    expect(batchRefusal('reminders_not_released')).toMatch(/not switched on/);
    expect(batchRefusal('reminders_not_released')).not.toMatch(/nothing was sent/);
    expect(batchRefusal('scheduled_for_out_of_range')).toMatch(/30 days/);
    expect(batchRefusal('whatever')).toMatch(/Nothing was scheduled/);
  });

  it('accepts the ways people type an account number and nothing else', () => {
    expect(accountNumberDigits('0123456789')).toBe('0123456789');
    expect(accountNumberDigits('0123 456 789')).toBe('0123456789');
    expect(accountNumberDigits('012-345-6789')).toBe('0123456789');
    expect(accountNumberDigits('12345')).toBeNull();
    expect(accountNumberDigits('01234567890')).toBeNull();
    expect(accountNumberDigits('01234x6789')).toBeNull();
  });

  it('names each bank detail problem', () => {
    expect(paymentInstructionIssue('account_number')).toMatch(/10 digits/);
    expect(paymentInstructionIssue('bank_name')).toMatch(/bank name/);
    expect(paymentInstructionIssue('account_name')).toMatch(/account name/);
  });
});

describe('review fixes (REM-06)', () => {
  it('a problem found at Confirm is said plainly, with nothing scheduled', () => {
    const msg = confirmProblem({
      fields: { when: 'That time has already passed. Pick a later time.' },
    });
    expect(msg).toContain('That time has already passed');
    expect(msg).toContain('did not schedule a new batch');
    expect(
      confirmProblem({ fields: { invoices: 'Pick at least one invoice to remind.' } }),
    ).toContain('did not schedule a new batch');
    expect(confirmProblem({ error: 'Pick how to send the reminders.' })).toContain(
      'Pick how to send the reminders.',
    );
    expect(confirmProblem({})).toContain('did not schedule a new batch');
  });

  it('a preview speaks about what will happen, never as if something was already attempted', () => {
    for (const code of [
      'reminders_not_released',
      'email_not_configured',
      'window_closed_no_template',
      'no_whatsapp_connection',
      'customer_opted_out',
    ]) {
      const text = previewReason(
        code,
        code.includes('whatsapp') || code.includes('window') ? 'whatsapp' : 'email',
      );
      expect(text).not.toMatch(/was sent|was delivered/);
    }
    expect(previewReason('reminders_not_released')).toContain('will not be sent');
  });

  it('a send failure does not blame a provider that may never have been asked', () => {
    const text = reminderReason('send_failed');
    expect(text).not.toMatch(/service did not accept/);
    expect(text).toContain('nothing was delivered');
  });

  it('a refused action is explained without assuming the member is view only', () => {
    const text = reminderAccessRefusal();
    expect(text).not.toMatch(/view only/);
    expect(text).toMatch(/owner/);
  });
});

describe('review fixes, round 2 (REM-06)', () => {
  it('a Confirm-time problem never rules out an earlier confirmation that did go through', () => {
    const msg = confirmProblem({
      fields: { when: 'That time has already passed. Pick a later time.' },
    });
    expect(msg).not.toMatch(/Nothing was scheduled/);
    expect(msg).toMatch(/did not schedule a new batch/);
    expect(msg).toMatch(/Reload the page/);
  });

  it('the preview never uses the past-tense fallback', () => {
    expect(previewReason('a_code_nobody_knows')).not.toMatch(/was not sent/);
    expect(previewReason(null)).toMatch(/will not be sent/);
  });

  it('the new-batch area shows the switched-off notice whenever reminders are not released, even with invoices to remind', () => {
    expect(newBatchView(false, 5)).toBe('not_released');
    expect(newBatchView(false, 0)).toBe('not_released');
    expect(newBatchView(true, 0)).toBe('nothing_owed');
    expect(newBatchView(true, 3)).toBe('form');
  });

  it('the switched-off notice says scheduled batches are kept and can be cancelled', () => {
    const text = remindersOffNotice();
    expect(text).toMatch(/not switched on/);
    expect(text).toMatch(/already scheduled/);
    expect(text).toMatch(/cancel/);
    /* Never a promise that every held reminder goes: the send checks still apply. */
    expect(text).not.toMatch(/will go once/);
    expect(text).toMatch(/usual checks/);
  });
});

describe('review fixes, round 3 (REM-06)', () => {
  it('the allowance message neither assumes a monthly reset nor offers more messages', () => {
    const text = reminderReason('allowance_exhausted');
    expect(text).not.toMatch(/this month|Add more/);
    expect(text).toMatch(/billing page/);
  });
});
