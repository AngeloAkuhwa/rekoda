/**
 * Customer payment reminders (migration 0184, N1, OWN-43, OWN-62).
 *
 * Reads and writes only reminder bookkeeping. Nothing here touches the ledger, an invoice's money
 * columns or a payment: a reminder creates no sale, invoice or accounting event.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface ReminderInvoice {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  balanceDueK: number;
  dueDate: Date | null;
  /** The customer row the invoice belongs to, found by id or by the snapshot token; null when unknown. */
  customerId: string | null;
  remindersStoppedAt: Date | null;
}

export interface ReminderBusiness {
  name: string;
  publicContactPhone: string | null;
  publicContactApprovedAt: Date | null;
  billingEmailVerifiedAt: Date | null;
  /** The merchant's billing email, still sealed; opening it is the caller's. Null when none. */
  billingEmailSealed: string | null;
  /** The merchant's approved bank details (REM-04), or null: a reminder then points to the public phone. */
  paymentInstruction: StoredPaymentInstruction | null;
}

/**
 * The invoice a reminder names, read fresh. Money is read here and nowhere else in this flow.
 *
 * `lock: 'share'` (REM-02) is for the send path: the invoice row is read `FOR SHARE`, so a payment
 * being posted (which takes the same row `FOR UPDATE` in `settle.ts`) is waited for and its
 * committed balance is what the reminder decides on, and no payment can land on the invoice until
 * the reminder's decision has committed. It is the only row lock the reminder takes, and the
 * payment path takes no reminder lock, so the two cannot deadlock.
 */
export async function invoiceForReminder(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
  options: { lock?: 'share' } = {},
): Promise<ReminderInvoice | null> {
  const rows = await tx.execute<{
    id: string;
    invoice_number: string;
    status: string;
    balance_due_k: string;
    due_date: Date | null;
    customer_id: string | null;
    reminders_stopped_at: Date | null;
  }>(sql`
    SELECT i.id, i.invoice_number, i.status, i.balance_due_k::bigint AS balance_due_k, i.due_date,
           s.stopped_at AS reminders_stopped_at, COALESCE(i.customer_id, c.id) AS customer_id
    FROM invoices i
    LEFT JOIN invoice_reminder_stops s
      ON s.business_id = i.business_id AND s.invoice_id = i.id
    LEFT JOIN customers c
      ON c.business_id = i.business_id AND c.token = i.snapshot_json ->> 'customerToken'
    WHERE i.business_id = ${businessId}::uuid AND upper(i.invoice_number) = upper(${invoiceNumber})
    LIMIT 1
    ${options.lock === 'share' ? sql`FOR SHARE OF i` : sql``}
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    invoiceId: row.id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    balanceDueK: Number(row.balance_due_k),
    dueDate: row.due_date === null ? null : new Date(row.due_date),
    customerId: row.customer_id ?? null,
    remindersStoppedAt:
      row.reminders_stopped_at === null ? null : new Date(row.reminders_stopped_at),
  };
}

export async function businessForReminder(
  tx: TenantDb,
  businessId: string,
): Promise<ReminderBusiness | null> {
  const rows = await tx.execute<{
    name: string;
    public_contact_phone: string | null;
    public_contact_approved_at: Date | null;
    billing_email_verified_at: Date | null;
    billing_email_sealed: string | null;
    payment_bank_name: string | null;
    payment_account_name: string | null;
    payment_account_number: string | null;
    payment_instruction_approved_at: Date | null;
  }>(sql`
    SELECT name, public_contact_phone, public_contact_approved_at, billing_email_verified_at,
           billing_email_sealed, payment_bank_name, payment_account_name, payment_account_number,
           payment_instruction_approved_at
    FROM businesses WHERE id = ${businessId}::uuid
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    name: row.name,
    publicContactPhone: row.public_contact_phone,
    publicContactApprovedAt:
      row.public_contact_approved_at === null ? null : new Date(row.public_contact_approved_at),
    billingEmailVerifiedAt:
      row.billing_email_verified_at === null ? null : new Date(row.billing_email_verified_at),
    billingEmailSealed: row.billing_email_sealed,
    /* Only a complete, approved instruction counts; the CHECK in 0187 makes that all or none. */
    paymentInstruction:
      row.payment_bank_name !== null &&
      row.payment_account_name !== null &&
      row.payment_account_number !== null &&
      row.payment_instruction_approved_at !== null
        ? {
            bankName: row.payment_bank_name,
            accountName: row.payment_account_name,
            accountNumber: row.payment_account_number,
          }
        : null,
  };
}

