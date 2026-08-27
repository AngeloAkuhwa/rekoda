/**
 * The chart of accounts (spec §11; PR-029).
 *
 * The engine's contract is `accountByRole`: a ROLE within a SCOPE, never a
 * name. The database's constraints (migration 0061) make the illegal shapes
 * unrepresentable; what this repo adds is the resolution the §11.2 mapping
 * promises — hand it a role and the scope the role needs, get exactly one
 * active account or an honest null.
 */
import { and, eq } from 'drizzle-orm';
import { ROLE_SCOPE, type SystemRole } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { accounts, financialAccounts } from '../schema/accounts.js';

export interface FinancialAccountInput {
  businessId: string;
  kind: 'bank' | 'till' | 'provider_settlement';
  label: string;
  currency?: string;
}

export async function createFinancialAccount(
  tx: TenantDb,
  input: FinancialAccountInput,
): Promise<{ id: string }> {
  const rows = await tx
    .insert(financialAccounts)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      label: input.label,
      ...(input.currency ? { currency: input.currency } : {}),
    })
    .returning({ id: financialAccounts.id });
  const row = rows[0];
  if (!row) throw new Error('createFinancialAccount: insert returned no row');
  return row;
}

/**
 * The scope an account's role points at. `business` needs no id — the §11.3
 * self-check pins it to the row's own tenant; the other two carry the row
 * the composite FK verifies.
 */
export type RoleScope =
  | { kind: 'business' }
  | { kind: 'payment_connection'; id: string }
  | { kind: 'financial_account'; id: string };

export interface AccountInput {
  businessId: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  contra?: boolean;
  /** Absent for a merchant's own free account; present for engine accounts. */
  role?: { systemRole: SystemRole; scope: RoleScope };
}

export async function createAccount(tx: TenantDb, input: AccountInput): Promise<{ id: string }> {
  const role = input.role;
  const rows = await tx
    .insert(accounts)
    .values({
      businessId: input.businessId,
      code: input.code,
      name: input.name,
      type: input.type,
      contra: input.contra ?? false,
      ...(role
        ? {
            systemRole: role.systemRole,
            systemScopeType:
              role.scope.kind === 'business'
                ? 'BUSINESS'
                : role.scope.kind === 'payment_connection'
                  ? 'PAYMENT_CONNECTION'
                  : 'FINANCIAL_ACCOUNT',
            scopeBusinessId: role.scope.kind === 'business' ? input.businessId : null,
            scopePaymentConnectionId:
              role.scope.kind === 'payment_connection' ? role.scope.id : null,
            scopeFinancialAccountId: role.scope.kind === 'financial_account' ? role.scope.id : null,
          }
        : {}),
    })
    .returning({ id: accounts.id });
  const row = rows[0];
  if (!row) throw new Error('createAccount: insert returned no row');
  return row;
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  contra: boolean;
  systemRole: string | null;
  systemScopeType: string | null;
  scopePaymentConnectionId: string | null;
  scopeFinancialAccountId: string | null;
  active: boolean;
}

export async function accountsFor(tx: TenantDb, businessId: string): Promise<AccountRow[]> {
  return tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      contra: accounts.contra,
      systemRole: accounts.systemRole,
      systemScopeType: accounts.systemScopeType,
      scopePaymentConnectionId: accounts.scopePaymentConnectionId,
      scopeFinancialAccountId: accounts.scopeFinancialAccountId,
      active: accounts.active,
    })
    .from(accounts)
    .where(eq(accounts.businessId, businessId))
    .orderBy(accounts.code);
}

/**
 * The engine's lookup. `scopeId` is required exactly when the role's §11.2
 * scope is not BUSINESS — asked for up front rather than inferred, because
 * "the clearing account" is meaningless until somebody says WHICH
 * connection's.
 */
export async function accountByRole(
  tx: TenantDb,
  businessId: string,
  role: SystemRole,
  scopeId?: string,
): Promise<AccountRow | null> {
  const scopeType = ROLE_SCOPE[role];
  if (scopeType !== 'BUSINESS' && !scopeId) {
    throw new Error(`accountByRole: ${role} is scoped per ${scopeType} and needs a scope id`);
  }
  const scopeCondition =
    scopeType === 'BUSINESS'
      ? eq(accounts.scopeBusinessId, businessId)
      : scopeType === 'PAYMENT_CONNECTION'
        ? eq(accounts.scopePaymentConnectionId, scopeId!)
        : eq(accounts.scopeFinancialAccountId, scopeId!);

  const rows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      contra: accounts.contra,
      systemRole: accounts.systemRole,
      systemScopeType: accounts.systemScopeType,
      scopePaymentConnectionId: accounts.scopePaymentConnectionId,
      scopeFinancialAccountId: accounts.scopeFinancialAccountId,
      active: accounts.active,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.businessId, businessId),
        eq(accounts.systemRole, role),
        eq(accounts.active, true),
        scopeCondition,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Renaming is the merchant's; identity is not (migration 0061's trigger). */
export async function renameAccount(
  tx: TenantDb,
  businessId: string,
  accountId: string,
  name: string,
): Promise<boolean> {
  const rows = await tx
    .update(accounts)
    .set({ name })
    .where(and(eq(accounts.businessId, businessId), eq(accounts.id, accountId)))
    .returning({ id: accounts.id });
  return rows.length === 1;
}
