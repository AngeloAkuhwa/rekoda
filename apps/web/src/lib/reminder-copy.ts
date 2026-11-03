/**
 * What the reminder screens say (REM-06), in one place so every screen says it
 * the same way and a unit test can hold each sentence.
 *
 * The API names every reason a reminder did not go with a code (packages/core
 * `reminderBlock`, `ReminderService` and the batch worker). A merchant never
 * reads a code: each one maps to a plain sentence with the next step where
 * there is one, and an unknown code falls back to a sentence that claims
 * nothing it does not know. Nothing here computes money; balances arrive in
 * kobo from the API and are rendered by `Money`.
 */

export type ReminderChannel = 'email' | 'whatsapp';
export type ReminderStatus = 'sending' | 'sent' | 'blocked' | 'failed' | 'uncertain';
export type ChannelChoice = 'auto' | 'whatsapp' | 'email' | 'both';

/** How a status reads at a glance. Neutral tones only: a reminder not sent is not a failure. */
export type Tone = 'ok' | 'neutral' | 'attention';

export function channelName(channel: ReminderChannel): string {
  return channel === 'email' ? 'Email' : 'WhatsApp';
}

const onChannel = (channel?: ReminderChannel) =>
  channel === 'email' ? ' by email' : channel === 'whatsapp' ? ' on WhatsApp' : '';

/**
 * Why a reminder was not sent, or will not be, as a sentence a merchant can act on. `channel`
 * sharpens the wording where the reason belongs to one channel.
 */
export function reminderReason(code: string | null, channel?: ReminderChannel): string {
  switch (code) {
    case 'reminders_not_released':
      return 'Reminders are not switched on for your business yet, so nothing was sent.';
    case 'invoice_not_found':
      return 'There is no invoice with this number in your books.';
    case 'nothing_owing':
      return 'Nothing is owed on this invoice any more, so there is nothing to remind about.';
    case 'reminders_stopped':
      return 'You stopped reminders for this invoice. Resume them on its reminders page to send one.';
    case 'no_customer':
      return 'This invoice is not linked to a customer, so there is nobody to remind.';
    case 'no_contact':
      return channel === 'email'
        ? 'You do not have an email address for this customer.'
        : channel === 'whatsapp'
          ? 'You do not have a WhatsApp number for this customer.'
          : 'You do not have a way to reach this customer.';
    case 'no_public_contact':
      return 'Add the business phone customers can call, in Settings. Every reminder shows it.';
    case 'attestation_required':
      return 'Before Rekoda emails a customer for you, tick the box to confirm you have a lawful reason to contact them about this debt.';
    case 'customer_opted_out':
      return `This customer asked not to get reminders${onChannel(channel)}, so none will be sent there.`;
    case 'address_suppressed':
      return 'This email address cannot take mail from Rekoda (it bounced before, or the customer marked it as unwanted).';
    case 'not_entitled':
      return 'Your plan does not include this message. See the billing page for what does.';
    case 'window_closed_no_template':
      return 'WhatsApp only lets a business message a customer who wrote to it in the last 24 hours. This customer has not, so nothing was sent on WhatsApp.';
    case 'template_not_configured':
    case 'template_not_approved':
      return 'The WhatsApp reminder message is not approved yet, so nothing was sent on WhatsApp.';
    case 'no_whatsapp_connection':
      return 'Your business WhatsApp is not connected yet, so nothing was sent on WhatsApp.';
    case 'allowance_exhausted':
      return 'You have used the messages your plan includes for now, so nothing was sent. Your billing page shows what your plan allows.';
    case 'invalid_recipient':
      return 'The number or address on file for this customer does not look right, so nothing was sent.';
    case 'ambiguous_contact':
      return 'This customer has more than one contact of this kind on file, so Rekoda did not guess which to use.';
    case 'email_not_configured':
      return 'Email reminders are not set up yet, so nothing was sent by email.';
    case 'send_failed':
      return 'It could not be sent, so nothing was delivered. You can try again.';
    case 'reminder_in_flight':
      return 'Another reminder for this invoice is still being sent. Look again in a minute.';
    case 'delivery_unconfirmed':
    case 'unexpected':
      return 'We could not confirm delivery, so we will not send it again automatically.';
    case 'batch_cancelled':
      return 'Cancelled before it was sent.';
    case 'scheduler_not_authorised':
      return 'The person who scheduled this can no longer send reminders, so it was not sent.';
    case 'dispatch_error':
      return 'Rekoda tried several times and could not send this one, so it stopped trying.';
    default:
      return 'This reminder was not sent.';
  }
}

/** One channel's reminder, as a short label and a tone. */
export function reminderStatusLabel(status: ReminderStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'sent':
      return { label: 'Sent', tone: 'ok' };
    case 'sending':
      return { label: 'Sending', tone: 'neutral' };
    case 'uncertain':
      return { label: 'Could not be confirmed', tone: 'attention' };
    case 'blocked':
    case 'failed':
      return { label: 'Not sent', tone: 'neutral' };
  }
}