export interface StoredPaymentInstruction {
  bankName: string;
  accountName: string;
  accountNumber: string;
}

/** Saves the merchant's approved bank details, replacing any earlier ones. */
export async function setPaymentInstruction(
  tx: TenantDb,
  businessId: string,
  value: StoredPaymentInstruction,
  approvedBy: string,
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
       SET payment_bank_name = ${value.bankName},
           payment_account_name = ${value.accountName},
           payment_account_number = ${value.accountNumber},
           payment_instruction_approved_at = ${at.toISOString()}::timestamptz,
           payment_instruction_approved_by = ${approvedBy}::uuid
     WHERE id = ${businessId}::uuid
  `);
}

/** Removes the instruction; reminders fall back to the public phone. */
export async function clearPaymentInstruction(tx: TenantDb, businessId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
       SET payment_bank_name = NULL, payment_account_name = NULL, payment_account_number = NULL,
           payment_instruction_approved_at = NULL, payment_instruction_approved_by = NULL
     WHERE id = ${businessId}::uuid
  `);
}

export async function setPublicContact(
  tx: TenantDb,
  businessId: string,
  phone: string,
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
       SET public_contact_phone = ${phone}, public_contact_approved_at = ${at.toISOString()}::timestamptz
     WHERE id = ${businessId}::uuid
  `);
}

export async function setRemindersStopped(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
  at: Date | null,
): Promise<void> {
  if (at === null) {
    await tx.execute(sql`
      DELETE FROM invoice_reminder_stops
       WHERE business_id = ${businessId}::uuid AND invoice_id = ${invoiceId}::uuid
    `);
    return;
  }
  await tx.execute(sql`
    INSERT INTO invoice_reminder_stops (business_id, invoice_id, stopped_at)
    VALUES (${businessId}::uuid, ${invoiceId}::uuid, ${at.toISOString()}::timestamptz)
    ON CONFLICT (business_id, invoice_id) DO NOTHING
  `);
}

export async function latestAttestation(
  tx: TenantDb,
  businessId: string,
  customerId: string,
  channel: 'email',
  addressHash: string,
): Promise<{ id: string; policyVersion: string; attestedAt: Date } | null> {
  const rows = await tx.execute<{ id: string; policy_version: string; attested_at: Date }>(sql`
    SELECT id, policy_version, attested_at FROM reminder_attestations
     WHERE business_id = ${businessId}::uuid AND customer_id = ${customerId}::uuid AND channel = ${channel}
       AND address_hash = ${addressHash}
     ORDER BY attested_at DESC LIMIT 1
  `);
  const row = [...rows][0];
  return row
    ? { id: row.id, policyVersion: row.policy_version, attestedAt: new Date(row.attested_at) }
    : null;
}

export async function recordAttestation(
  tx: TenantDb,
  input: {
    businessId: string;
    customerId: string;
    channel: 'email';
    addressHash: string;
    policyVersion: string;
    userId: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO reminder_attestations
      (business_id, customer_id, channel, purpose, address_hash, policy_version, attested_by_user_id)
    VALUES (${input.businessId}::uuid, ${input.customerId}::uuid, ${input.channel}, 'debt_reminder', ${input.addressHash},
            ${input.policyVersion}, ${input.userId}::uuid)
    RETURNING id
  `);
  return [...rows][0]!.id;
}

