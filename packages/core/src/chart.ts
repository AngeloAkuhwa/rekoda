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

/**
 * The chart every business starts with (PR-030): the seventeen legacy ledger
 * keys carried over on their existing codes — a re-rendered statement must
 * not renumber a month already reported — plus the §11.2 roles the engine
 * will rely on that had no legacy key. The two PAYMENT_CONNECTION roles are
 * deliberately absent: clearing accounts are provisioned per connection
 * (PR-053), and seeding one with nothing to scope it to would violate the
 * design this chart exists to carry.
 *
 * Migration 0062 seeds the same chart in SQL for businesses that already
 * exist; the integration suite proves the two AGREE row for row.
 */
export interface SeedFinancialAccount {
  kind: 'bank' | 'till' | 'provider_settlement';
  label: string;
}

export interface SeedAccount {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  contra?: boolean;
  role?: SystemRole;
  /** Set exactly when the role's scope is FINANCIAL_ACCOUNT. */
  financial?: SeedFinancialAccount;
}

export const SEED_FINANCIAL_ACCOUNTS: readonly SeedFinancialAccount[] = [
  { kind: 'till', label: 'Cash on hand' },
  { kind: 'provider_settlement', label: 'Paystack settlements' },
  { kind: 'bank', label: 'Bank' },
];

export const SEED_CHART: readonly SeedAccount[] = [
  {
    code: '1000',
    name: 'Cash on Hand',
    type: 'asset',
    role: 'CASH',
    financial: { kind: 'till', label: 'Cash on hand' },
  },
  {
    code: '1010',
    name: 'Bank (Paystack settlements)',
    type: 'asset',
    role: 'BANK',
    financial: { kind: 'provider_settlement', label: 'Paystack settlements' },
  },
  {
    code: '1020',
    name: 'Bank',
    type: 'asset',
    role: 'BANK',
    financial: { kind: 'bank', label: 'Bank' },
  },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', role: 'ACCOUNTS_RECEIVABLE' },
  { code: '1150', name: 'Input VAT recoverable', type: 'asset', role: 'INPUT_VAT_RECOVERABLE' },
  {
    code: '1160',
    name: 'Withholding tax receivable',
    type: 'asset',
    role: 'WITHHOLDING_RECEIVABLE',
  },
  { code: '1200', name: 'Inventory', type: 'asset', role: 'INVENTORY_ASSET' },
  { code: '1300', name: 'Equipment', type: 'asset' },
  { code: '1310', name: 'Less: accumulated depreciation', type: 'asset', contra: true },
  { code: '2000', name: 'Accounts Payable', type: 'liability', role: 'ACCOUNTS_PAYABLE' },
  { code: '2100', name: 'VAT Payable', type: 'liability', role: 'VAT_PAYABLE' },
  { code: '2200', name: 'Unearned revenue', type: 'liability', role: 'CONTRACT_LIABILITY' },
  { code: '2300', name: 'Customer credits', type: 'liability', role: 'CUSTOMER_CREDIT' },
  { code: '3000', name: "Owner's Equity", type: 'equity', role: 'OWNER_EQUITY' },
  { code: '3100', name: 'Retained earnings', type: 'equity', role: 'RETAINED_EARNINGS' },
  { code: '3900', name: 'Opening balance equity', type: 'equity', role: 'OPENING_BALANCE_EQUITY' },
  { code: '4000', name: 'Sales Revenue', type: 'income', role: 'SALES_REVENUE' },
  { code: '4100', name: 'Sales returns', type: 'income', contra: true, role: 'SALES_RETURNS' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', role: 'COGS' },
  { code: '6000', name: 'Operating Expenses', type: 'expense', role: 'OPERATING_EXPENSES' },
  {
    code: '6050',
    name: 'Payment processing fees',
    type: 'expense',
    role: 'PAYMENT_PROCESSING_FEES',
  },
  { code: '6100', name: 'Depreciation', type: 'expense', role: 'DEPRECIATION' },
  { code: '6200', name: 'Loss (or gain) on equipment sold', type: 'expense' },
];
