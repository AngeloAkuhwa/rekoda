/**
 * The chart of accounts' system roles (canonical spec §11; PR-029).
 *
 * The deterministic engine must never resolve an account by NAME: a lookup
 * for the string "Sales Revenue" breaks the first time a merchant renames
 * it, and renaming an account is something merchants do. It resolves a ROLE
 * within a SCOPE, and this module is the one place the role vocabulary and
 * the §11.2 role-to-scope mapping live. The database enforces the same
 * mapping again as a CHECK, so `ACCOUNTS_RECEIVABLE` scoped to a payment
 * connection is unrepresentable rather than merely wrong.
 */

export const SYSTEM_SCOPE_TYPES = ['BUSINESS', 'PAYMENT_CONNECTION', 'FINANCIAL_ACCOUNT'] as const;
export type SystemScopeType = (typeof SYSTEM_SCOPE_TYPES)[number];

/**
 * §11.2 verbatim. `CASH` scopes to a FINANCIAL_ACCOUNT because a till IS a
 * financial account (`financial_accounts.kind = 'till'`): where the money
 * physically sits is the scope, whether that is a bank or a cash drawer.
 */
export const ROLE_SCOPE = {
  /* Balances and subledgers. */
  ACCOUNTS_RECEIVABLE: 'BUSINESS',
  ACCOUNTS_PAYABLE: 'BUSINESS',
  RETAINED_EARNINGS: 'BUSINESS',
  CONTRACT_LIABILITY: 'BUSINESS',
  CUSTOMER_CREDIT: 'BUSINESS',
  /* Equity. */
  OWNER_EQUITY: 'BUSINESS',
  OPENING_BALANCE_EQUITY: 'BUSINESS',
  /* Trading. */
  SALES_REVENUE: 'BUSINESS',
  SALES_RETURNS: 'BUSINESS',
  INVENTORY_ASSET: 'BUSINESS',
  COGS: 'BUSINESS',
  /* Costs. */
  PAYMENT_PROCESSING_FEES: 'BUSINESS',
  OPERATING_EXPENSES: 'BUSINESS',
  DEPRECIATION: 'BUSINESS',
  /* Tax. F2 extends this set as the tax model lands. */
  VAT_PAYABLE: 'BUSINESS',
  INPUT_VAT_RECOVERABLE: 'BUSINESS',
  WITHHOLDING_RECEIVABLE: 'BUSINESS',
  /* Provider. Per CONNECTION, which is the whole reason a single global
   * systemKey was replaced: two providers means two clearing accounts. */
  PAYMENT_PROVIDER_CLEARING: 'PAYMENT_CONNECTION',
  PROVIDER_CHARGEBACK_PAYABLE: 'PAYMENT_CONNECTION',
  /* Money. */
  BANK: 'FINANCIAL_ACCOUNT',
  CASH: 'FINANCIAL_ACCOUNT',
} as const satisfies Record<string, SystemScopeType>;

export type SystemRole = keyof typeof ROLE_SCOPE;
export const SYSTEM_ROLES = Object.keys(ROLE_SCOPE) as SystemRole[];

/**
 * §11.4: a mandatory role may be deactivated only when a replacement of the
 * same role and scope is configured first. The chart of accounts must never
 * lose a required part.
 */
export const MANDATORY_ROLES = [
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'RETAINED_EARNINGS',
  'VAT_PAYABLE',
] as const satisfies readonly SystemRole[];

export function scopeOf(role: SystemRole): SystemScopeType {
  return ROLE_SCOPE[role];
}

export function isSystemRole(value: unknown): value is SystemRole {
  return typeof value === 'string' && value in ROLE_SCOPE;
}