export async function emailOptedOut(
  tx: TenantDb,
  businessId: string,
  addressHash: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1 FROM customer_email_optouts
     WHERE business_id = ${businessId}::uuid AND address_hash = ${addressHash} LIMIT 1
  `);
  return [...rows].length > 0;
}

/** Repeating an opt-out keeps the first moment. */
export async function recordEmailOptOut(
  tx: TenantDb,
  businessId: string,
  addressHash: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO customer_email_optouts (business_id, address_hash)
    VALUES (${businessId}::uuid, ${addressHash})
    ON CONFLICT (business_id, address_hash) DO NOTHING
  `);
}

export type ReminderStatus = 'sending' | 'sent' | 'blocked' | 'failed' | 'uncertain';

export interface ReminderRow {
  id: string;
  invoiceId: string;
  channel: 'email' | 'whatsapp';
  status: ReminderStatus;
  reasonCode: string | null;
  balanceK: number | null;
  createdAt: Date;
  sentAt: Date | null;
}

type RawReminder = {
  id: string;
  invoice_id: string;
  channel: 'email' | 'whatsapp';
  status: ReminderStatus;
  reason_code: string | null;
  balance_k: string | null;
  created_at: Date;
  sent_at: Date | null;
};

const readReminder = (row: RawReminder): ReminderRow => ({
  id: row.id,
  invoiceId: row.invoice_id,
  channel: row.channel,
  status: row.status,
  reasonCode: row.reason_code,
  balanceK: row.balance_k === null ? null : Number(row.balance_k),
  createdAt: new Date(row.created_at),
  sentAt: row.sent_at === null ? null : new Date(row.sent_at),
});

export async function reminderByKey(
  tx: TenantDb,
  businessId: string,
  idempotencyKey: string,
): Promise<ReminderRow | null> {
  const rows = await tx.execute<RawReminder>(sql`
    SELECT id, invoice_id, channel, status, reason_code, balance_k::text AS balance_k, created_at, sent_at
      FROM invoice_reminders
     WHERE business_id = ${businessId}::uuid AND idempotency_key = ${idempotencyKey}
  `);
  const row = [...rows][0];
  return row ? readReminder(row) : null;
}

/**
 * Starts a reminder. The unique idempotency key makes a repeated request return `null` instead of
 * a second row, so the caller never sends twice for one key.
 */
export async function startReminder(
  tx: TenantDb,
  input: {
    businessId: string;
    invoiceId: string;
    customerId: string | null;
    channel: 'email' | 'whatsapp';
    idempotencyKey: string;
    balanceK: number;
    attestationId: string | null;
    userId: string;
  },
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO invoice_reminders
      (business_id, invoice_id, customer_id, channel, status, idempotency_key, balance_k,
       attestation_id, requested_by)
    VALUES (${input.businessId}::uuid, ${input.invoiceId}::uuid, ${input.customerId}::uuid,
            ${input.channel}, 'sending', ${input.idempotencyKey}, ${input.balanceK},
            ${input.attestationId}::uuid, ${input.userId}::uuid)
    ON CONFLICT (business_id, idempotency_key) DO NOTHING
    RETURNING id
  `);
  return [...rows][0]?.id ?? null;
}

/** Records a request that was refused before anything was attempted. */
export async function recordBlockedReminder(
  tx: TenantDb,
  input: {
    businessId: string;
    invoiceId: string;
    customerId: string | null;
    channel: 'email' | 'whatsapp';
    idempotencyKey: string;
    reasonCode: string;
    balanceK: number | null;
    userId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO invoice_reminders
      (business_id, invoice_id, customer_id, channel, status, reason_code, idempotency_key,
       balance_k, requested_by)
    VALUES (${input.businessId}::uuid, ${input.invoiceId}::uuid, ${input.customerId}::uuid,
            ${input.channel}, 'blocked', ${input.reasonCode}, ${input.idempotencyKey},
            ${input.balanceK}, ${input.userId}::uuid)
    ON CONFLICT (business_id, idempotency_key) DO NOTHING
  `);
}

