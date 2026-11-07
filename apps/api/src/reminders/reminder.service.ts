/**
 * Sending one payment reminder to a merchant's own customer (N1 slice A, OWN-43, OWN-62).
 *
 * The order is the safety:
 *   1. one transaction re-reads the invoice and its balance under a row lock (so a payment being
 *      posted is waited for), takes the per-invoice-and-channel lock, reads the contact, the
 *      opt-out and the merchant's attestation, checks nothing else is in flight, decides with the pure rule
 *      `reminderBlock`, and either records a named refusal or records a `sending` row, atomically;
 *   2. only after that commits is the provider called, with no transaction or lock held (the
 *      WhatsApp door commits its own reservation before Meta is called, REM-02);
 *   3. the outcome moves the row forward exactly once.
 * A crash between 2 and 3 leaves a visible `sending` row, and a repeat of the same key returns it
 * instead of sending again. An unknown provider outcome is `uncertain` and is never resent.
 *
 * A reminder writes no sale, invoice, payment or ledger row: it reads the invoice and writes only
 * reminder bookkeeping.
 */
import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { emailSuppressionKey, planChannels } from '@rekoda/core';
import {
  REMINDER_POLICY_VERSION,
  composeEmailReminder,
  composeWhatsAppReminder,
  reminderBlock,
  signReminderOptOut,
  validatePaymentInstruction,
  verifyReminderOptOut,
  type PaymentInstructionIssue,
  type ReminderBlockReason,
} from '@rekoda/core/reminders';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import { decryptFacet } from '@rekoda/core/vault';
import type {
  PaymentInstructionResponse,
  ReminderBatchPreviewRequest,
  ReminderBatchPreviewResponse,
  ReminderChannelResult,
  ReminderHistoryItem,
  ReminderHistoryResponse,
  SendReminderRequest,
  SendReminderResponse,
} from '@rekoda/contracts';
import type { NotificationChannel } from '@rekoda/core';
import {
  customersRepo,
  reminderBatchesRepo,
  remindersRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import {
  EMAIL_SENDER,
  EmailDeliveryUncertainError,
  EmailRefusedError,
  type EmailSender,
} from '../email/email.port.js';
import { EmailSuppressedError } from '../email/suppressing.sender.js';
import type {
  SendCustomerTextInput,
  SendCustomerTextOutcome,
} from '../channels/waba-templates.service.js';

export const REMINDER_WHATSAPP = Symbol('ReminderWhatsApp');

/** The one door to the merchant's own WhatsApp line (window, STOP, entitlement and metering live behind it). */
export interface ReminderWhatsApp {
  sendCustomerText(
    businessId: string,
    input: SendCustomerTextInput,
  ): Promise<SendCustomerTextOutcome>;
  /** Read-only: the refusal a send would give now, or null (REM-05 preview). Optional for doubles. */
  precheckCustomerText?(businessId: string, to: string): Promise<SendCustomerTextOutcome | null>;
}

/**
 * Read inside the transaction that would write a reminder's `sending` row, after its key lock: a
 * reason refuses the reminder there (nothing is written and nothing is sent), null lets it go.
 * Scheduled and bulk dispatch (REM-05) use it so a cancellation, or the scheduler losing the right
 * to send, that commits before that row cannot be overtaken by the send.
 */
export type ReminderDispatchGuard = (tx: TenantDb) => Promise<string | null>;

/** The dispatch guard refused: nothing was recorded or sent for this channel. */
export class ReminderWithdrawn extends Error {
  constructor(readonly reason: string) {
    super(`reminder_withdrawn:${reason}`);
  }
}

/** A stale `sending` row older than this is shown as uncertain, never as still sending. */
/* Kept well above the provider call timeouts (Resend 10 s, Meta's sender similar) so a live send is
 * never settled as uncertain while it is still in flight. */
const STALE_SENDING_MINUTES = 10;

/** The key was already used for a different invoice: replaying would silently skip this one. */
export class ReminderKeyReused extends Error {
  constructor() {
    super('idempotency_key_reused');
  }
}

export class ReminderInvoiceNotFound extends Error {
  constructor() {
    super('invoice_not_found');
  }
}

type Prepared =
  | { kind: 'replay'; row: remindersRepo.ReminderRow }
  | { kind: 'blocked'; row: remindersRepo.ReminderRow }
  | {
      kind: 'go';
      reminderId: string;
      email: string | null;
      phone: string | null;
      /** Rekoda support (REKODA_SUPPORT_EMAIL, OD-42(b)), for replies; null leaves it out. */
      replyTo: string | null;
      facts: Parameters<typeof composeEmailReminder>[0];
    };

const toItem = (row: remindersRepo.ReminderRow): ReminderHistoryItem => ({
  id: row.id,
  channel: row.channel,
  status: row.status,
  reasonCode: row.reasonCode,
  balanceK: row.balanceK,
  createdAt: row.createdAt.toISOString(),
  sentAt: row.sentAt ? row.sentAt.toISOString() : null,
});

@Injectable()
export class ReminderService {
  private readonly log = new Logger(ReminderService.name);
  /**
   * The opt-out link's signing key: derived from the API secret under its own label, so rotating
   * MATCH_KEY (which the vault's blind index uses) never breaks a link already in a customer's
   * inbox, and the API secret itself (which signs setup grants) is never used directly.
   */
  private readonly optOutKey: string;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(REMINDER_WHATSAPP) private readonly whatsapp: ReminderWhatsApp,
  ) {
    this.optOutKey = createHmac('sha256', config.secret)
      .update('rekoda:reminder-optout-key:v1', 'utf8')
      .digest('hex');
  }

  /**
   * One notification event, possibly on two channels. Each channel is its own durable attempt with
   * its own key (`<key>:<channel>`), judged and recorded independently, WhatsApp first: a failure,
   * a refusal or an unknown outcome on one never marks the other delivered and never repeats it.
   */
  async send(
    businessId: string,
    userId: string,
    input: SendReminderRequest,
    now: Date = new Date(),
    options: { guard?: ReminderDispatchGuard } = {},
  ): Promise<SendReminderResponse> {
    let channels: NotificationChannel[];
    if (input.channels === 'auto') {
      const on = await this.onFile(businessId, input.invoiceNumber);
      channels = planChannels('debt_reminder', 'auto', on);
      /* Neither is on file: one honest refusal row, not silence. */
      if (channels.length === 0) channels = ['whatsapp'];
    } else {
      channels = planChannels('debt_reminder', input.channels, { whatsapp: true, email: true });
    }
    const results: ReminderChannelResult[] = [];
    for (const channel of channels) {
      const one = await this.sendOne(
        businessId,
        userId,
        { ...input, channels: [channel], idempotencyKey: `${input.idempotencyKey}:${channel}` },
        channel,
        now,
        options,
      );
      results.push({ channel, ...one });
    }
    return { results };
  }

  /**
   * What a batch would do now (REM-05): for each distinct invoice, each planned channel, would it
   * be sent and if not why not. Reads only: no reminder, attestation or meter row is written and
   * nothing is sent. The same judgement as a send (`judge`, and for WhatsApp the gateway's own
   * pre-meter checks), so a preview never promises what the send would refuse. Everything is read
   * again immediately before each real send; a preview is a forecast, not a reservation.
   */
  async preview(
    businessId: string,
    input: ReminderBatchPreviewRequest,
  ): Promise<ReminderBatchPreviewResponse> {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const numbers: string[] = [];
    /* Invoice numbers are matched case-insensitively, as the send matches them. */
    for (const n of input.invoiceNumbers) {
      const k = reminderBatchesRepo.invoiceKey(n);
      /* Reported by key, the form invoice numbers are issued in, so it matches a recipient's. */
      if (seen.has(k)) duplicates.add(k);
      else {
        seen.add(k);
        numbers.push(n);
      }
    }
    const recipients: ReminderBatchPreviewResponse['recipients'] = [];
    for (const invoiceNumber of numbers) {
      const judged = await withBusiness(this.db, businessId, async (tx) => {
        const invoice = await remindersRepo.invoiceForReminder(tx, businessId, invoiceNumber);
        if (!invoice) return null;
        let channels: NotificationChannel[];
        if (input.channels === 'auto') {
          const facets = invoice.customerId
            ? await customersRepo.identityFacetsFor(tx, businessId, invoice.customerId)
            : [];
          channels = planChannels('debt_reminder', 'auto', {
            whatsapp: facets.some((f) => f.facet === 'phone'),
            email: facets.some((f) => f.facet === 'email'),
          });
          if (channels.length === 0) channels = ['whatsapp'];
        } else {
          channels = planChannels('debt_reminder', input.channels, {
            whatsapp: true,
            email: true,
          });
        }
        const out: Array<{
          channel: NotificationChannel;
          block: string | null;
          phone: string | null;
        }> = [];
        for (const channel of channels) {
          const inFlight = await remindersRepo.reminderInFlight(
            tx,
            businessId,
            invoice.invoiceId,
            channel,
          );
          const j = await this.judge(
            tx,
            businessId,
            invoice,
            channel,
            input.attest === true,
            inFlight,
          );
          out.push({ channel, block: j.block, phone: j.phone });
        }
        return {
          invoiceNumber: invoice.invoiceNumber,
          balanceK: invoice.balanceDueK,
          channels: out,
          alsoScheduled: await reminderBatchesRepo.invoiceAlsoScheduled(
            tx,
            businessId,
            invoice.invoiceId,
          ),
        };
      });
      if (!judged) {
        recipients.push({
          invoiceNumber,
          found: false,
          balanceK: null,
          channels: [],
          alsoScheduled: false,
        });
        continue;
      }
      const channels: ReminderBatchPreviewResponse['recipients'][number]['channels'] = [];
      for (const c of judged.channels) {
        let reason: string | null = c.block;
        if (reason === null && c.channel === 'whatsapp' && this.whatsapp.precheckCustomerText) {
          const refusal = await this.whatsapp.precheckCustomerText(businessId, c.phone!);
          if (refusal) reason = whatsAppResult(refusal).reason ?? 'send_failed';
        }
        channels.push({ channel: c.channel, eligible: reason === null, reasonCode: reason });
      }
      recipients.push({
        invoiceNumber: judged.invoiceNumber,
        found: true,
        balanceK: judged.balanceK,
        channels,
        alsoScheduled: judged.alsoScheduled,
      });
    }
    const eligibleCount = recipients.filter((r) => r.channels.some((c) => c.eligible)).length;
    return {
      recipients,
      eligibleCount,
      excludedCount: recipients.length - eligibleCount,
      duplicates: [...duplicates],
    };
  }

  /**
   * The merchant's email attestation for a confirmed batch (REM-05, OWN-62(A), OWN-65), recorded AT
   * CONFIRMATION in the caller's transaction (the one that writes the batch): one row per customer,
   * bound to the address on file now, by the confirming user, timestamped now. Dispatch then sends
   * no attestation of its own, so an address added or changed after confirmation has no attestation
   * and that email is refused (`attestation_required`) rather than sent to an address the merchant
   * never confirmed. A customer with no address, or with two (ambiguous), is attested for nothing.
   */
  async attestForBatch(
    tx: TenantDb,
    businessId: string,
    userId: string,
    invoiceNumbers: string[],
  ): Promise<void> {
    const done = new Set<string>();
    for (const invoiceNumber of invoiceNumbers) {
      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, invoiceNumber);
      const customerId = invoice?.customerId ?? null;
      if (!customerId || done.has(customerId)) continue;
      done.add(customerId);
      const facets = (await customersRepo.identityFacetsFor(tx, businessId, customerId)).filter(
        (f) => f.facet === 'email',
      );
      if (facets.length !== 1) continue;
      const email = decryptFacet(
        facets[0]!.ciphertext,
        this.config.vaultKey,
        `${businessId}:email`,
      );
      const addressHash = emailSuppressionKey(email);
      const prior = await remindersRepo.latestAttestation(
        tx,
        businessId,
        customerId,
        'email',
        addressHash,
      );
      if (prior?.policyVersion === REMINDER_POLICY_VERSION) continue;
      await remindersRepo.recordAttestation(tx, {
        businessId,
        customerId,
        channel: 'email',
        addressHash,
        policyVersion: REMINDER_POLICY_VERSION,
        userId,
      });
    }
  }

  /** Which channels have an address on file for this invoice's customer. */
  private async onFile(businessId: string, invoiceNumber: string) {
    return withBusiness(this.db, businessId, async (tx) => {
      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, invoiceNumber);
      if (!invoice) throw new ReminderInvoiceNotFound();
      if (!invoice.customerId) return { whatsapp: false, email: false };
      const facets = await customersRepo.identityFacetsFor(tx, businessId, invoice.customerId);
      return {
        whatsapp: facets.some((f) => f.facet === 'phone'),
        email: facets.some((f) => f.facet === 'email'),
      };
    });
  }

  /** One channel of one event. */
  async sendOne(
    businessId: string,
    userId: string,
    input: SendReminderRequest,
    channel: NotificationChannel,
    now: Date = new Date(),
    options: { guard?: ReminderDispatchGuard } = {},
  ): Promise<{ reminder: ReminderHistoryItem; replayed: boolean }> {
    const prepared = await this.prepare(businessId, userId, input, channel, now, options.guard);
    if (prepared.kind === 'replay') return { reminder: toItem(prepared.row), replayed: true };
    if (prepared.kind === 'blocked') return { reminder: toItem(prepared.row), replayed: false };

    const { reminderId } = prepared;
    let status: 'sent' | 'failed' | 'uncertain' | 'blocked' = 'sent';
    let reason: string | null = null;
    /* REM-03 / OWN-69: an opt-out is per channel, and it is honoured at dispatch, not only when the
     * attempt was opened. An email unsubscribe that commits after `prepare` but before the provider
     * call still stops this email (WhatsApp STOP is re-read inside `sendCustomerText` at the same
     * point). Each channel reads only its own preference: email never consults the WhatsApp STOP,
     * and WhatsApp never consults the email opt-out. The read is outside the provider's error
     * handling: if it fails, nothing has been sent, so it is recorded as a definite non-send
     * (`failed`), not as a provider-uncertain outcome. (If the database is still down when the
     * attempt is finished, the row stays `sending` and the stale sweep later settles it, as on
     * every other path.) */
    let dispatch: 'go' | 'opted_out' | 'not_checked' = 'go';
    if (channel === 'email') {
      try {
        const optedOut = await withBusiness(this.db, businessId, (tx) =>
          remindersRepo.emailOptedOut(tx, businessId, emailSuppressionKey(prepared.email!)),
        );
        if (optedOut) dispatch = 'opted_out';
      } catch (error) {
        dispatch = 'not_checked';
        /* The error class only: a message could carry query text or an address. */
        const kind = error instanceof Error ? error.constructor.name : 'unknown';
        this.log.warn(
          `reminder ${reminderId} not sent: the opt-out could not be re-read (${kind})`,
        );
      }
    }
    if (dispatch === 'opted_out') {
      status = 'blocked';
      reason = 'customer_opted_out';
    } else if (dispatch === 'not_checked') {
      status = 'failed';
      reason = 'send_failed';
    } else {
      try {
        if (channel === 'email') {
          const optOut = signReminderOptOut(
            this.optOutKey,
            businessId,
            emailSuppressionKey(prepared.email!),
          );
          const message = composeEmailReminder(
            prepared.facts,
            `${this.config.webUrl}/reminders/opt-out#token=${encodeURIComponent(optOut)}`,
          );
          await this.email.send({
            to: prepared.email!,
            subject: message.subject,
            text: message.text,
            fromName: message.fromName,
            ...(prepared.replyTo ? { replyTo: prepared.replyTo } : {}),
            idempotencyKey: `reminder-${reminderId}`,
          });
        } else {
          const outcome = await this.whatsapp.sendCustomerText(businessId, {
            to: prepared.phone!,
            text: composeWhatsAppReminder(prepared.facts),
          });
          ({ status, reason } = whatsAppResult(outcome));
        }
      } catch (error) {
        if (error instanceof EmailSuppressedError) {
          status = 'blocked';
          reason = 'address_suppressed';
        } else if (error instanceof EmailRefusedError) {
          status = 'failed';
          reason = 'send_failed';
        } else {
          /* An uncertain email, or anything unexpected: the provider may have the message. Never
           * resent; the merchant is told it could not be confirmed. Only the failure kind is kept. */
          status = 'uncertain';
          reason =
            error instanceof EmailDeliveryUncertainError ? 'delivery_unconfirmed' : 'unexpected';
          this.log.warn(`reminder ${reminderId} outcome unknown: ${reason}`);
        }
      }
    }
    const row = await withBusiness(this.db, businessId, async (tx) => {
      await remindersRepo.finishReminder(tx, businessId, reminderId, status, reason);
      return remindersRepo.reminderByKey(tx, businessId, input.idempotencyKey);
    });
    return { reminder: toItem(row!), replayed: false };
  }

  private async prepare(
    businessId: string,
    userId: string,
    input: SendReminderRequest,
    channel: NotificationChannel,
    now: Date,
    guard?: ReminderDispatchGuard,
  ): Promise<Prepared> {
    return withBusiness(this.db, businessId, async (tx): Promise<Prepared> => {
      /* One key at a time: a raced repeat waits here, then finds the winner's committed row, so
       * it cannot write a second attestation or a second reminder. */
      await remindersRepo.lockReminderKey(tx, businessId, input.idempotencyKey);
      await remindersRepo.settleStaleSending(tx, businessId, STALE_SENDING_MINUTES);

      /* FOR SHARE: a payment being posted holds this row FOR UPDATE, so this waits for it and
       * decides on the committed balance; and no payment lands until this decision commits. */
      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, input.invoiceNumber, {
        lock: 'share',
      });
      if (!invoice) throw new ReminderInvoiceNotFound();
      const prior = await remindersRepo.reminderByKey(tx, businessId, input.idempotencyKey);
      if (prior) {
        if (prior.invoiceId !== invoice.invoiceId) throw new ReminderKeyReused();
        return { kind: 'replay', row: prior };
      }
      /* After the replay check, so a recipient already attempted is reported, not withdrawn. */
      if (guard) {
        const refusal = await guard(tx);
        if (refusal !== null) throw new ReminderWithdrawn(refusal);
      }
      /* One reminder in flight per invoice and channel whatever the key: a raced request with
       * another key waits here, then sees the winner's `sending` row and is refused. No waiting
       * period follows a finished reminder; that is the cadence, not this guard. */
      await remindersRepo.lockReminderInvoiceChannel(tx, businessId, invoice.invoiceId, channel);
      const inFlight = await remindersRepo.reminderInFlight(
        tx,
        businessId,
        invoice.invoiceId,
        channel,
      );
      const { business, email, phone, attestation, attestedAlready, block } = await this.judge(
        tx,
        businessId,
        invoice,
        channel,
        input.attest === true,
        inFlight,
      );

      if (block !== null) {
        await remindersRepo.recordBlockedReminder(tx, {
          businessId,
          invoiceId: invoice.invoiceId,
          customerId: invoice.customerId,
          channel: channel,
          idempotencyKey: input.idempotencyKey,
          reasonCode: block,
          balanceK: invoice.balanceDueK,
          userId,
        });
        const row = await remindersRepo.reminderByKey(tx, businessId, input.idempotencyKey);
        return { kind: 'blocked', row: row! };
      }

      let attestationId = attestation?.id ?? null;
      if (channel === 'email' && !attestedAlready) {
        attestationId = await remindersRepo.recordAttestation(tx, {
          businessId,
          customerId: invoice.customerId!,
          channel: 'email',
          addressHash: emailSuppressionKey(email!),
          policyVersion: REMINDER_POLICY_VERSION,
          userId,
        });
      }
      const started = await remindersRepo.startReminder(tx, {
        businessId,
        invoiceId: invoice.invoiceId,
        customerId: invoice.customerId,
        channel: channel,
        idempotencyKey: input.idempotencyKey,
        balanceK: invoice.balanceDueK,
        attestationId: channel === 'email' ? attestationId : null,
        userId,
      });
      if (!started) {
        const row = await remindersRepo.reminderByKey(tx, businessId, input.idempotencyKey);
        return { kind: 'replay', row: row! };
      }
      return {
        kind: 'go',
        reminderId: started,
        email,
        phone,
        replyTo: channel === 'email' ? this.config.supportEmail : null,
        facts: {
          businessName: business!.name,
          publicPhone: business!.publicContactPhone!,
          paymentInstruction: business!.paymentInstruction,
          invoiceNumber: invoice.invoiceNumber,
          balanceDueK: invoice.balanceDueK,
          dueDate: invoice.dueDate,
          now,
        },
      };
    });
  }

  /**
   * The decision for one invoice on one channel, from what is committed now: the pure rule
   * `reminderBlock` plus the release flag, an ambiguous contact, email configuration and a valid
   * phone. Reads only. The send calls it under its locks; a preview (REM-05) calls it without them,
   * so the two can never disagree about why a reminder would not go.
   */
  private async judge(
    tx: TenantDb,
    businessId: string,
    invoice: remindersRepo.ReminderInvoice,
    channel: NotificationChannel,
    attest: boolean,
    inFlight: boolean,
  ) {
    const business = await remindersRepo.businessForReminder(tx, businessId);

    let email: string | null = null;
    let phone: string | null = null;
    /* More than one stored address of the kind this channel uses: which is current is unknown,
     * and an old one may now belong to someone else. Nothing is sent to a guess. */
    let ambiguous = false;
    if (invoice.customerId) {
      const facets = await customersRepo.identityFacetsFor(tx, businessId, invoice.customerId);
      const open = (facet: 'email' | 'phone'): string | null => {
        const found = facets.find((f) => f.facet === facet);
        return found
          ? decryptFacet(found.ciphertext, this.config.vaultKey, `${businessId}:${facet}`)
          : null;
      };
      email = open('email');
      phone = open('phone');
      const wanted = channel === 'email' ? 'email' : 'phone';
      ambiguous = facets.filter((f) => f.facet === wanted).length > 1;
    }

    const channelAddress = channel === 'email' ? email : phone;
    const attestation =
      invoice.customerId && channel === 'email'
        ? email !== null
          ? await remindersRepo.latestAttestation(
              tx,
              businessId,
              invoice.customerId,
              'email',
              emailSuppressionKey(email),
            )
          : null
        : null;
    const attestedAlready = attestation?.policyVersion === REMINDER_POLICY_VERSION;
    const optedOut =
      channel === 'email' && email !== null
        ? await remindersRepo.emailOptedOut(tx, businessId, emailSuppressionKey(email))
        : false;

    let block: ReminderBlockReason | null = reminderBlock({
      invoiceFound: true,
      invoiceStatus: invoice.status,
      balanceDueK: invoice.balanceDueK,
      remindersStopped: invoice.remindersStoppedAt !== null,
      hasCustomer: invoice.customerId !== null,
      hasContact: channelAddress !== null,
      publicContactApproved:
        business?.publicContactPhone != null && business.publicContactApprovedAt !== null,
      attested: attestedAlready || attest,
      needsAttestation: channel === 'email',
      optedOut,
      reminderInFlight: inFlight,
    });
    if (!this.config.customerReminders) block = 'reminders_not_released';
    if (block === null && ambiguous) block = 'ambiguous_contact';
    if (block === null && channel === 'email') {
      if (!this.email.available || !this.config.webUrl) block = 'email_not_configured';
    }
    if (block === null && channel === 'whatsapp') {
      try {
        normaliseParticipant(phone!);
      } catch (error) {
        if (!(error instanceof InvalidPhoneError)) throw error;
        block = 'invalid_recipient';
      }
    }
    return { business, email, phone, attestation, attestedAlready, block };
  }

  async history(businessId: string, invoiceNumber: string): Promise<ReminderHistoryResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      await remindersRepo.settleStaleSending(tx, businessId, STALE_SENDING_MINUTES);
      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, invoiceNumber);
      if (!invoice) throw new ReminderInvoiceNotFound();
      const rows = await remindersRepo.remindersForInvoice(tx, businessId, invoice.invoiceId);
      return {
        invoiceNumber: invoice.invoiceNumber,
        remindersStopped: invoice.remindersStoppedAt !== null,
        items: rows.map(toItem),
      };
    });
  }

  async setStopped(businessId: string, invoiceNumber: string, stopped: boolean, now = new Date()) {
    await withBusiness(this.db, businessId, async (tx) => {
      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, invoiceNumber);
      if (!invoice) throw new ReminderInvoiceNotFound();
      await remindersRepo.setRemindersStopped(
        tx,
        businessId,
        invoice.invoiceId,
        stopped ? now : null,
      );
    });
  }

  /** Returns false for a phone that is not a phone. */
  async setPublicContact(businessId: string, phone: string, now = new Date()): Promise<boolean> {
    let normalised: string;
    try {
      normalised = normaliseParticipant(phone);
    } catch (error) {
      if (error instanceof InvalidPhoneError) return false;
      throw error;
    }
    await withBusiness(this.db, businessId, (tx) =>
      remindersRepo.setPublicContact(tx, businessId, normalised, now),
    );
    return true;
  }

  /** The merchant's approved bank details, or null when none. */
  async paymentInstruction(businessId: string): Promise<PaymentInstructionResponse> {
    const business = await withBusiness(this.db, businessId, (tx) =>
      remindersRepo.businessForReminder(tx, businessId),
    );
    return { instruction: business?.paymentInstruction ?? null };
  }

  /** Returns the issues for details that do not validate; nothing is stored then. */
  async setPaymentInstruction(
    businessId: string,
    userId: string,
    input: { bankName: string; accountName: string; accountNumber: string },
    now = new Date(),
  ): Promise<{ ok: true } | { ok: false; issues: PaymentInstructionIssue[] }> {
    const checked = validatePaymentInstruction(input);
    if (!checked.ok) return checked;
    await withBusiness(this.db, businessId, (tx) =>
      remindersRepo.setPaymentInstruction(tx, businessId, checked.value, userId, now),
    );
    return { ok: true };
  }

  async clearPaymentInstruction(businessId: string): Promise<void> {
    await withBusiness(this.db, businessId, (tx) =>
      remindersRepo.clearPaymentInstruction(tx, businessId),
    );
  }

  /** The signed link in a reminder email. Idempotent; a bad or forged token changes nothing. */
  async optOut(token: string): Promise<boolean> {
    const verified = verifyReminderOptOut(this.optOutKey, token);
    if (!verified) return false;
    await withBusiness(this.db, verified.businessId, (tx) =>
      remindersRepo.recordEmailOptOut(tx, verified.businessId, verified.addressHash),
    );
    return true;
  }
}

