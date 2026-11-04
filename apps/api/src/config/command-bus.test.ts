/**
 * Which door each write takes: the command bus by default, with a per-command
 * `0` as the emergency rollback (remediation R2; Build 9, OD-4).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

describe('PlaceOrder is the default door (remediation R2)', () => {
  it('runs the command when nothing is configured', () => {
    /* The inverted sense is the whole point: an environment that never heard
     * of the flag takes orders through the path that checks entitlement and
     * claims an idempotency key. */
    expect(loadConfig(BASE).commandPlaceOrder).toBe(true);
  });

  it('still switches off explicitly, so a rollback has somewhere to land', () => {
    expect(loadConfig({ ...BASE, REKODA_COMMAND_PLACE_ORDER: '0' }).commandPlaceOrder).toBe(false);
  });

  it('reads 1 as on, so an environment that set it during rollout is unchanged', () => {
    expect(loadConfig({ ...BASE, REKODA_COMMAND_PLACE_ORDER: '1' }).commandPlaceOrder).toBe(true);
  });
});

/**
 * Build 9, OD-4 (approved by the owner, 8 Oct 2026): every write takes the
 * command bus unless its flag says `0`. Unset or `1` is the bus; `0` is the
 * per-command emergency rollback to the same work called directly (a
 * configuration change and a restart of the same image, no code deploy);
 * any other explicit value is invalid configuration and refuses to load.
 */
describe('the command bus is the default door for every write (Build 9)', () => {
  const FLAGS = [
    ['REKODA_COMMAND_RECORD_SALE', 'commandRecordSale'],
    ['REKODA_COMMAND_ISSUE_INVOICE', 'commandIssueInvoice'],
    ['REKODA_COMMAND_RECORD_PAYMENT', 'commandRecordPayment'],
    ['REKODA_COMMAND_CONFIRM_PAYMENT', 'commandConfirmPayment'],
    ['REKODA_COMMAND_RECORD_EXPENSE', 'commandRecordExpense'],
    ['REKODA_COMMAND_RECORD_PURCHASE', 'commandRecordPurchase'],
    ['REKODA_COMMAND_POST_JOURNAL', 'commandPostJournal'],
    ['REKODA_COMMAND_CLOSE_PERIOD', 'commandClosePeriod'],
    ['REKODA_COMMAND_OPENING_BALANCES', 'commandOpeningBalances'],
    ['REKODA_COMMAND_PLACE_ORDER', 'commandPlaceOrder'],
    ['REKODA_COMMAND_RECORD_ORDER', 'commandRecordOrder'],
    ['REKODA_COMMAND_INGEST_FINANCIAL_TRANSACTION', 'commandIngestFinancialTransaction'],
    ['REKODA_COMMAND_CONFIRM_RECONCILIATION', 'commandConfirmReconciliation'],
    ['REKODA_COMMAND_ADJUST_INVENTORY', 'commandAdjustInventory'],
  ] as const;

  /* A production environment that names no command flag at all. */
  const PRODUCTION = {
    ...BASE,
    NODE_ENV: 'production',
    REKODA_TRUSTED_PROXIES: '172.30.10.10',
    REKODA_TRUSTED_WEB: '172.30.10.11',
    META_APP_SECRET: 'm'.repeat(40),
    META_VERIFY_TOKEN: 'v'.repeat(40),
    OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
    OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
    OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  } as NodeJS.ProcessEnv;

  it('the production fixture names no command flag', () => {
    expect(Object.keys(PRODUCTION).filter((k) => k.startsWith('REKODA_COMMAND_'))).toEqual([]);
  });

  it('covers all fourteen flags', () => {
    expect(FLAGS).toHaveLength(14);
  });

  it.each(FLAGS)('%s: unset runs the command bus', (_name, key) => {
    expect(loadConfig(BASE)[key]).toBe(true);
  });

  it.each(FLAGS)(
    '%s: 1 runs the command bus (an opted-in environment is unchanged)',
    (name, key) => {
      expect(loadConfig({ ...BASE, [name]: '1' })[key]).toBe(true);
    },
  );

  it.each(FLAGS)('%s: 0 is the per-command rollback to the direct call', (name, key) => {
    expect(loadConfig({ ...BASE, [name]: '0' })[key]).toBe(false);
  });

  /* OD-4 (approved 8 Oct 2026): any other explicit value is a configuration
   * error, never quietly the bus. Somebody who typed `false` meant a
   * rollback, and must be told it did not take, not left on the bus. */
  const INVALID = [
    '',
    'true',
    'false',
    'on',
    'off',
    'yes',
    'no',
    '00',
    '01',
    '2',
    ' 1 ',
    ' 0 ',
    '1 ',
    'ON',
    'disable',
  ];

  it.each(FLAGS)('%s: any other value refuses to load, naming the variable', (name) => {
    for (const value of INVALID) {
      expect(
        () => loadConfig({ ...BASE, [name]: value }),
        `${name}=${JSON.stringify(value)}`,
      ).toThrow(new RegExp(`${name} must be 1`));
    }
  });

  it('one rollback leaves every other command on the bus', () => {
    const config = loadConfig({ ...BASE, REKODA_COMMAND_RECORD_PURCHASE: '0' });
    for (const [, key] of FLAGS) {
      expect(config[key]).toBe(key !== 'commandRecordPurchase');
    }
  });

  it('a production configuration that names no flag runs every write on the bus', () => {
    const config = loadConfig(PRODUCTION);
    for (const [, key] of FLAGS) expect(config[key]).toBe(true);
  });

  it('in production, one valid 0 rolls back only that command', () => {
    const config = loadConfig({ ...PRODUCTION, REKODA_COMMAND_RECORD_SALE: '0' });
    for (const [, key] of FLAGS) expect(config[key]).toBe(key !== 'commandRecordSale');
  });

  it('in production, one invalid value refuses to boot', () => {
    expect(() => loadConfig({ ...PRODUCTION, REKODA_COMMAND_RECORD_SALE: 'false' })).toThrow(
      /REKODA_COMMAND_RECORD_SALE must be 1/,
    );
  });
});