export async function finishReminder(
  tx: TenantDb,
  businessId: string,
  reminderId: string,
  status: Exclude<ReminderStatus, 'sending'>,
  reasonCode: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE invoice_reminders
       SET status = ${status}, reason_code = ${reasonCode}, updated_at = now(),
           sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END
     WHERE business_id = ${businessId}::uuid AND id = ${reminderId}::uuid AND status = 'sending'
  `);
}

export async function remindersForInvoice(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
  limit = 50,
): Promise<ReminderRow[]> {
  const rows = await tx.execute<RawReminder>(sql`
    SELECT id, invoice_id, channel, status, reason_code, balance_k::text AS balance_k, created_at, sent_at
      FROM invoice_reminders
     WHERE business_id = ${businessId}::uuid AND invoice_id = ${invoiceId}::uuid
     ORDER BY created_at DESC LIMIT ${limit}
  `);
  return [...rows].map(readReminder);
}

/**
 * A `sending` row that was never finished (the process died after the provider call, or the final
 * write failed) is shown as `uncertain`, not as still sending: the provider may or may not have
 * the message, and the merchant must not be told otherwise. It is never resent.
 */
export async function settleStaleSending(
  tx: TenantDb,
  businessId: string,
  olderThanMinutes: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE invoice_reminders
       SET status = 'uncertain', reason_code = 'delivery_unconfirmed', updated_at = now()
     WHERE business_id = ${businessId}::uuid AND status = 'sending'
       AND updated_at < now() - make_interval(mins => ${olderThanMinutes})
  `);
}

/** Serialises everything one idempotency key does, so a raced repeat finds the winner's row. */
export async function lockReminderKey(
  tx: TenantDb,
  businessId: string,
  idempotencyKey: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder:${businessId}:${idempotencyKey}`}, 0))`,
  );
}

/**
 * One reminder in flight per invoice and channel, whatever the idempotency key (REM-02): serialises
 * every request for this invoice on this channel, so a raced second request waits for the first to
 * commit its `sending` row and then sees it. Taken after the invoice's `FOR SHARE` read; nothing that holds
 * this lock waits on a payment.
 */
export async function lockReminderInvoiceChannel(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
  channel: 'email' | 'whatsapp',
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder-invoice:${businessId}:${invoiceId}:${channel}`}, 0))`,
  );
}

/**
 * Whether another attempt on this invoice and channel is still `sending` (REM-02): its provider
 * call may be in flight, or the process that made it died before settling. A `sending` row older
 * than the stale threshold has already been settled to `uncertain` by `settleStaleSending`, so only
 * a live or very recent attempt answers true. This is concurrency control only: a `sent`,
 * `uncertain`, `failed` or `blocked` row never holds anything, and no time since the last reminder
 * is measured (when to remind again is the reminder cadence, not this guard).
 */
