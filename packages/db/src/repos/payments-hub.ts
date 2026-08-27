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
import {
  INTENT_STATUSES,
  resolvePaymentProvider,
  type ConnectionStatus,
  type PaymentIntentStatus,
  type PlatformCapability,
  type ProviderCapabilityKind,
  type ResolveProviderOutcome,
} from '@rekoda/core';
import {
  paymentAttempts,
  paymentConnections,
  paymentIntents,
  providerCapabilities,
} from '../schema/payments-hub.js';
import { provisionConnectionAccounts } from './accounts.js';

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
  settlementBankCode: string | null;
  settlementAccountLast4: string | null;
  settlementAccountName: string | null;
  /** Who bears the provider's fee (§14). The booking honours this. */
  feePolicy: string;
  /** platform_subaccount | merchant_key (ADR 0019, migration 0046). */
  keyMode: string;
  /** "key ending 4821" for the card. The key itself never leaves the vault. */
  merchantKeyTail: string | null;
  /** When the one-time approaching-the-cap nudge went out (M5d). */
  graduationNudgedAt: Date | null;
}

/**
 * Create or refresh the one connection this business has with this provider.
 *
 * Upsert on `(business_id, provider_type)`: reconnecting after a failure is a
 * state transition on the same row, never a second row — two rows would be two
 * settlement destinations with nobody able to say which is live.
 */

/** "paystack" → "Paystack", for the account names a merchant reads. */
const providerLabel = (providerType: string): string =>
  providerType.charAt(0).toUpperCase() + providerType.slice(1);

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
      /* §19 (PR-056): the platform subaccount model tells paystack the
       * subaccount pays; the economic bearer stays the merchant. */
      ...(input.providerType === 'paystack' ? { providerFeePayer: 'subaccount' } : {}),
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
      settlementBankCode: paymentConnections.settlementBankCode,
      settlementAccountLast4: paymentConnections.settlementAccountLast4,
      settlementAccountName: paymentConnections.settlementAccountName,
      feePolicy: paymentConnections.feePolicy,
      keyMode: paymentConnections.keyMode,
      merchantKeyTail: paymentConnections.merchantKeyTail,
      graduationNudgedAt: paymentConnections.graduationNudgedAt,
    });

  const row = rows[0];
  if (!row) throw new Error('upsertConnection: upsert returned no row');

  /* §11.2 (PR-053): the connection's own money-in-flight accounts, born
   * with it. Idempotent, so a reconnect provisions nothing twice. */
  await provisionConnectionAccounts(tx, {
    businessId: input.businessId,
    paymentConnectionId: row.id,
    providerLabel: providerLabel(input.providerType),
  });
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
      settlementBankCode: paymentConnections.settlementBankCode,
      settlementAccountLast4: paymentConnections.settlementAccountLast4,
      settlementAccountName: paymentConnections.settlementAccountName,
      feePolicy: paymentConnections.feePolicy,
      keyMode: paymentConnections.keyMode,
      merchantKeyTail: paymentConnections.merchantKeyTail,
      graduationNudgedAt: paymentConnections.graduationNudgedAt,
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

/**
 * The stored settlement cipher, for key-rotation runbooks and the tests that
 * prove the account number is a vault blob at rest. Returns the CIPHERTEXT —
 * nothing in this package can open it, which is the point.
 */
export async function settlementCipherFor(
  tx: TenantDb,
  businessId: string,
  providerType: string,
): Promise<string | null> {
  const rows = await tx
    .select({ cipher: paymentConnections.settlementAccountCipher })
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.businessId, businessId),
        eq(paymentConnections.providerType, providerType),
      ),
    )
    .limit(1);
  return rows[0]?.cipher ?? null;
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

/** Another live intent already covers this invoice — the mint race's loser.
 * The right response is to look up the winner, never to retry the insert. */
