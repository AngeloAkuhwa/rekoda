/**
 * The customer-credit subledger (spec §14.1; PR-048): one subledger, two
 * append-only tables. A credit is a balance the business owes a customer;
 * an unapplied credit reduces NO invoice until it is explicitly applied,
 * and the balance is always DERIVED — the grant minus the sum of its
 * applications — never a column that can drift.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { customerCreditApplications, customerCredits } from '../schema/finance.js';

export type GrantCreditOutcome =
  | { outcome: 'granted'; id: string }
  /* The unique on (sourceType, sourceId): one event, one credit — a
   * retried credit note cannot owe the customer twice. */
  | { outcome: 'already_granted' };

export async function grantCustomerCredit(
  tx: TenantDb,
  input: {
    businessId: string;
    customerId: string;
    amountMinor: number;
    currency?: string;
    /** What created the owing: credit_note | overpayment | ... */
    sourceType: string;
    sourceId: string;
    reason?: string;
  },
): Promise<GrantCreditOutcome> {
  const rows = await tx
    .insert(customerCredits)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      amountMinor: input.amountMinor,
      ...(input.currency ? { currency: input.currency } : {}),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.reason ? { reason: input.reason } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: customerCredits.id });
  const row = rows[0];
  if (!row) return { outcome: 'already_granted' };
  return { outcome: 'granted', id: row.id };
}

/** One credit's remaining balance: the grant minus its applications. */
export async function creditBalanceMinor(
  tx: TenantDb,
  businessId: string,
  customerCreditId: string,
): Promise<number | null> {
  const rows = await tx.execute<{ balance: string }>(sql`
    SELECT c.amount_minor - COALESCE((
      SELECT SUM(a.amount_minor) FROM customer_credit_applications a
      WHERE a.business_id = c.business_id AND a.customer_credit_id = c.id
    ), 0) AS balance
    FROM customer_credits c
    WHERE c.business_id = ${businessId}::uuid AND c.id = ${customerCreditId}::uuid
  `);
  const row = [...rows][0];
  return row ? Number(row.balance) : null;
}

/** Everything the business owes one customer, unapplied, across credits. */
export async function customerCreditBalanceMinor(
  tx: TenantDb,
  businessId: string,
  customerId: string,
): Promise<number> {
  const rows = await tx.execute<{ balance: string }>(sql`
    SELECT COALESCE(SUM(
      c.amount_minor - COALESCE((
        SELECT SUM(a.amount_minor) FROM customer_credit_applications a
        WHERE a.business_id = c.business_id AND a.customer_credit_id = c.id
      ), 0)
    ), 0) AS balance
    FROM customer_credits c
    WHERE c.business_id = ${businessId}::uuid AND c.customer_id = ${customerId}::uuid
  `);
  return Number([...rows][0]?.balance ?? 0);
}

export type ApplyCreditOutcome =
  | { outcome: 'applied'; id: string; remainingMinor: number }
  | { outcome: 'not_found' }
  /* A refusal that wrote nothing: the credit does not stretch. */
  | { outcome: 'insufficient_credit'; remainingMinor: number };

/**
 * §14.1's explicit act. The application row is the fact; how the invoice's
 * balance and the ledger answer it belongs to the flow that calls this
 * (the credit-note slice), because a subledger that also posted would be a
 * second engine.
 */
export async function applyCustomerCredit(
  tx: TenantDb,
  input: {
    businessId: string;
    customerCreditId: string;
    invoiceId: string;
    amountMinor: number;
    sourceType: string;
    sourceId: string;
  },
): Promise<ApplyCreditOutcome> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error(
      `applyCustomerCredit: amount must be a positive integer, got ${input.amountMinor}`,
    );
  }
  const remaining = await creditBalanceMinor(tx, input.businessId, input.customerCreditId);
  if (remaining === null) return { outcome: 'not_found' };
  if (remaining < input.amountMinor) {
    return { outcome: 'insufficient_credit', remainingMinor: remaining };
  }
  const rows = await tx
    .insert(customerCreditApplications)
    .values({
      businessId: input.businessId,
      customerCreditId: input.customerCreditId,
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    })
    .returning({ id: customerCreditApplications.id });
  const row = rows[0];
  if (!row) throw new Error('applyCustomerCredit: insert returned no row');
  return { outcome: 'applied', id: row.id, remainingMinor: remaining - input.amountMinor };
}

export type ReverseApplicationOutcome =
  | { outcome: 'reversed'; id: string }
  | { outcome: 'not_found' }
  | { outcome: 'already_reversed' }
  /* §14.2: cannot reverse a reversal. */
  | { outcome: 'is_a_reversal' };

/**
 * §14.2's one full reversal. A partial change of mind is this, then a
 * fresh application of the correct amount — never an edited row.
 */
export async function reverseCreditApplication(
  tx: TenantDb,
  input: {
    businessId: string;
    applicationId: string;
    reason: string;
    sourceType: string;
    sourceId: string;
  },
): Promise<ReverseApplicationOutcome> {
  const rows = await tx
    .select()
    .from(customerCreditApplications)
    .where(
      and(
        eq(customerCreditApplications.businessId, input.businessId),
        eq(customerCreditApplications.id, input.applicationId),
      ),
    )
    .limit(1);
  const original = rows[0];
  if (!original) return { outcome: 'not_found' };
  if (original.reversalOfId !== null) return { outcome: 'is_a_reversal' };
  const standing = await tx
    .select({ id: customerCreditApplications.id })
    .from(customerCreditApplications)
    .where(
      and(
        eq(customerCreditApplications.businessId, input.businessId),
        eq(customerCreditApplications.reversalOfId, input.applicationId),
      ),
    )
    .limit(1);
  if (standing[0]) return { outcome: 'already_reversed' };

  const inserted = await tx
    .insert(customerCreditApplications)
    .values({
      businessId: input.businessId,
      customerCreditId: original.customerCreditId,
      invoiceId: original.invoiceId,
      amountMinor: -original.amountMinor,
      currency: original.currency,
      reversalOfId: original.id,
      reason: input.reason,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    })
    .returning({ id: customerCreditApplications.id });
  const row = inserted[0];
  if (!row) throw new Error('reverseCreditApplication: insert returned no row');
  return { outcome: 'reversed', id: row.id };
}

/** The credit's paper trail, newest first. */
export async function creditApplicationsFor(
  tx: TenantDb,
  businessId: string,
  customerCreditId: string,
) {
  return tx
    .select()
    .from(customerCreditApplications)
    .where(
      and(
        eq(customerCreditApplications.businessId, businessId),
        eq(customerCreditApplications.customerCreditId, customerCreditId),
      ),
    )
    .orderBy(desc(customerCreditApplications.createdAt));
}
