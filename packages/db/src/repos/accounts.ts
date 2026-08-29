/**
 * The chart of accounts (spec §11; PR-029).
 *
 * The engine's contract is `accountByRole`: a ROLE within a SCOPE, never a
 * name. The database's constraints (migration 0061) make the illegal shapes
 * unrepresentable; what this repo adds is the resolution the §11.2 mapping
 * promises — hand it a role and the scope the role needs, get exactly one
 * active account or an honest null.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  ACCOUNTS,
  MANDATORY_ROLES,
  ROLE_SCOPE,
  SEED_CHART,
  SEED_FINANCIAL_ACCOUNTS,
  type AccountKey,
  type SystemRole,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { accounts, financialAccounts } from '../schema/accounts.js';
import { ledgerEntries } from '../schema/finance.js';

/**
 * The chart CODE of a legacy account key, as an inline SQL literal — the
 * comparison every reader uses once it joins through `account_id` (PR-033).
 * Never user input: these are the seed's own constants, the codes the
 * migration carried over from the seventeen-key era.
 */
export const codeOf = (key: AccountKey) => sql.raw(`'${ACCOUNTS[key].code}'`);

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

/* ── connection-scoped provisioning (spec §11.2; PR-053) ────────────────── */

/**
 * Every payment connection carries its own two money-in-flight accounts:
 * PAYMENT_PROVIDER_CLEARING (money the provider holds on the way to the
 * merchant) and PROVIDER_CHARGEBACK_PAYABLE (money the provider may take
 * back). Scoped per connection because "the clearing account" is
 * meaningless until somebody says WHICH connection's — the same argument
 * that shaped `accountByRole`.
 *
 * Idempotent: resolving the role in the connection's scope first means a
 * reconnect provisions nothing twice, and the one-role-per-scope unique
 * (0061/0066) backs that against every racer.
 */
export async function provisionConnectionAccounts(
  tx: TenantDb,
  input: { businessId: string; paymentConnectionId: string; providerLabel: string },
): Promise<{ clearingId: string; chargebackId: string }> {
  const wanted: Array<{
    role: SystemRole;
    baseCode: string;
    name: string;
    type: AccountInput['type'];
  }> = [
    {
      role: 'PAYMENT_PROVIDER_CLEARING',
      baseCode: '1015',
      name: `${input.providerLabel} clearing`,
      type: 'asset',
    },
    {
      role: 'PROVIDER_CHARGEBACK_PAYABLE',
      baseCode: '2150',
      name: `${input.providerLabel} chargebacks`,
      type: 'liability',
    },
  ];

  const ids: string[] = [];
  for (const spec of wanted) {
    const existing = await accountByRole(
      tx,
      input.businessId,
      spec.role,
      input.paymentConnectionId,
    );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    /* The display code must be unique per business; a second connection
     * takes a suffixed one. Codes are the merchant-visible ordering key,
     * never the engine's identity — the ROLE and its scope are. */
    const taken = await tx
      .select({ code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.businessId, input.businessId)));
    const codes = new Set(taken.map((r) => r.code));
    let code = spec.baseCode;
    for (let n = 2; codes.has(code); n += 1) code = `${spec.baseCode}-${n}`;

    const created = await createAccount(tx, {
      businessId: input.businessId,
      code,
      name: spec.name,
      type: spec.type,
      role: {
        systemRole: spec.role,
        scope: { kind: 'payment_connection', id: input.paymentConnectionId },
      },
    });
    ids.push(created.id);
  }
  return { clearingId: ids[0]!, chargebackId: ids[1]! };
}

/* ── lifecycle (spec §11.4; PR-035) ─────────────────────────────────────── */

const isMandatory = (role: string | null): role is SystemRole =>
  role !== null && (MANDATORY_ROLES as readonly string[]).includes(role);