export async function reminderInFlight(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
  channel: 'email' | 'whatsapp',
): Promise<boolean> {
  const rows = await tx.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM invoice_reminders
     WHERE business_id = ${businessId}::uuid AND invoice_id = ${invoiceId}::uuid
       AND channel = ${channel} AND status = 'sending'
     LIMIT 1
  `);
  return [...rows].length > 0;
}

/* ── a customer's WhatsApp reply to a reminder (OWN-83) ─────────────────────────────────────── */

/** The WhatsApp reminder a customer's reply answers. */
export interface SentWhatsAppReminder {
  id: string;
  invoiceNumber: string;
  customerId: string;
  sentAt: Date;
}

/**
 * The newest WhatsApp reminder this business sent in the last `withinDays` days to a customer
 * whose phone facet has this blind index (`match_key`, as the privacy gateway keys every phone it
 * stores), or null. One indexed lookup: no cap on how many other customers were reminded, and no
 * phone number is decrypted. Only `sent` ones: a reminder that never reached the customer cannot
 * be replied to.
 */
export async function sentWhatsAppReminderForPhone(
  tx: TenantDb,
  businessId: string,
  phoneMatchKey: string,
  opts: { withinDays: number },
): Promise<SentWhatsAppReminder | null> {
  const rows = await tx.execute<{
    id: string;
    invoice_number: string;
    customer_id: string;
    sent_at: Date;
  }>(sql`
    SELECT r.id, i.invoice_number, r.customer_id, r.sent_at
      FROM customer_identities ci
      JOIN invoice_reminders r
        ON r.business_id = ci.business_id AND r.customer_id = ci.customer_id
      JOIN invoices i ON i.business_id = r.business_id AND i.id = r.invoice_id
     WHERE ci.business_id = ${businessId}::uuid
       AND ci.facet = 'phone' AND ci.match_key = ${phoneMatchKey}
       AND r.channel = 'whatsapp' AND r.status = 'sent' AND r.sent_at IS NOT NULL
       AND r.sent_at > now() - make_interval(days => ${opts.withinDays})
     ORDER BY r.sent_at DESC, r.id DESC
     LIMIT 1
  `);
  const row = [...rows][0];
  return row
    ? {
        id: row.id,
        invoiceNumber: row.invoice_number,
        customerId: row.customer_id,
        sentAt: new Date(row.sent_at),
      }
    : null;
}

/**
 * Whether the business still has to be told about replies to this reminder. Takes a
 * transaction-scoped lock on the reminder first, so two customer messages handled at once are
 * decided one after the other: the second waits for the first to commit and then sees its row.
 * Writes nothing; `recordReminderReplyNotice` records the notice once it was delivered.
 */
export async function reminderReplyNoticeDue(
  tx: TenantDb,
  businessId: string,
  reminderId: string,
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`reminder-reply-notice:${businessId}:${reminderId}`}))`,
  );
  /* Due when never told, or when Meta later reported the notice failed (`undelivered_at`). */
  const rows = await tx.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM reminder_reply_notices
     WHERE business_id = ${businessId}::uuid AND reminder_id = ${reminderId}::uuid
       AND undelivered_at IS NULL
  `);
  return [...rows].length === 0;
}

/**
 * The business was told about replies to this reminder: Meta accepted the notice and gave it
 * `providerMessageId`. Recorded only then, in the caller's transaction, so a notice Meta refused
 * (an outage) is tried again on the customer's next message instead of being lost, and a job that
 * rolls back records nothing. A notice Meta accepted and later reported failed is marked by
 * `markReminderReplyNoticeUndelivered`; sending it again replaces the record.
 */
export async function recordReminderReplyNotice(
  tx: TenantDb,
  businessId: string,
  reminderId: string,
  providerMessageId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO reminder_reply_notices (business_id, reminder_id, provider_message_id)
    VALUES (${businessId}::uuid, ${reminderId}::uuid, ${providerMessageId})
    ON CONFLICT (business_id, reminder_id) DO UPDATE
       SET provider_message_id = EXCLUDED.provider_message_id,
           notified_at = now(),
           undelivered_at = NULL
     WHERE reminder_reply_notices.undelivered_at IS NOT NULL
  `);
}

/**
 * Meta reported a reply notice failed after accepting it (a delivery receipt; for example the
 * owner's 24-hour window was not really open). The reminder's notice becomes due again, so the
 * customer's next message tries once more. Returns how many notices were marked (0 or 1).
 */
export async function markReminderReplyNoticeUndelivered(
  tx: TenantDb,
  businessId: string,
  providerMessageId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE reminder_reply_notices SET undelivered_at = now()
     WHERE business_id = ${businessId}::uuid AND provider_message_id = ${providerMessageId}
       AND undelivered_at IS NULL
    RETURNING reminder_id AS id
  `);
  return [...rows].length;
}
