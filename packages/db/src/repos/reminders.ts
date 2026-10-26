/**
 * Customer payment reminders (migration 0184, N1, OWN-43, OWN-57).
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
}

/** The invoice a reminder names, read fresh. Money is read here and nowhere else in this flow. */
export async function invoiceForReminder(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
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
           i.reminders_stopped_at, COALESCE(i.customer_id, c.id) AS customer_id
    FROM invoices i
    LEFT JOIN customers c
      ON c.business_id = i.business_id AND c.token = i.snapshot_json ->> 'customerToken'
    WHERE i.business_id = ${businessId}::uuid AND upper(i.invoice_number) = upper(${invoiceNumber})
    LIMIT 1
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
  }>(sql`
    SELECT name, public_contact_phone, public_contact_approved_at, billing_email_verified_at
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
  };
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
  await tx.execute(sql`
    UPDATE invoices SET reminders_stopped_at = ${at === null ? null : at.toISOString()}::timestamptz
     WHERE business_id = ${businessId}::uuid AND id = ${invoiceId}::uuid
  `);
}

export async function latestAttestation(
  tx: TenantDb,
  businessId: string,
  customerId: string,
  channel: 'email',
): Promise<{ id: string; policyVersion: string; attestedAt: Date } | null> {
  const rows = await tx.execute<{ id: string; policy_version: string; attested_at: Date }>(sql`
    SELECT id, policy_version, attested_at FROM reminder_attestations
     WHERE business_id = ${businessId}::uuid AND customer_id = ${customerId}::uuid AND channel = ${channel}
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
    policyVersion: string;
    userId: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO reminder_attestations
      (business_id, customer_id, channel, policy_version, attested_by_user_id)
    VALUES (${input.businessId}::uuid, ${input.customerId}::uuid, ${input.channel},
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