/** The sentence under a status, or null when the label says everything. */
export function reminderStatusDetail(
  status: ReminderStatus,
  reasonCode: string | null,
  channel?: ReminderChannel,
): string | null {
  if (status === 'sent') return null;
  if (status === 'sending') return 'Rekoda is sending this now.';
  if (status === 'uncertain') return reminderReason('delivery_unconfirmed');
  return reminderReason(reasonCode, channel);
}

export interface BatchItemView {
  invoiceNumber: string;
  state: 'pending' | 'dispatching' | 'done' | 'cancelled' | 'skipped';
  reasonCode: string | null;
  reminders: Array<{
    channel: ReminderChannel;
    status: ReminderStatus;
    reasonCode: string | null;
    sentAt: string | null;
  }>;
}

/**
 * One recipient of a batch, read as the merchant needs it. Once a send has been attempted the
 * reminder rows are the truth (the contract says so); before that, the batch's own state is.
 */
export function batchItemStatus(item: BatchItemView): {
  label: string;
  tone: Tone;
  detail: string | null;
} {
  if (item.state === 'pending') {
    return { label: 'Waiting to send', tone: 'neutral', detail: null };
  }
  if (item.state === 'dispatching') {
    return { label: 'Sending', tone: 'neutral', detail: 'Rekoda is sending this now.' };
  }
  if (item.state === 'cancelled') {
    return { label: 'Cancelled', tone: 'neutral', detail: 'Cancelled before it was sent.' };
  }
  const rows = item.reminders;
  if (rows.some((r) => r.status === 'sent')) {
    return { label: 'Sent', tone: 'ok', detail: null };
  }
  if (rows.some((r) => r.status === 'uncertain')) {
    return {
      label: 'Could not be confirmed',
      tone: 'attention',
      detail: reminderReason('delivery_unconfirmed'),
    };
  }
  if (rows.some((r) => r.status === 'sending')) {
    return { label: 'Sending', tone: 'neutral', detail: 'Rekoda is sending this now.' };
  }
  const first = rows[0];
  return {
    label: 'Not sent',
    tone: 'neutral',
    detail: first
      ? reminderReason(first.reasonCode, first.channel)
      : reminderReason(item.reasonCode),
  };
}

/**
 * A batch's overall state. A scheduled batch whose time has come is due: it may be sending, or
 * waiting (paused after provider failures, or reminders switched off), so it never claims "sending".
 */
export function batchStateLabel(
  state: 'scheduled' | 'completed' | 'cancelled',
  scheduledFor: string,
  now: Date,
): string {
  if (state === 'cancelled') return 'Cancelled';
  if (state === 'completed') return 'Finished';
  return new Date(scheduledFor).getTime() > now.getTime() ? 'Scheduled' : 'Due to send';
}

/**
 * What a scheduled batch past its time says. A passed time does not show a send has started
 * (reminders may be switched off, or the sender delayed), so it claims only what the record does.
 */
export const BATCH_DUE_NOTE =
  'The send time has passed and the batch is not finished. It goes out when Rekoda next sends, and each invoice is checked again first. If reminders are switched off, it waits.';

/** The channels a batch or a request uses, in words. */
export function channelsLabel(channels: 'auto' | ReminderChannel[]): string {
  if (channels === 'auto') return 'WhatsApp, and email where you have an address';
  const set = new Set(channels);
  if (set.has('whatsapp') && set.has('email')) return 'WhatsApp and email';
  return set.has('email') ? 'Email only' : 'WhatsApp only';
}

/** The same, as a phrase inside a sentence ("will be reminded by email only"). */
export function channelsPhrase(channels: 'auto' | ReminderChannel[]): string {
  if (channels === 'auto') return 'on WhatsApp, and by email where you have an address';
  const set = new Set(channels);
  if (set.has('whatsapp') && set.has('email')) return 'on WhatsApp and by email';
  return set.has('email') ? 'by email only' : 'on WhatsApp only';
}

/** The form's channel choice as the API's `channels` value. */
export function channelsFromChoice(choice: string): 'auto' | ReminderChannel[] | null {
  switch (choice) {
    case 'auto':
      return 'auto';
    case 'whatsapp':
      return ['whatsapp'];
    case 'email':
      return ['email'];
    case 'both':
      return ['whatsapp', 'email'];
    default:
      return null;
  }
}

/** True when the choice can send email, so the merchant's attestation applies. */
export function choiceMayEmail(choice: string): boolean {
  return choice === 'auto' || choice === 'email' || choice === 'both';
}

/** The furthest ahead a batch may be scheduled (the API's `maxScheduleAheadMs`, 30 days). */
export const SCHEDULE_AHEAD_DAYS = 30;

/**
 * A `datetime-local` value, read as Lagos time (UTC+1 all year, no daylight saving), as the ISO
 * instant the API takes. Null for anything that is not a well-formed local date and time.
 */
