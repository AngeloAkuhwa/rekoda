/**
 * Sending one payment reminder to a merchant's own customer (N1 slice A, OWN-43, OWN-57).
 *
 * The order is the safety:
 *   1. one transaction re-reads the invoice and its balance, the contact, the opt-out and the
 *      merchant's attestation, decides with the pure rule `reminderBlock`, and either records a
 *      named refusal or records a `sending` row, atomically;
 *   2. only after that commits is the provider called, with no lock held;
 *   3. the outcome moves the row forward exactly once.
 * A crash between 2 and 3 leaves a visible `sending` row, and a repeat of the same key returns it
 * instead of sending again. An unknown provider outcome is `uncertain` and is never resent.
 *
 * A reminder writes no sale, invoice, payment or ledger row: it reads the invoice and writes only
 * reminder bookkeeping.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REMINDER_POLICY_VERSION,
  composeEmailReminder,
  composeWhatsAppReminder,
  emailSuppressionKey,
  planChannels,
  reminderBlock,
  signReminderOptOut,
  verifyReminderOptOut,
  type ReminderBlockReason,
} from '@rekoda/core';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import { decryptFacet } from '@rekoda/core/vault';
import type {
  ReminderChannelResult,
  ReminderHistoryItem,
  ReminderHistoryResponse,
  SendReminderRequest,
  SendReminderResponse,
} from '@rekoda/contracts';
import type { NotificationChannel } from '@rekoda/core';
import { customersRepo, remindersRepo, withBusiness, type Db } from '@rekoda/db';
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

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(REMINDER_WHATSAPP) private readonly whatsapp: ReminderWhatsApp,
  ) {}

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
      );
      results.push({ channel, ...one });
    }
    return { results };
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
  ): Promise<{ reminder: ReminderHistoryItem; replayed: boolean }> {
    const prepared = await this.prepare(businessId, userId, input, channel, now);
    if (prepared.kind === 'replay') return { reminder: toItem(prepared.row), replayed: true };
    if (prepared.kind === 'blocked') return { reminder: toItem(prepared.row), replayed: false };

    const { reminderId } = prepared;
    let status: 'sent' | 'failed' | 'uncertain' | 'blocked' = 'sent';
    let reason: string | null = null;
    try {
      if (channel === 'email') {
        const optOut = signReminderOptOut(
          this.config.matchKey,
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
  ): Promise<Prepared> {
    return withBusiness(this.db, businessId, async (tx): Promise<Prepared> => {
      const prior = await remindersRepo.reminderByKey(tx, businessId, input.idempotencyKey);
      if (prior) return { kind: 'replay', row: prior };

      const invoice = await remindersRepo.invoiceForReminder(tx, businessId, input.invoiceNumber);
      if (!invoice) throw new ReminderInvoiceNotFound();
      const business = await remindersRepo.businessForReminder(tx, businessId);

      let email: string | null = null;
      let phone: string | null = null;
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
      }

      const channelAddress = channel === 'email' ? email : phone;
      const attestation =
        invoice.customerId && channel === 'email'
          ? await remindersRepo.latestAttestation(tx, businessId, invoice.customerId, 'email')
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
        attested: attestedAlready || input.attest === true,
        needsAttestation: channel === 'email',
        optedOut,
      });
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
        facts: {
          businessName: business!.name,
          publicPhone: business!.publicContactPhone!,
          invoiceNumber: invoice.invoiceNumber,
          balanceDueK: invoice.balanceDueK,
          dueDate: invoice.dueDate,
          now,
        },
      };
    });
  }

  async history(businessId: string, invoiceNumber: string): Promise<ReminderHistoryResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
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

  /** The signed link in a reminder email. Idempotent; a bad or forged token changes nothing. */
  async optOut(token: string): Promise<boolean> {
    const verified = verifyReminderOptOut(this.config.matchKey, token);
    if (!verified) return false;
    await withBusiness(this.db, verified.businessId, (tx) =>
      remindersRepo.recordEmailOptOut(tx, verified.businessId, verified.addressHash),
    );
    return true;
  }
}

function whatsAppResult(outcome: SendCustomerTextOutcome): {
  status: 'sent' | 'failed' | 'blocked';
  reason: string | null;
} {
  switch (outcome.outcome) {
    case 'sent':
      return { status: 'sent', reason: null };
    case 'not_entitled':
      return { status: 'blocked', reason: 'not_entitled' };
    case 'no_connection':
      return { status: 'blocked', reason: 'no_whatsapp_connection' };
    case 'invalid_recipient':
      return { status: 'blocked', reason: 'invalid_recipient' };
    /* OWN-57(C): outside the 24-hour window only an approved template may go, and none is
     * configured for reminders yet. Nothing is substituted. */
    case 'window_closed':
      return { status: 'blocked', reason: 'window_closed_no_template' };
    case 'suppressed':
      return { status: 'blocked', reason: 'customer_opted_out' };
    case 'allowance_exhausted':
      return { status: 'blocked', reason: 'allowance_exhausted' };
    case 'send_failed':
    case 'unavailable':
      return { status: 'failed', reason: 'send_failed' };
  }
}
