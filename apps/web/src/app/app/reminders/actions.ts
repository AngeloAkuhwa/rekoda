'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  REMINDER_BATCH_MAX,
  reminderBatchPreviewResponse,
  type ReminderBatchPreviewResponse,
} from '@rekoda/contracts';
import {
  cancelReminderBatch,
  clearPaymentInstruction,
  createReminderBatch,
  previewReminderBatch,
  savePaymentInstruction,
  savePublicContact,
  sendReminder,
  setRemindersStopped,
  viewOnlyRefusal,
  ApiForbidden,
  ApiUnavailable,
  ApiUnexpectedStatus,
} from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';
import {
  accountNumberDigits,
  batchRefusal,
  channelName,
  channelsFromChoice,
  choiceMayEmail,
  invoicesCount,
  lagosLocalToIso,
  paymentInstructionIssue,
  reminderStatusDetail,
  reminderStatusLabel,
  scheduleProblem,
  type ChannelChoice,
  confirmProblem,
  reminderAccessRefusal,
  REMINDER_OUTCOME_UNKNOWN,
  SETTINGS_OUTCOME_UNKNOWN,
  PAYMENT_INSTRUCTION_REMOVED,
  REMINDERS_IN_FLIGHT_NOTE,
  STOPPED_NOTE,
  cancelledNote,
  REMINDER_READ_UNREACHABLE,
} from '@/lib/reminder-copy';

const EXPIRED = 'Your session expired. Sign in again.';
const KEY = /^[0-9a-f-]{36}$/i;

/**
 * Wraps an action so a role the API refuses, or an answer that never arrived, reads as a sentence,
 * never a crashed page.
 *
 * A lost answer must not throw: the dashboard's error boundary would remount the form, a new
 * idempotency key would be drawn, and a send the API had already committed could go to the
 * customer a second time. Answered here, the form stays mounted with its key, so the retry replays.
 * `lost` is what to say then: a write may have happened; a read wrote nothing.
 */
function guarded<S, A extends unknown[]>(
  fn: (...args: A) => Promise<S>,
  lost: string = REMINDER_OUTCOME_UNKNOWN,
): (...args: A) => Promise<S> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ApiForbidden) return { error: reminderAccessRefusal() } as S;
      /* A response the contract cannot read (ZodError) arrived after the API acted, too. */
      if (
        error instanceof ApiUnavailable ||
        error instanceof ApiUnexpectedStatus ||
        (error instanceof Error && error.name === 'ZodError')
      ) {
        return { error: lost } as S;
      }
      return viewOnlyRefusal(error) as S;
    }
  };
}

/* ── scheduled and bulk ─────────────────────────────────────────────── */

export interface BatchPlan {
  invoiceNumbers: string[];
  choice: ChannelChoice;
  /** Absent: as soon as possible. */
  scheduledFor?: string;
  /** One per previewed intention: a second press of Confirm creates nothing twice. */
  idempotencyKey: string;
}

export interface BatchFormState {
  error?: string;
  /** Field-level problems, keyed by the field's name. */
  fields?: { invoices?: string; when?: string; attest?: string };
  plan?: BatchPlan;
  preview?: ReminderBatchPreviewResponse;
}

function readPlan(formData: FormData, now: Date): BatchFormState | { plan: BatchPlan } {
  const invoiceNumbers = [
    ...new Set(
      formData
        .getAll('invoice')
        .map((v) => String(v).trim())
        .filter(Boolean),
    ),
  ];
  const choice = String(formData.get('channels') ?? 'auto') as ChannelChoice;
  const when = String(formData.get('when') ?? 'now');
  const fields: NonNullable<BatchFormState['fields']> = {};
  if (invoiceNumbers.length === 0) fields.invoices = 'Pick at least one invoice to remind.';
  if (invoiceNumbers.length > REMINDER_BATCH_MAX) {
    fields.invoices = `Pick at most ${REMINDER_BATCH_MAX} invoices at a time.`;
  }
  let scheduledFor: string | undefined;
  if (when === 'later') {
    const iso = lagosLocalToIso(String(formData.get('at') ?? ''));
    const problem = scheduleProblem(iso, now);
    if (problem) fields.when = problem;
    else scheduledFor = iso!;
  }
  if (channelsFromChoice(choice) === null) return { error: 'Pick how to send the reminders.' };
  if (fields.invoices || fields.when) return { fields };
  const key = String(formData.get('idempotencyKey') ?? '');
  return {
    plan: {
      invoiceNumbers,
      choice,
      ...(scheduledFor ? { scheduledFor } : {}),
      idempotencyKey: KEY.test(key) ? key : randomUUID(),
    },
  };
}

