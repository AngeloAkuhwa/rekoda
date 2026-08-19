/**
 * Payment Hub storage operations (docs/payments-v1.md §3–9).
 *
 * SQL and transaction boundaries only — the decisions live in
 * `@rekoda/core/payments`. Everything here takes a `TenantDb`, so a
 * connection or an intent cannot be written outside the tenant pin the caller
 * established; the one deliberately cross-tenant read (resolving an intent by
 * reference during webhook processing) is a separate function that requires
 * the WORKER connection, because `worker_resolve` is a policy on that role
 * and the API role must never gain it by accident.
 */
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { INTENT_STATUSES, type ConnectionStatus, type PaymentIntentStatus } from '@rekoda/core';
import { paymentConnections, paymentIntents } from '../schema/payments-hub.js';

const TERMINAL: readonly PaymentIntentStatus[] = ['succeeded', 'failed', 'expired', 'cancelled'];

/* ── connections ──────────────────────────────────────────────────────────── */

export interface ConnectionInput {
  businessId: string;
  providerType: string;
  settlementBankCode?: string | null;
  /** Vault blob. This layer never sees a plaintext account number. */
  settlementAccountCipher?: string | null;
  settlementAccountLast4?: string | null;
  settlementAccountName?: string | null;
}

export interface ConnectionRow {
  id: string;
  providerType: string;
  status: string;
  kycStatus: string;
  externalSubaccountId: string | null;
  settlementAccountLast4: string | null;
  /** Who bears the provider's fee (§14). The booking honours this. */
  feePolicy: string;
}

/**
 * Create or refresh the one connection this business has with this provider.
 *
 * Upsert on `(business_id, provider_type)`: reconnecting after a failure is a
 * state transition on the same row, never a second row — two rows would be two
 * settlement destinations with nobody able to say which is live.
 */
export async function upsertConnection(
  tx: TenantDb,
  input: ConnectionInput,
): Promise<ConnectionRow> {
  const rows = await tx
    .insert(paymentConnections)
    .values({
      businessId: input.businessId,
      providerType: input.providerType,
      settlementBankCode: input.settlementBankCode ?? null,
      settlementAccountCipher: input.settlementAccountCipher ?? null,
      settlementAccountLast4: input.settlementAccountLast4 ?? null,
      settlementAccountName: input.settlementAccountName ?? null,
      status: 'pending_provider_creation',
    })
    .onConflictDoUpdate({
      target: [paymentConnections.businessId, paymentConnections.providerType],
      set: {
        settlementBankCode: input.settlementBankCode ?? null,
        settlementAccountCipher: input.settlementAccountCipher ?? null,
        settlementAccountLast4: input.settlementAccountLast4 ?? null,
        settlementAccountName: input.settlementAccountName ?? null,
        status: 'pending_provider_creation',
        updatedAt: new Date(),
      },
    })
    .returning({
      id: paymentConnections.id,
      providerType: paymentConnections.providerType,
      status: paymentConnections.status,
      kycStatus: paymentConnections.kycStatus,
      externalSubaccountId: paymentConnections.externalSubaccountId,
      settlementAccountLast4: paymentConnections.settlementAccountLast4,
      feePolicy: paymentConnections.feePolicy,
    });

  const row = rows[0];
  if (!row) throw new Error('upsertConnection: upsert returned no row');
  return row;
}

export async function connectionFor(
  tx: TenantDb,
  businessId: string,
  providerType: string,
): Promise<ConnectionRow | null> {
  const rows = await tx
    .select({
      id: paymentConnections.id,
      providerType: paymentConnections.providerType,
      status: paymentConnections.status,
      kycStatus: paymentConnections.kycStatus,
      externalSubaccountId: paymentConnections.externalSubaccountId,
      settlementAccountLast4: paymentConnections.settlementAccountLast4,
      feePolicy: paymentConnections.feePolicy,
    })
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.businessId, businessId),
        eq(paymentConnections.providerType, providerType),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Advance the §5 state machine, optionally attaching provider identifiers. */
export async function setConnectionState(
  tx: TenantDb,
  connectionId: string,
  state: {
    status: ConnectionStatus;
    kycStatus?: string;
    externalMerchantId?: string | null;
    externalSubaccountId?: string | null;
  },
): Promise<void> {
  await tx
    .update(paymentConnections)
    .set({
      status: state.status,
      ...(state.kycStatus === undefined ? {} : { kycStatus: state.kycStatus }),
      ...(state.externalMerchantId === undefined
        ? {}
        : { externalMerchantId: state.externalMerchantId }),
      ...(state.externalSubaccountId === undefined
        ? {}
        : { externalSubaccountId: state.externalSubaccountId }),
      updatedAt: new Date(),
    })
    .where(eq(paymentConnections.id, connectionId));
}

/* ── intents ──────────────────────────────────────────────────────────────── */

export class ReferenceCollision extends Error {}

export interface IntentInput {
  businessId: string;
  reference: string;
  expectedAmountK: number;
  currency?: string;
  providerType: string;
  paymentConnectionId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  invoiceId?: string | null;
  expiresAt?: Date | null;
}

export interface IntentRow {
  id: string;
  reference: string;
  status: string;
  expectedAmountK: number;
  currency: string;
  businessId: string;
  invoiceId: string | null;
  customerId: string | null;
  /** Opaque checkout handle from the provider, when initialised. */
  providerCheckoutRef: string | null;
}