export class LiveIntentExists extends Error {}

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
      // Two unique indexes can reject this insert, and they mean different
      // things: a reference collision wants a fresh reference; a live-intent
      // collision wants the EXISTING intent. The constraint name says which.
      if (violatedConstraint(error) === 'payment_intents_live_invoice_ux') {
        throw new LiveIntentExists(`a live intent already covers invoice ${input.invoiceId}`);
      }
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
/**
 * The businesses behind a settlement batch, in ONE query.
 *
 * The settlement sweep used to resolve each reference with its own round
 * trip, and a Paystack daily batch at scale carries thousands: a per-row
 * loop made the ten-minute sweep scale with the platform's own success.
 */
export async function businessesForReferences(
  workerDb: Db,
  references: readonly string[],
): Promise<Map<string, string>> {
  if (references.length === 0) return new Map();
  const rows = await workerDb
    .select({ reference: paymentIntents.reference, businessId: paymentIntents.businessId })
    .from(paymentIntents)
    .where(inArray(paymentIntents.reference, [...references]));
  return new Map(rows.map((r) => [r.reference, r.businessId]));
}

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

/**
 * Claim the right to verify this intent with the provider (fix-plan 7, H7b).
 *
 * Every storefront status poll costs one verify on the merchant's own
 * Paystack key, and a page left open — or a bot — could spend the merchant's
 * provider rate limit by tapping. This is the same conditional-update shape
 * as `advanceIntent`: whoever moves `updated_at` first owns the window, and
 * everyone else inside it answers from what is already known. In the
 * database rather than memory, so replicas share one window.
 */
