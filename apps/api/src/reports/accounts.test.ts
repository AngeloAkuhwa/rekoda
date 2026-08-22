/**
 * The wire's list of accounts against the ledger's.
 *
 * `LedgerAccount` in @rekoda/contracts mirrors `ACCOUNTS` in @rekoda/core by
 * hand, because contracts depends on zod and nothing else. A mirror held
 * together by a comment drifts the first time somebody adds an account, and
 * the failure would be silent: a journal entry into the new account refused
 * at the border with a validation error nobody can explain.
 *
 * This is the test that makes adding an account a two-file change on purpose.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, ACCOUNT_PICKER_LABELS } from '@rekoda/core';
import { LedgerAccount } from '@rekoda/contracts';

describe('the chart of accounts, on the wire', () => {
  it('lists exactly what the ledger lists', () => {
    expect([...LedgerAccount.options].sort()).toEqual(Object.keys(ACCOUNTS).sort());
  });

  /* Fifteen since ADR 0026 added equipment, its accumulated depreciation, the
   * monthly charge, and what selling one leaves the business better or worse
   * off by. Still fixed: a merchant cannot add one, which is the property ADR
   * 0004 exists to protect, and this number is what makes the next addition a
   * decision somebody writes down rather than a diff. */
  it('is still a fixed chart, and still small', () => {
    expect(LedgerAccount.options).toHaveLength(15);
  });

  /* A picker missing a label renders a blank option, which is how a merchant
   * posts a correction into an account they never meant to name. */
  it('has a merchant-readable label for every one of them', () => {
    for (const account of LedgerAccount.options) {
      expect(ACCOUNT_PICKER_LABELS[account]).toBeTruthy();
    }
    expect(Object.keys(ACCOUNT_PICKER_LABELS).sort()).toEqual(Object.keys(ACCOUNTS).sort());
  });
});
