/**
 * The §11.2 role-to-scope mapping, pinned. The database carries the same
 * mapping as a CHECK (migration 0061); the integration suite proves the two
 * agree by insertion, and this test keeps the TypeScript side honest about
 * its own shape.
 */
import { describe, expect, it } from 'vitest';
import { MANDATORY_ROLES, ROLE_SCOPE, SYSTEM_ROLES, isSystemRole, scopeOf } from './chart.js';

describe('the role vocabulary (§11.2)', () => {
  it('carries the twenty-one canonical roles, each with exactly one scope', () => {
    expect(SYSTEM_ROLES).toHaveLength(21);
    for (const role of SYSTEM_ROLES) {
      expect(['BUSINESS', 'PAYMENT_CONNECTION', 'FINANCIAL_ACCOUNT']).toContain(scopeOf(role));
    }
  });

  it('scopes the provider pair per CONNECTION and the money pair per ACCOUNT', () => {
    expect(ROLE_SCOPE.PAYMENT_PROVIDER_CLEARING).toBe('PAYMENT_CONNECTION');
    expect(ROLE_SCOPE.PROVIDER_CHARGEBACK_PAYABLE).toBe('PAYMENT_CONNECTION');
    expect(ROLE_SCOPE.BANK).toBe('FINANCIAL_ACCOUNT');
    expect(ROLE_SCOPE.CASH).toBe('FINANCIAL_ACCOUNT');
  });

  it('holds OWNER_EQUITY, which the §22.2 golden bank-feed test depends on', () => {
    expect(ROLE_SCOPE.OWNER_EQUITY).toBe('BUSINESS');
  });

  it('every mandatory role is a role', () => {
    for (const role of MANDATORY_ROLES) expect(isSystemRole(role)).toBe(true);
  });

  it('rejects a string nobody classified', () => {
    expect(isSystemRole('SALES REVENUE')).toBe(false);
    expect(isSystemRole('sales_revenue')).toBe(false);
  });
});