export async function claimVerifySlot(
  tx: TenantDb,
  intentId: string,
  minIntervalSeconds: number,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE payment_intents SET updated_at = now()
    WHERE id = ${intentId}::uuid
      AND updated_at <= now() - make_interval(secs => ${minIntervalSeconds})
    RETURNING id
  `);
  return [...rows].length === 1;
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
  return pgError(error) !== null;
}

/** Which unique constraint rejected the write, when PostgreSQL says. */
function violatedConstraint(error: unknown): string | null {
  const pg = pgError(error);
  return pg?.constraint_name ?? null;
}

function pgError(error: unknown): { code: string; constraint_name?: string } | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return e as { code: string; constraint_name?: string };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Store the merchant's own provider key (ADR 0019, fix-plan 6 M5a).
 *
 * Verified by the caller BEFORE this write: a key Paystack refused is never
 * stored. The row flips to merchant_key mode and becomes active in the same
 * statement, because on this model there is nothing further to wait for: no
 * subaccount to create, no platform confirmation to hold on. Upserted so a
 * business with no platform-model row can connect straight onto its own key.
 */
export async function storeMerchantKey(
  tx: TenantDb,
  input: {
    businessId: string;
    providerType: string;
    merchantKeyCipher: string;
    merchantKeyTail: string;
  },
): Promise<void> {
  const rows = await tx
    .insert(paymentConnections)
    .values({
      businessId: input.businessId,
      providerType: input.providerType,
      merchantKeyCipher: input.merchantKeyCipher,
      merchantKeyTail: input.merchantKeyTail,
      keyMode: 'merchant_key',
      status: 'active',
      kycStatus: 'not_required',
      /* §17.1/§17.2 (PR-052): their own key, their own arrangement — the
       * axes and attributes say so, and production derives from them. */
      operationalStatus: 'ACTIVE',
      commercialStatus: 'AGREED',
      representation: 'DIRECT_MERCHANT',
      credentialSource: 'MERCHANT_SUPPLIED',
      /* §19: on the merchant's own key, the account itself pays. */
      ...(input.providerType === 'paystack' ? { providerFeePayer: 'account' } : {}),
    })
    .onConflictDoUpdate({
      target: [paymentConnections.businessId, paymentConnections.providerType],
      set: {
        merchantKeyCipher: input.merchantKeyCipher,
        merchantKeyTail: input.merchantKeyTail,
        keyMode: 'merchant_key',
        status: 'active',
        operationalStatus: 'ACTIVE',
        commercialStatus: 'AGREED',
        representation: 'DIRECT_MERCHANT',
        credentialSource: 'MERCHANT_SUPPLIED',
        updatedAt: new Date(),
      },
    })
    .returning({ id: paymentConnections.id });

  const stored = rows[0];
  if (!stored) throw new Error('storeMerchantKey: upsert returned no row');
  await provisionConnectionAccounts(tx, {
    businessId: input.businessId,
    paymentConnectionId: stored.id,
    providerLabel: providerLabel(input.providerType),
  });
}

/** The vault blob of the merchant's key, for the adapter factory. */
export async function merchantKeyCipherFor(
  tx: TenantDb,
  businessId: string,
  providerType: string,
): Promise<string | null> {
  const rows = await tx
    .select({
      cipher: paymentConnections.merchantKeyCipher,
      keyMode: paymentConnections.keyMode,
    })
    .from(paymentConnections)
    .where(
      and(
        eq(paymentConnections.businessId, businessId),
        eq(paymentConnections.providerType, providerType),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row && row.keyMode === 'merchant_key' ? row.cipher : null;
}

/* ── Pay with Transfer (ADR 0016, fix-plan 6 M5c) ────────────────────────── */

export interface TransferAccount {
  bank: string;
  accountNumber: string;
  accountName: string | null;
  expiresAt: Date | null;
}

/**
 * Attach the provider's temporary account to the intent it was minted for.
 * Guarded like `advanceIntent`: a terminal intent never grows an account,
 * because a number recorded on a dead intent is a number nobody is watching.
 */
export async function recordTransferAccount(
  tx: TenantDb,
  intentId: string,
  account: TransferAccount,
): Promise<boolean> {
  const rows = await tx
    .update(paymentIntents)
    .set({
      transferBank: account.bank,
      transferAccountNumber: account.accountNumber,
      transferAccountName: account.accountName,
      transferExpiresAt: account.expiresAt,
      updatedAt: new Date(),
    })
    .where(and(eq(paymentIntents.id, intentId), not(inArray(paymentIntents.status, [...TERMINAL]))))
    .returning({ id: paymentIntents.id });
  return rows.length === 1;
}

/** The account stored on one intent, for re-showing rather than re-minting. */
export async function transferAccountFor(
  tx: TenantDb,
  businessId: string,
  intentId: string,
): Promise<TransferAccount | null> {
  const rows = await tx
    .select({
      bank: paymentIntents.transferBank,
      accountNumber: paymentIntents.transferAccountNumber,
      accountName: paymentIntents.transferAccountName,
      expiresAt: paymentIntents.transferExpiresAt,
    })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.id, intentId)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.bank || !row.accountNumber) return null;
  return {
    bank: row.bank,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    expiresAt: row.expiresAt,
  };
}

/**
 * Every live intent that carries a transfer account, across tenants — the
 * reconciliation sweep's worklist (ADR 0019: never rely on webhooks alone).
 * Worker connection only, same `worker_resolve` read as reference
 * resolution; every write the sweep makes goes back through `withBusiness`.
 */
export async function liveTransferIntents(
  workerDb: Db,
  limit = 200,
): Promise<Array<{ businessId: string; reference: string }>> {
  return workerDb
    .select({
      businessId: paymentIntents.businessId,
      reference: paymentIntents.reference,
    })
    .from(paymentIntents)
    .where(
      and(
        sql`${paymentIntents.transferAccountNumber} IS NOT NULL`,
        not(inArray(paymentIntents.status, [...TERMINAL])),
      ),
    )
    .orderBy(paymentIntents.createdAt)
    .limit(limit);
}

/**
 * Claim the one-time graduation nudge (ADR 0019, fix-plan 6 M5d). The NULL
 * predicate makes the database pick one winner, exactly like draft claims:
 * two payments crossing the threshold in the same minute produce one
 * message, not two.
 */
export async function claimGraduationNudge(
  tx: TenantDb,
  businessId: string,
  providerType: string,
): Promise<boolean> {
  const rows = await tx
    .update(paymentConnections)
    .set({ graduationNudgedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(paymentConnections.businessId, businessId),
        eq(paymentConnections.providerType, providerType),
        sql`${paymentConnections.graduationNudgedAt} IS NULL`,
      ),
    )
    .returning({ id: paymentConnections.id });
  return rows.length === 1;
}

/* ── payment attempts (spec §6.1, §22.3; PR-054) ────────────────────────── */

export type RecordAttemptOutcome =
  | { outcome: 'recorded'; id: string }
  /* §22.3's unique: a redelivered provider callback is the same try. */
  | { outcome: 'already_recorded'; id: string };

export async function recordPaymentAttempt(
  tx: TenantDb,
  input: {
    businessId: string;
    paymentIntentId: string;
    paymentConnectionId: string;
    providerAttemptId: string;
    method?: string;
  },
): Promise<RecordAttemptOutcome> {
  const rows = await tx
    .insert(paymentAttempts)
    .values({
      businessId: input.businessId,
      paymentIntentId: input.paymentIntentId,
      paymentConnectionId: input.paymentConnectionId,
      providerAttemptId: input.providerAttemptId,
      ...(input.method ? { method: input.method } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: paymentAttempts.id });
  const row = rows[0];
  if (row) return { outcome: 'recorded', id: row.id };
  const standing = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.businessId, input.businessId),
        eq(paymentAttempts.paymentConnectionId, input.paymentConnectionId),
        eq(paymentAttempts.providerAttemptId, input.providerAttemptId),
      ),
    )
    .limit(1);
  if (!standing[0]) throw new Error('recordPaymentAttempt: conflict row vanished');
  return { outcome: 'already_recorded', id: standing[0].id };
}

/** A try resolves once: INITIATED → SUCCEEDED | FAILED | ABANDONED. */
export async function resolvePaymentAttempt(
  tx: TenantDb,
  input: {
    businessId: string;
    attemptId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'ABANDONED';
    failureReason?: string;
  },
): Promise<'resolved' | 'not_found' | 'already_resolved'> {
  const rows = await tx
    .update(paymentAttempts)
    .set({
      status: input.status,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentAttempts.businessId, input.businessId),
        eq(paymentAttempts.id, input.attemptId),
        eq(paymentAttempts.status, 'INITIATED'),
      ),
    )
    .returning({ id: paymentAttempts.id });
  if (rows.length === 1) return 'resolved';
  const exists = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.businessId, input.businessId),
        eq(paymentAttempts.id, input.attemptId),
      ),
    )
    .limit(1);
  return exists[0] ? 'already_resolved' : 'not_found';
}

export async function attemptsForIntent(tx: TenantDb, businessId: string, paymentIntentId: string) {
  return tx
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.businessId, businessId),
        eq(paymentAttempts.paymentIntentId, paymentIntentId),
      ),
    )
    .orderBy(paymentAttempts.createdAt);
}

/* ── the provider resolver, over real rows (spec §17, §18; PR-068) ──────── */

/** The platform's standing, as 0093 seeded and operators amend it. */
export async function platformCapabilities(db: Db | TenantDb): Promise<PlatformCapability[]> {
  const rows = await db
    .select({
      providerType: providerCapabilities.providerType,
      capability: providerCapabilities.capability,
      status: providerCapabilities.status,
      reason: providerCapabilities.reason,
    })
    .from(providerCapabilities);
  return rows as PlatformCapability[];
}

/**
 * Which of this business's connections serves a need, from capability and
 * compliance and nothing else. The pure decision lives in @rekoda/core;
 * this reads the two layers it decides over — the platform capability
 * table and the merchant's own connections with their derived
 * `production_enabled` — and hands them across.
 */
export async function resolveProviderConnection(
  tx: TenantDb,
  businessId: string,
  need: ProviderCapabilityKind,
): Promise<ResolveProviderOutcome> {
  const connections = await tx
    .select({
      connectionId: paymentConnections.id,
      providerType: paymentConnections.providerType,
      productionEnabled: paymentConnections.productionEnabled,
      createdAt: paymentConnections.createdAt,
    })
    .from(paymentConnections)
    .where(eq(paymentConnections.businessId, businessId));
  const capabilities = await platformCapabilities(tx);
  return resolvePaymentProvider(
    need,
    connections.map((c) => ({
      connectionId: c.connectionId,
      providerType: c.providerType,
      productionEnabled: c.productionEnabled === true,
      connectedAtMs: c.createdAt?.getTime() ?? 0,
    })),
    capabilities,
  );
}