export function lagosLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const instant = new Date(`${y}-${mo}-${d}T${h}:${mi}:00+01:00`);
  if (Number.isNaN(instant.getTime())) return null;
  /* Reject a day the calendar does not have (31 Nov), which Date would roll forward. */
  const back = new Date(instant.getTime() + 3_600_000);
  if (
    back.getUTCFullYear() !== Number(y) ||
    back.getUTCMonth() + 1 !== Number(mo) ||
    back.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return instant.toISOString().replace('.000Z', 'Z');
}

/** A moment as a `datetime-local` value in Lagos time, for the picker's default, min and max. */
export function lagosLocalInput(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 16);
}

/**
 * Checks a chosen send time before it reaches the API, so the merchant hears about it in words.
 * Returns the problem as a sentence, or null when the time is usable.
 */
export function scheduleProblem(iso: string | null, now: Date): string | null {
  if (iso === null) return 'Pick a date and a time to send.';
  const at = new Date(iso).getTime();
  if (at <= now.getTime()) return 'Pick a time later than now, or choose Send now.';
  if (at > now.getTime() + SCHEDULE_AHEAD_DAYS * 24 * 3_600_000) {
    return `Pick a time within the next ${SCHEDULE_AHEAD_DAYS} days.`;
  }
  return null;
}

/** `4 Nov 2026, 09:00`, in Lagos time, the way the registers write a day. */
export function lagosDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Africa/Lagos',
  });
}

/** A refusal from creating a batch, as a sentence. */
export function batchRefusal(code: string): string {
  switch (code) {
    case 'reminders_not_released':
      return reminderReason('reminders_not_released').replace(', so nothing was sent', '');
    case 'scheduled_for_out_of_range':
      return `Pick a time within the next ${SCHEDULE_AHEAD_DAYS} days.`;
    case 'idempotency_key_reused':
      return 'These reminders were already submitted with different choices. Preview them again to start over.';
    default:
      return 'That did not go through. Nothing was scheduled.';
  }
}

/** What the API found wrong with bank details, field by field. */
export function paymentInstructionIssue(issue: string): string {
  switch (issue) {
    case 'bank_name':
      return 'Enter the bank name, 2 to 60 characters.';
    case 'account_name':
      return 'Enter the account name as the bank shows it, 2 to 80 characters.';
    case 'account_number':
      return 'An account number is 10 digits.';
    default:
      return 'Check the bank details and try again.';
  }
}

/**
 * The ten digits a merchant typed, with the spaces and dashes people use removed, or null when
 * what is left is not ten digits. Mirrors the API's rule; the API still decides.
 */
export function accountNumberDigits(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^[0-9]{10}$/.test(digits) ? digits : null;
}

/** The plural the screens need, for counts that come from the API. */
export function invoicesCount(n: number): string {
  return n === 1 ? '1 invoice' : `${n} invoices`;
}

/**
 * A reason in a preview, where nothing has been attempted yet: the same sentence as
 * `reminderReason`, said about what will happen rather than what happened.
 */
export function previewReason(code: string | null, channel?: ReminderChannel): string {
  return reminderReason(code, channel)
    .replace(/so nothing was sent( on WhatsApp| by email)?/, (_m, on: string | undefined) =>
      on ? `so it will not be sent${on}` : 'so it will not be sent',
    )
    .replace('so nothing was delivered', 'so it will not be delivered')
    .replace('This reminder was not sent.', 'This reminder will not be sent.');
}

/**
 * What the merchant reads when Confirm finds a problem the preview did not (for example the chosen
 * time passed while they were reading). Always says nothing was scheduled.
 */
export function confirmProblem(read: {
  error?: string;
  fields?: { invoices?: string; when?: string; attest?: string };
}): string {
  const problem = read.fields?.when ?? read.fields?.invoices ?? read.error;
  /* "This attempt": an earlier confirmation may have gone through with its answer lost, so the
   * screen never claims that no batch exists; the list below shows what was scheduled. */
  const tail =
    'This attempt did not schedule a new batch. Reload the page and check the list for any you already confirmed.';
  return problem ? `${problem} ${tail}` : `That did not go through. ${tail}`;
}

/** A reminder action the API refused for this member's role. */
export function reminderAccessRefusal(): string {
  return 'Your access to this business does not include this action. Ask the business owner if it should.';
}

/** Which new-batch area to show: the switched-off notice always wins, then nothing owed, then the form. */
export function newBatchView(
  released: boolean,
  remindable: number,
): 'not_released' | 'nothing_owed' | 'form' {
  if (!released) return 'not_released';
  return remindable === 0 ? 'nothing_owed' : 'form';
}

/** What the merchant reads while customer reminders are switched off. */
export function remindersOffNotice(): string {
  return (
    'Reminders are not switched on for your business yet, so nothing can be sent or scheduled now. ' +
    'Reminders you already scheduled are kept. Once reminders are switched on, each one is sent when ' +
    'due if it still passes the usual checks (nothing goes for a paid invoice, or on a channel the ' +
    'customer opted out of). ' +
    'You can cancel any of them below. Your invoices and records are unaffected.'
  );
}