/**
 * Who would be reminded, on which channel, and who is left out and why. Reads only; nothing is
 * written or sent. Email is judged as if the merchant will confirm their lawful basis, because
 * Confirm asks for exactly that and refuses without it.
 */
const previewBatchActionGuarded = guarded(
  async (_prev: BatchFormState, formData: FormData): Promise<BatchFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const read = readPlan(formData, new Date());
    if (!('plan' in read) || !read.plan) return read;
    const { plan } = read;
    const preview = await previewReminderBatch(token, {
      invoiceNumbers: plan.invoiceNumbers,
      channels: channelsFromChoice(plan.choice)!,
      attest: choiceMayEmail(plan.choice),
    });
    if (!preview) return { error: 'That did not go through. Nothing was scheduled.' };
    return { plan, preview };
  },
  REMINDER_READ_UNREACHABLE,
);

/** The merchant's explicit go-ahead. Schedules the batch and opens it; sends nothing here. */
const createBatchActionGuarded = guarded(
  async (_prev: BatchFormState, formData: FormData): Promise<BatchFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const read = readPlan(formData, new Date());
    /* Shown in the confirm step, which renders `error` only: a field problem found now (the time
     * passed while the merchant read the preview) must not vanish, or they would think it went. */
    if (!('plan' in read) || !read.plan) return { error: confirmProblem(read as BatchFormState) };
    const { plan } = read;
    const attest = formData.get('attest') === 'yes';
    if (choiceMayEmail(plan.choice) && !attest) {
      return {
        plan,
        ...(previewFrom(formData) ?? {}),
        fields: {
          attest:
            'Tick the box to confirm you may contact these customers by email, or choose WhatsApp only.',
        },
      };
    }
    const outcome = await createReminderBatch(token, {
      invoiceNumbers: plan.invoiceNumbers,
      channels: channelsFromChoice(plan.choice)!,
      ...(plan.scheduledFor ? { scheduledFor: plan.scheduledFor } : {}),
      idempotencyKey: plan.idempotencyKey,
      ...(choiceMayEmail(plan.choice) ? { attest: true } : {}),
      confirm: true,
    });
    if (outcome.state === 'unknown_invoices') {
      return {
        error: `${outcome.invoiceNumbers.join(', ') || 'Some invoices'} could not be found in your books. Nothing was scheduled.`,
      };
    }
    if (outcome.state === 'refused') return { error: batchRefusal(outcome.code) };
    revalidatePath('/app/reminders');
    redirect(`/app/reminders/${outcome.batch.id}`);
  },
);

/** The preview the Confirm form was rendered from, carried back so a refusal keeps it on screen. */
function previewFrom(formData: FormData): { preview: ReminderBatchPreviewResponse } | null {
  try {
    const raw = String(formData.get('previewJson') ?? '');
    if (!raw) return null;
    const parsed = reminderBatchPreviewResponse.safeParse(JSON.parse(raw));
    return parsed.success ? { preview: parsed.data } : null;
  } catch {
    return null;
  }
}

export interface CancelFormState {
  error?: string;
  done?: string;
}