function whatsAppResult(outcome: SendCustomerTextOutcome): {
  status: 'sent' | 'failed' | 'blocked' | 'uncertain';
  reason: string | null;
} {
  switch (outcome.outcome) {
    case 'sent':
      /* Meta accepted it, so it is sent and never resent. If the provider id could not be written
       * onto the outbound row, say so in the history: a later delivery report cannot be matched. */
      return {
        status: 'sent',
        reason: outcome.providerIdUnrecorded ? 'provider_id_unrecorded' : null,
      };
    case 'not_entitled':
      return { status: 'blocked', reason: 'not_entitled' };
    case 'no_connection':
      return { status: 'blocked', reason: 'no_whatsapp_connection' };
    case 'invalid_recipient':
      return { status: 'blocked', reason: 'invalid_recipient' };
    /* OWN-62(C): outside the 24-hour window only an approved template may go, and none is
     * configured for reminders yet. Nothing is substituted. */
    case 'window_closed':
      return { status: 'blocked', reason: 'window_closed_no_template' };
    case 'suppressed':
      return { status: 'blocked', reason: 'customer_opted_out' };
    case 'allowance_exhausted':
      return { status: 'blocked', reason: 'allowance_exhausted' };
    case 'send_failed':
      /* A timeout or dropped connection after Meta may have accepted it: not told as a failure,
       * so the merchant is not encouraged to send another. */
      return outcome.unknown
        ? { status: 'uncertain', reason: 'delivery_unconfirmed' }
        : { status: 'failed', reason: 'send_failed' };
    case 'unavailable':
      return { status: 'failed', reason: 'send_failed' };
  }
}