async function accountRow(tx: TenantDb, businessId: string, accountId: string) {
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.id, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

export type DeactivateAccountOutcome =
  | { outcome: 'deactivated'; replacementId: string | null }
  | { outcome: 'not_found' }
  | { outcome: 'already_inactive' }
  /* A refusal that wrote nothing: the chart of accounts must never lose a
   * required part, and the replacement comes FIRST (§11.4). */
  | { outcome: 'mandatory_needs_replacement'; role: SystemRole };

/**
 * Take an account out of the working chart. History keeps it forever —
 * that is why deactivation exists instead of deletion — but nothing posts
 * into it again (migration 0066's trigger holds that at the door).
 *
 * A MANDATORY role deactivates only alongside its successor: one
 * transaction retires the predecessor and installs the replacement with
 * the same role, scope and statement placement, so the invariant "every
 * mandatory role has an active account" holds at every commit boundary.
 * The deferred `accounts_mandatory_role_guard` backs this up for any
 * writer that skips the repo.
 */
export async function deactivateAccount(
  tx: TenantDb,
  businessId: string,
  accountId: string,
  replacement?: { code: string; name: string },
): Promise<DeactivateAccountOutcome> {
  const row = await accountRow(tx, businessId, accountId);
  if (!row) return { outcome: 'not_found' };
  if (!row.active) return { outcome: 'already_inactive' };
  if (replacement && row.systemRole === null) {
    throw new Error('deactivateAccount: a replacement is only for role-bearing accounts');
  }
  if (isMandatory(row.systemRole) && !replacement) {
    return { outcome: 'mandatory_needs_replacement', role: row.systemRole };
  }

  await tx
    .update(accounts)
    .set({ active: false, deactivatedAt: new Date() })
    .where(and(eq(accounts.businessId, businessId), eq(accounts.id, accountId)));

  let replacementId: string | null = null;
  if (replacement && row.systemRole !== null) {
    const inserted = await tx
      .insert(accounts)
      .values({
        businessId,
        code: replacement.code,
        name: replacement.name,
        type: row.type,
        contra: row.contra,
        systemRole: row.systemRole,
        systemScopeType: row.systemScopeType,
        scopeBusinessId: row.scopeBusinessId,
        scopePaymentConnectionId: row.scopePaymentConnectionId,
        scopeFinancialAccountId: row.scopeFinancialAccountId,
      })
      .returning({ id: accounts.id });
    replacementId = inserted[0]?.id ?? null;
    if (!replacementId) throw new Error('deactivateAccount: replacement insert returned no row');
  }
  return { outcome: 'deactivated', replacementId };
}

export type ReactivateAccountOutcome =
  | { outcome: 'reactivated' }
  | { outcome: 'not_found' }
  | { outcome: 'already_active' }
  /* Its role slot is taken: a successor holds the role now, and one role
   * has one active account (accounts_role_scope_ux). */
  | { outcome: 'role_occupied' };

export async function reactivateAccount(
  tx: TenantDb,
  businessId: string,
  accountId: string,
): Promise<ReactivateAccountOutcome> {
  const row = await accountRow(tx, businessId, accountId);
  if (!row) return { outcome: 'not_found' };
  if (row.active) return { outcome: 'already_active' };
  if (row.systemRole !== null) {
    const scopeId =
      row.scopePaymentConnectionId ?? row.scopeFinancialAccountId ?? row.scopeBusinessId!;
    const holder = await accountByRole(tx, businessId, row.systemRole as SystemRole, scopeId);
    if (holder) return { outcome: 'role_occupied' };
  }
  await tx
    .update(accounts)
    .set({ active: true, deactivatedAt: null })
    .where(and(eq(accounts.businessId, businessId), eq(accounts.id, accountId)));
  return { outcome: 'reactivated' };
}

export type DeleteAccountOutcome =
  | { outcome: 'deleted' }
  | { outcome: 'not_found' }
  /* §11.4 row one: refused, always. The composite FK enforces it; this
   * outcome is the honest sentence instead of the constraint error. */
  | { outcome: 'has_postings' }
  /* Deleting the role's only account would orphan a required part; the
   * deferred guard would refuse the commit, so refuse the request. */
  | { outcome: 'mandatory_role' };

/**
 * The unposted delete §11.4 permits. Anything ever posted into is
 * history and history is kept — deactivate instead.
 */
export async function deleteAccount(
  tx: TenantDb,
  businessId: string,
  accountId: string,
): Promise<DeleteAccountOutcome> {
  const row = await accountRow(tx, businessId, accountId);
  if (!row) return { outcome: 'not_found' };

  const posted = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.businessId, businessId), eq(ledgerEntries.accountId, accountId)))
    .limit(1);
  if (posted.length > 0) return { outcome: 'has_postings' };

  if (isMandatory(row.systemRole)) {
    const scopeId =
      row.scopePaymentConnectionId ?? row.scopeFinancialAccountId ?? row.scopeBusinessId!;
    const holder = await accountByRole(tx, businessId, row.systemRole, scopeId);
    if (!holder || holder.id === accountId) return { outcome: 'mandatory_role' };
  }

  await tx
    .delete(accounts)
    .where(and(eq(accounts.businessId, businessId), eq(accounts.id, accountId)));
  return { outcome: 'deleted' };
}

/**
 * Give a business the chart it starts with (PR-030): the same rows migration
 * 0062 seeds for businesses that already existed, from the same SEED_CHART —
 * the integration suite proves the two agree row for row. Idempotent by
 * `onConflictDoNothing`, so a retried creation seeds once.
 */
export async function seedChartOfAccounts(tx: TenantDb, businessId: string): Promise<void> {
  /* The places money sits, looked up or created by their natural key. */
  const financialIds = new Map<string, string>();
  for (const fa of SEED_FINANCIAL_ACCOUNTS) {
    const existing = await tx
      .select({ id: financialAccounts.id })
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.businessId, businessId),
          eq(financialAccounts.kind, fa.kind),
          eq(financialAccounts.label, fa.label),
        ),
      )
      .limit(1);
    const id =
      existing[0]?.id ??
      (await createFinancialAccount(tx, { businessId, kind: fa.kind, label: fa.label })).id;
    financialIds.set(`${fa.kind}:${fa.label}`, id);
  }

  for (const seed of SEED_CHART) {
    await tx
      .insert(accounts)
      .values({
        businessId,
        code: seed.code,
        name: seed.name,
        type: seed.type,
        contra: seed.contra ?? false,
        ...(seed.role
          ? seed.financial
            ? {
                systemRole: seed.role,
                systemScopeType: 'FINANCIAL_ACCOUNT',
                scopeFinancialAccountId: financialIds.get(
                  `${seed.financial.kind}:${seed.financial.label}`,
                )!,
              }
            : {
                systemRole: seed.role,
                systemScopeType: 'BUSINESS',
                scopeBusinessId: businessId,
              }
          : {}),
      })
      .onConflictDoNothing();
  }
}