/** Stops every recipient not yet sent. One already sent stays sent; that is said, not hidden. */
const cancelBatchActionGuarded = guarded(
  async (_prev: CancelFormState, formData: FormData): Promise<CancelFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const batchId = String(formData.get('batchId') ?? '');
    const outcome = await cancelReminderBatch(token, batchId);
    if (!outcome) return { error: 'This batch could not be found. Nothing was changed.' };
    revalidatePath('/app/reminders');
    revalidatePath(`/app/reminders/${batchId}`);
    if (outcome.outcome === 'not_cancellable') {
      return {
        error:
          outcome.batch.state === 'cancelled'
            ? 'This batch was already cancelled.'
            : 'This batch has already finished, so there is nothing left to cancel.',
      };
    }
    return {
      done:
        outcome.cancelledCount === 0
          ? 'Cancelled. Every reminder in it had already been sent or stopped.'
          : cancelledNote(outcome.cancelledCount),
    };
  },
);

/* ── one invoice ────────────────────────────────────────────────────── */

export interface SendFormState {
  error?: string;
  fields?: { attest?: string };
  /** One line per channel, in the order the API tried them. */
  results?: Array<{ channel: string; label: string; detail: string | null; tone: string }>;
  /** The key was spent: the next press is a new reminder and needs a new key. */
  settled?: boolean;
}

const sendReminderActionGuarded = guarded(
  async (_prev: SendFormState, formData: FormData): Promise<SendFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const invoiceNumber = String(formData.get('invoiceNumber') ?? '').trim();
    const choice = String(formData.get('channels') ?? 'auto');
    const channels = channelsFromChoice(choice);
    const key = String(formData.get('idempotencyKey') ?? '');
    if (!invoiceNumber || channels === null || !KEY.test(key)) {
      return { error: 'That did not go through. Nothing was sent.' };
    }
    const attest = formData.get('attest') === 'yes';
    if (choiceMayEmail(choice) && !attest) {
      return {
        fields: {
          attest:
            'Tick the box to confirm you may contact this customer by email, or choose WhatsApp only.',
        },
      };
    }
    const outcome = await sendReminder(token, {
      invoiceNumber,
      channels,
      idempotencyKey: key,
      ...(attest ? { attest: true } : {}),
    });
    if (outcome.state === 'not_found') return { error: 'There is no invoice with this number.' };
    if (outcome.state === 'key_reused') {
      return {
        error: 'That press was already used for another reminder. Try again.',
        settled: true,
      };
    }
    if (outcome.state === 'invalid') return { error: 'That did not go through. Nothing was sent.' };
    revalidatePath('/app/reminders/invoice');
    return {
      settled: true,
      results: outcome.response.results.map((r) => {
        const { label, tone } = reminderStatusLabel(r.reminder.status);
        return {
          channel: channelName(r.channel),
          label,
          tone,
          detail: reminderStatusDetail(r.reminder.status, r.reminder.reasonCode, r.channel),
        };
      }),
    };
  },
);

export interface SimpleFormState {
  error?: string;
  done?: string;
  fields?: Record<string, string>;
}

const stopRemindersActionGuarded = guarded(
  async (_prev: SimpleFormState, formData: FormData): Promise<SimpleFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const invoiceNumber = String(formData.get('invoiceNumber') ?? '').trim();
    const stopped = formData.get('stopped') === 'true';
    if (!invoiceNumber) return { error: 'That did not go through. Nothing was changed.' };
    if (!(await setRemindersStopped(token, invoiceNumber, stopped))) {
      return { error: 'There is no invoice with this number. Nothing was changed.' };
    }
    revalidatePath('/app/reminders/invoice');
    return {
      done: stopped
        ? `Reminders for ${invoiceNumber} are stopped. ${STOPPED_NOTE} ${REMINDERS_IN_FLIGHT_NOTE}`
        : `Reminders for ${invoiceNumber} are back on.`,
    };
  },
);

/* ── settings: where customers pay, and who they call ──────────────── */