/**
 * Mint the intent. A reference collision surfaces as `ReferenceCollision` so
 * the caller retries with a fresh one — the same shape as customer tokens,
 * and for the same reason: the database decides uniqueness, the caller only
 * decides what to do about losing.
 */
export async function createIntent(tx: TenantDb, input: IntentInput): Promise<IntentRow> {
  try {
    const rows = await tx
      .insert(paymentIntents)
      .values({
        businessId: input.businessId,
        reference: input.reference,
        expectedAmountK: input.expectedAmountK,
        currency: input.currency ?? 'NGN',
        providerType: input.providerType,
        paymentConnectionId: input.paymentConnectionId ?? null,
        customerId: input.customerId ?? null,
        orderId: input.orderId ?? null,
        invoiceId: input.invoiceId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({
        id: paymentIntents.id,
        reference: paymentIntents.reference,
        status: paymentIntents.status,
        expectedAmountK: paymentIntents.expectedAmountK,
        currency: paymentIntents.currency,
        businessId: paymentIntents.businessId,
        invoiceId: paymentIntents.invoiceId,
        customerId: paymentIntents.customerId,
        providerCheckoutRef: paymentIntents.providerCheckoutRef,
      });
    const row = rows[0];
    if (!row) throw new Error('createIntent: insert returned no row');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ReferenceCollision(`reference ${input.reference} already exists`);
    }
    throw error;
  }
}

/** A business's own view of one intent. */
export async function intentByReference(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<IntentRow | null> {
  const rows = await tx
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      status: paymentIntents.status,
      expectedAmountK: paymentIntents.expectedAmountK,
      currency: paymentIntents.currency,
      businessId: paymentIntents.businessId,
      invoiceId: paymentIntents.invoiceId,
      customerId: paymentIntents.customerId,
      providerCheckoutRef: paymentIntents.providerCheckoutRef,
    })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.reference, reference)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The live intent already covering this invoice, if one exists.
 *
 * "Send her payment details" twice must reuse one reference, not mint a
 * second — two live references for one obligation means the unmatched-payment
 * queue the day the customer pays the older one.
 */
export async function liveIntentForInvoice(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
): Promise<IntentRow | null> {
  const rows = await tx
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      status: paymentIntents.status,
      expectedAmountK: paymentIntents.expectedAmountK,
      currency: paymentIntents.currency,
      businessId: paymentIntents.businessId,
      invoiceId: paymentIntents.invoiceId,
      customerId: paymentIntents.customerId,
      providerCheckoutRef: paymentIntents.providerCheckoutRef,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.businessId, businessId),
        eq(paymentIntents.invoiceId, invoiceId),
        not(inArray(paymentIntents.status, [...TERMINAL])),
      ),
    )
    .orderBy(paymentIntents.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a reference to its intent, across tenants.
 *
 * This is webhook resolution: the event names a reference and WHICH BUSINESS
 * it belongs to is the answer, not the input. It works only on the WORKER
 * connection — `worker_resolve` (migration 0010) is a SELECT-only policy on
 * that role — and returns nothing at all on the API's connection, which is the
 * intended failure: silent and empty rather than cross-tenant.
 */
export async function resolveIntentByReference(
  workerDb: Db,
  reference: string,
): Promise<IntentRow | null> {
  const rows = await workerDb
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      status: paymentIntents.status,
      expectedAmountK: paymentIntents.expectedAmountK,
      currency: paymentIntents.currency,
      businessId: paymentIntents.businessId,
      invoiceId: paymentIntents.invoiceId,
      customerId: paymentIntents.customerId,
      providerCheckoutRef: paymentIntents.providerCheckoutRef,
    })
    .from(paymentIntents)
    .where(eq(paymentIntents.reference, reference))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Advance a LIVE intent, atomically.
 *
 * The `NOT IN (terminal)` predicate is the same conditional-update shape as
 * CG3's draft claim: a webhook arriving after expiry must not resurrect the
 * intent, and a duplicate delivery racing the first must find the transition
 * already taken. Returns false for the loser — which is information, not an
 * error.
 */
export async function advanceIntent(
  tx: TenantDb,
  intentId: string,
  to: PaymentIntentStatus,
  attach?: { providerReference?: string; providerCheckoutRef?: string },
): Promise<boolean> {
  if (!INTENT_STATUSES.includes(to)) throw new Error(`advanceIntent: unknown status ${to}`);
  const rows = await tx
    .update(paymentIntents)
    .set({
      status: to,
      ...(attach?.providerReference === undefined
        ? {}
        : { providerReference: attach.providerReference }),
      ...(attach?.providerCheckoutRef === undefined
        ? {}
        : { providerCheckoutRef: attach.providerCheckoutRef }),
      updatedAt: new Date(),
    })
    .where(and(eq(paymentIntents.id, intentId), not(inArray(paymentIntents.status, [...TERMINAL]))))
    .returning({ id: paymentIntents.id });
  return rows.length === 1;
}

/** Expire every overdue live intent for this business. Returns how many. */
export async function expireOverdueIntents(tx: TenantDb, businessId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE payment_intents SET status = 'expired', updated_at = now()
    WHERE business_id = ${businessId}::uuid
      AND status NOT IN ('succeeded', 'failed', 'expired', 'cancelled')
      AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING id
  `);
  return [...rows].length;
}

/** PostgreSQL unique-violation, wrapped by drizzle under `.cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
