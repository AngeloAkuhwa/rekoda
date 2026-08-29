/**
 * The chart of accounts as rows (spec §8, §11; PR-029).
 *
 * The constraints that make a wrong chart unrepresentable — all-or-none
 * scope, the §11.2 role/scope compatibility CHECK, tenant-safe composite
 * FKs, the role-set-once trigger — live in migration 0061; this file is the
 * query surface over them.
 */
import { sql } from 'drizzle-orm';
import { boolean, char, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

/** Where money physically sits: a bank account, a till, a provider
 * settlement pocket. B1 (PR-073) extends this with connection identity. */
export const financialAccounts = pgTable('financial_accounts', {
  id: id(),
  businessId: businessId(),
  kind: text('kind').notNull(), // bank | till | provider_settlement
  label: text('label').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('NGN'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    businessId: businessId(),
    /** Display code, the merchant-visible ordering key. */
    code: text('code').notNull(),
    /** The merchant's own name. Renameable — which is why the engine never
     * resolves by it. */
    name: text('name').notNull(),
    type: text('type').notNull(), // asset | liability | equity | income | expense
    /** Presentation only: renders negative beneath what it reduces. */
    contra: boolean('contra').notNull().default(false),
    systemRole: text('system_role'),
    systemScopeType: text('system_scope_type'),
    scopeBusinessId: uuid('scope_business_id'),
    scopePaymentConnectionId: uuid('scope_payment_connection_id'),
    scopeFinancialAccountId: uuid('scope_financial_account_id'),
    active: boolean('active').notNull().default(true),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accounts_code_ux').on(t.businessId, t.code)],
);
