import { describe, expect, it, vi } from 'vitest';
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
  it('shows a due scheduled batch as due to send, never as sending', () => {
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
    expect(previewReason('reminders_not_released')).toContain('cannot be sent now');
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
    expect(previewReason(null)).toMatch(/cannot be sent now/);
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
    /* Opt-outs are per channel (OWN-69): the notice must not imply one stops the other. */
    expect(text).toMatch(/on a channel the customer opted out of/);
    expect(text).not.toMatch(/customer who opted out is skipped/);
  });
});

describe('review fixes, round 3 (REM-06)', () => {
  it('the allowance message neither assumes a monthly reset nor offers more messages', () => {
    const text = reminderReason('allowance_exhausted');
    expect(text).not.toMatch(/this month|Add more/);
    expect(text).toMatch(/billing page/);
  });
});

describe('review fixes, round 4 (REM-06)', () => {
  it('writes Lagos midnight as 00, never 24', () => {
    const text = lagosDateTime('2026-11-03T23:15:00Z');
    expect(text).toMatch(/00:15/);
    expect(text).not.toMatch(/24:15/);
  });

  it('fixes the hour cycle itself, not only on engines that already render 00', () => {
    /* Some engines map `hour12: false` to h24 and print 24:15; this one does not, so the string
     * alone cannot catch a return to `hour12`. The options passed are what decide it. */
    const spy = vi.spyOn(Date.prototype, 'toLocaleString');
    try {
      lagosDateTime('2026-11-03T23:15:00Z');
      const options = spy.mock.calls[0]?.[1];
      expect(options).toMatchObject({ hourCycle: 'h23', timeZone: 'Africa/Lagos' });
      expect(options).not.toHaveProperty('hour12');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('review fixes, round 4 copy (REM-06)', () => {
  it('a batch past its time does not claim it is sending', async () => {
    const { BATCH_DUE_NOTE } = await import('./reminder-copy');
    expect(BATCH_DUE_NOTE).not.toMatch(/Sending now/);
    expect(BATCH_DUE_NOTE).toMatch(/switched off/);
  });
});

describe('review fixes, round 5 (REM-06)', () => {
  it('the confirm step sends back the previewed time, not whatever the picker holds now', async () => {
    const { planAtInput, lagosLocalToIso: parse } = await import('./reminder-copy');
    /* 09:30 Lagos on 10 Nov 2026, the time a preview was made for. */
    const previewed = '2026-11-10T08:30:00Z';
    expect(planAtInput(previewed)).toBe('2026-11-10T09:30');
    /* What Confirm posts is parsed back by readPlan to exactly the previewed instant. */
    expect(parse(planAtInput(previewed))).toBe(previewed);
    expect(planAtInput(undefined)).toBe('');
  });
});

describe('review fixes, round 6 (REM-06)', () => {
  it('stopping says reminders on more than one channel may already be on their way', async () => {
    const { REMINDERS_IN_FLIGHT_NOTE } = await import('./reminder-copy');
    expect(REMINDERS_IN_FLIGHT_NOTE).not.toMatch(/^One /);
    expect(REMINDERS_IN_FLIGHT_NOTE).toMatch(/WhatsApp/);
    expect(REMINDERS_IN_FLIGHT_NOTE).toMatch(/email/);
  });
});

describe('review fixes, round 7 (REM-06): what stopping and leaving out really do', () => {
  it('stopping says a scheduled reminder that comes due is skipped, never held for later', async () => {
    const { STOP_EXPLAINER, STOPPED_NOTE } = await import('./reminder-copy');
    for (const text of [STOP_EXPLAINER, STOPPED_NOTE]) {
      expect(text).not.toMatch(/holds?\b/i);
      expect(text).toMatch(/skipped, not sent later/);
    }
  });

  it('a left-out invoice is described as checked again at send time, not as never sent', async () => {
    const { LEFT_OUT_RECHECK_NOTE } = await import('./reminder-copy');
    expect(previewReason('reminders_not_released')).not.toMatch(/will not be sent/);
    expect(previewReason('window_closed_no_template', 'whatsapp')).not.toMatch(/will not be sent/);
    expect(previewReason('reminders_not_released')).toMatch(/cannot be sent now/);
    expect(LEFT_OUT_RECHECK_NOTE).toMatch(/checks .* again/i);
    expect(LEFT_OUT_RECHECK_NOTE).toMatch(/reminded/);
  });

  it('a cancellation does not promise to stop a reminder already being sent', async () => {
    const { cancelledNote, REMINDERS_IN_FLIGHT_NOTE } = await import('./reminder-copy');
    expect(cancelledNote(2)).toContain(REMINDERS_IN_FLIGHT_NOTE);
    expect(cancelledNote(2)).toMatch(/2 invoices/);
  });
});

describe('review fixes, round 8 (REM-06): no promise the data cannot keep', () => {
  it('an unconfirmed reminder action asks the merchant to look before trying again', async () => {
    const { REMINDER_OUTCOME_UNKNOWN } = await import('./reminder-copy');
    expect(REMINDER_OUTCOME_UNKNOWN).toMatch(/could not confirm/i);
    expect(REMINDER_OUTCOME_UNKNOWN).not.toMatch(/never|twice|cannot run/i);
    expect(REMINDER_OUTCOME_UNKNOWN).toMatch(/check/i);
  });

  it('an unconfirmed settings change asks the owner to check the settings, with no replay promise', async () => {
    const { SETTINGS_OUTCOME_UNKNOWN } = await import('./reminder-copy');
    expect(SETTINGS_OUTCOME_UNKNOWN).toMatch(/could not confirm/i);
    expect(SETTINGS_OUTCOME_UNKNOWN).toMatch(/settings/i);
    expect(SETTINGS_OUTCOME_UNKNOWN).not.toMatch(/never|twice|safe/i);
  });

  it('stopping is described by the check made at each send, not by when a reminder was due', async () => {
    const { STOP_EXPLAINER, STOPPED_NOTE } = await import('./reminder-copy');
    for (const text of [STOP_EXPLAINER, STOPPED_NOTE]) {
      expect(text).toMatch(/just before (each|it) sends?/i);
      expect(text).not.toMatch(/comes due/);
    }
  });

  it('removing bank details warns that a reminder already being sent may still show them', async () => {
    const { PAYMENT_INSTRUCTION_REMOVED } = await import('./reminder-copy');
    expect(PAYMENT_INSTRUCTION_REMOVED).toMatch(/already being sent/);
    expect(PAYMENT_INSTRUCTION_REMOVED).toMatch(/business phone/);
  });
});

describe('review fixes, round 9 (REM-06)', () => {
  it('an unconfirmed reminder action sends the merchant to a reload, never to a stale screen', async () => {
    const { REMINDER_OUTCOME_UNKNOWN } = await import('./reminder-copy');
    expect(REMINDER_OUTCOME_UNKNOWN).toMatch(/reload the page/i);
    expect(REMINDER_OUTCOME_UNKNOWN).not.toMatch(/shown below/i);
  });

  it('a confirm holds its key under the selection the preview was made for', async () => {
    const { planIntentScope } = await import('./reminder-copy');
    const { batchIntentScope } = await import('./intent-key');
    expect(
      planIntentScope({
        invoiceNumbers: ['INV-2', 'INV-1'],
        choice: 'email',
        scheduledFor: '2026-11-10T08:30:00Z',
      }),
    ).toBe(batchIntentScope(['INV-1', 'INV-2'], 'email', '2026-11-10T09:30'));
    expect(planIntentScope({ invoiceNumbers: ['INV-1'], choice: 'auto' })).toBe(
      batchIntentScope(['INV-1'], 'auto', ''),
    );
  });
});