const savePaymentInstructionActionGuarded = guarded(
  async (_prev: SimpleFormState, formData: FormData): Promise<SimpleFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const bankName = String(formData.get('bankName') ?? '').trim();
    const accountName = String(formData.get('accountName') ?? '').trim();
    const accountNumberRaw = String(formData.get('accountNumber') ?? '');
    const fields: Record<string, string> = {};
    if (bankName.length < 2 || bankName.length > 60) {
      fields.bankName = paymentInstructionIssue('bank_name');
    }
    if (accountName.length < 2 || accountName.length > 80) {
      fields.accountName = paymentInstructionIssue('account_name');
    }
    const accountNumber = accountNumberDigits(accountNumberRaw);
    if (accountNumber === null) fields.accountNumber = paymentInstructionIssue('account_number');
    if (formData.get('approve') !== 'yes') {
      fields.approve = 'Tick the box to approve this account for your reminders.';
    }
    if (Object.keys(fields).length > 0) return { fields };
    const outcome = await savePaymentInstruction(token, {
      bankName,
      accountName,
      accountNumber: accountNumber!,
      approve: true,
    });
    if (outcome.state === 'invalid') {
      const map: Record<string, string> = {
        bank_name: 'bankName',
        account_name: 'accountName',
        account_number: 'accountNumber',
      };
      const issues = outcome.issues.length > 0 ? outcome.issues : ['unknown'];
      return {
        fields: Object.fromEntries(
          issues.map((i) => [map[i] ?? 'bankName', paymentInstructionIssue(i)]),
        ),
      };
    }
    revalidatePath('/app/settings');
    return { done: 'Saved. Reminders from now on ask customers to pay into this account.' };
  },
  SETTINGS_OUTCOME_UNKNOWN,
);

const clearPaymentInstructionActionGuarded = guarded(
  async (_prev: SimpleFormState, _formData: FormData): Promise<SimpleFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    await clearPaymentInstruction(token);
    revalidatePath('/app/settings');
    return {
      done: PAYMENT_INSTRUCTION_REMOVED,
    };
  },
  SETTINGS_OUTCOME_UNKNOWN,
);

const savePublicContactActionGuarded = guarded(
  async (_prev: SimpleFormState, formData: FormData): Promise<SimpleFormState> => {
    const token = await readSessionToken();
    if (!token) return { error: EXPIRED };
    const phone = String(formData.get('publicPhone') ?? '').trim();
    if (phone.length < 7 || phone.length > 20) {
      return { fields: { publicPhone: 'Enter the phone number customers should call.' } };
    }
    if (!(await savePublicContact(token, phone))) {
      return {
        fields: {
          publicPhone: 'That does not look like a phone number. Check it and try again.',
        },
      };
    }
    revalidatePath('/app/settings');
    return { done: 'Saved. Every reminder from now on shows this number.' };
  },
  SETTINGS_OUTCOME_UNKNOWN,
);

/* Plain async exports: a `use server` module exports async functions and nothing else. */
export async function previewBatchAction(
  prev: BatchFormState,
  formData: FormData,
): Promise<BatchFormState> {
  return previewBatchActionGuarded(prev, formData);
}
export async function createBatchAction(
  prev: BatchFormState,
  formData: FormData,
): Promise<BatchFormState> {
  return createBatchActionGuarded(prev, formData);
}
export async function cancelBatchAction(
  prev: CancelFormState,
  formData: FormData,
): Promise<CancelFormState> {
  return cancelBatchActionGuarded(prev, formData);
}
export async function sendReminderAction(
  prev: SendFormState,
  formData: FormData,
): Promise<SendFormState> {
  return sendReminderActionGuarded(prev, formData);
}
export async function stopRemindersAction(
  prev: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  return stopRemindersActionGuarded(prev, formData);
}
export async function savePaymentInstructionAction(
  prev: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  return savePaymentInstructionActionGuarded(prev, formData);
}
export async function clearPaymentInstructionAction(
  prev: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  return clearPaymentInstructionActionGuarded(prev, formData);
}
export async function savePublicContactAction(
  prev: SimpleFormState,
  formData: FormData,
): Promise<SimpleFormState> {
  return savePublicContactActionGuarded(prev, formData);
}
